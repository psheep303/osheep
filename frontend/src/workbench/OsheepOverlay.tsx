import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useUiPreferences } from "../i18n/UiPreferences";
import { getDismissedConfirmations, putDismissedConfirmations } from "./api";

const DISMISSED_CONFIRMATIONS_KEY = "osheep.dismissedConfirmations.v1";

export interface ConfirmOptions {
  message: string;
  title?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  reminderKey?: string;
  destructive?: boolean;
  requiredText?: string;
}

interface ConfirmRequest extends ConfirmOptions {
  id: number;
  resolve: (confirmed: boolean) => void;
}

export interface ToastOptions {
  title?: string;
  duration?: number;
}

interface ToastItem extends ToastOptions {
  id: number;
  message: string;
  type: "success" | "error" | "warning";
}

interface OsheepOverlayContextValue {
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  resetConfirmations: () => void;
  notify: {
    success: (message: string, options?: ToastOptions) => void;
    error: (message: string, options?: ToastOptions) => void;
    warning: (message: string, options?: ToastOptions) => void;
  };
}

const OsheepOverlayContext = createContext<OsheepOverlayContextValue | null>(null);

function readLegacyDismissedConfirmations(): Set<string> {
  try {
    const raw = localStorage.getItem(DISMISSED_CONFIRMATIONS_KEY);
    const values = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(
      Array.isArray(values) ? values.filter((value) => typeof value === "string") : [],
    );
  } catch {
    return new Set();
  }
}

export function OsheepOverlayProvider({ children }: { children: ReactNode }) {
  const { t } = useUiPreferences();
  const [confirmations, setConfirmations] = useState<ConfirmRequest[]>([]);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, number>());
  const dismissedConfirmations = useRef(new Set<string>());

  useEffect(() => {
    let cancelled = false;
    const legacy = readLegacyDismissedConfirmations();
    void getDismissedConfirmations()
      .then(async (stored) => {
        if (cancelled) return;
        const merged = new Set([...stored, ...legacy]);
        dismissedConfirmations.current = merged;
        if (legacy.size > 0) await putDismissedConfirmations([...merged]);
        localStorage.removeItem(DISMISSED_CONFIRMATIONS_KEY);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const dismissToast = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer !== undefined) window.clearTimeout(timer);
    timers.current.delete(id);
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const addToast = useCallback(
    (type: ToastItem["type"], message: string, options: ToastOptions = {}) => {
      const id = nextId.current++;
      const duration = options.duration ?? (type === "success" ? 4500 : 6500);
      setToasts((current) => [...current.slice(-3), { id, type, message, ...options }]);
      if (duration > 0) {
        timers.current.set(
          id,
          window.setTimeout(() => dismissToast(id), duration),
        );
      }
    },
    [dismissToast],
  );

  useEffect(
    () => () => {
      for (const timer of timers.current.values()) window.clearTimeout(timer);
      timers.current.clear();
    },
    [],
  );

  const confirm = useCallback((options: ConfirmOptions) => {
    if (options.reminderKey && dismissedConfirmations.current.has(options.reminderKey)) {
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      setConfirmations((current) => [...current, { ...options, id: nextId.current++, resolve }]);
    });
  }, []);
  const resetConfirmations = useCallback(() => {
    dismissedConfirmations.current.clear();
    void putDismissedConfirmations([]).catch(() => undefined);
  }, []);

  const finishConfirmation = useCallback(
    (request: ConfirmRequest, confirmed: boolean, remember: boolean) => {
      if (confirmed && remember && request.reminderKey) {
        dismissedConfirmations.current.add(request.reminderKey);
        void putDismissedConfirmations([...dismissedConfirmations.current]).catch(() => undefined);
      }
      request.resolve(confirmed);
      setConfirmations((current) => current.filter((item) => item.id !== request.id));
    },
    [],
  );

  const notify = useMemo<OsheepOverlayContextValue["notify"]>(
    () => ({
      success: (message, options) => addToast("success", message, options),
      error: (message, options) => addToast("error", message, options),
      warning: (message, options) => addToast("warning", message, options),
    }),
    [addToast],
  );
  const value = useMemo<OsheepOverlayContextValue>(
    () => ({ confirm, notify, resetConfirmations }),
    [confirm, notify, resetConfirmations],
  );

  const overlay = (
    <>
      {confirmations[0] && (
        <ConfirmDialog request={confirmations[0]} onFinish={finishConfirmation} />
      )}
      <div className="osheep-toasts" aria-label={t("notification.region")} aria-live="polite">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`osheep-toast osheep-toast--${toast.type}`}
            role={toast.type === "error" ? "alert" : "status"}
          >
            <span
              className={`osheep-toast__icon codicon codicon-${toast.type === "success" ? "pass-filled" : toast.type === "warning" ? "warning" : "error"}`}
              aria-hidden="true"
            />
            <div className="osheep-toast__content">
              <strong>{toast.title ?? t(`notification.${toast.type}`)}</strong>
              <p>{toast.message}</p>
            </div>
            <button
              type="button"
              className="osheep-toast__close"
              onClick={() => dismissToast(toast.id)}
              aria-label={t("common.close")}
              title={t("common.close")}
            >
              <span className="codicon codicon-close" aria-hidden="true" />
            </button>
          </div>
        ))}
      </div>
    </>
  );

  return (
    <OsheepOverlayContext.Provider value={value}>
      {children}
      {typeof document !== "undefined" && createPortal(overlay, document.body)}
    </OsheepOverlayContext.Provider>
  );
}

function ConfirmDialog({
  request,
  onFinish,
}: {
  request: ConfirmRequest;
  onFinish: (request: ConfirmRequest, confirmed: boolean, remember: boolean) => void;
}) {
  const { t } = useUiPreferences();
  const [remember, setRemember] = useState(false);
  const [confirmationText, setConfirmationText] = useState("");
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const verificationRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    (verificationRef.current ?? confirmRef.current)?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onFinish(request, false, false);
      } else if (event.key === "Tab") {
        const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
          "button:not([disabled]), input:not([disabled])",
        );
        if (!focusable || focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      previous?.focus();
    };
  }, [onFinish, request]);

  return (
    <div className="osheep-dialog-layer" onMouseDown={() => onFinish(request, false, false)}>
      <div
        ref={dialogRef}
        className="osheep-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={`osheep-dialog-title-${request.id}`}
        aria-describedby={`osheep-dialog-message-${request.id}`}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="osheep-dialog__header">
          <span className="osheep-dialog__mark codicon codicon-warning" aria-hidden="true" />
          <h2 id={`osheep-dialog-title-${request.id}`}>{request.title ?? t("confirm.title")}</h2>
          <button
            type="button"
            className="osheep-dialog__close"
            onClick={() => onFinish(request, false, false)}
            aria-label={t("common.close")}
            title={t("common.close")}
          >
            <span className="codicon codicon-close" aria-hidden="true" />
          </button>
        </div>
        <p id={`osheep-dialog-message-${request.id}`} className="osheep-dialog__message">
          {request.message}
        </p>
        {request.requiredText && (
          <label className="osheep-dialog__verification">
            <span>{t("confirm.typeToConfirm", { value: request.requiredText })}</span>
            <input
              ref={verificationRef}
              type="text"
              value={confirmationText}
              onChange={(event) => setConfirmationText(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              onKeyDown={(event) => {
                if (event.key === "Enter" && confirmationText === request.requiredText) {
                  onFinish(request, true, remember);
                }
              }}
            />
          </label>
        )}
        {request.reminderKey && (
          <label className="osheep-dialog__remember">
            <input
              type="checkbox"
              checked={remember}
              onChange={(event) => setRemember(event.target.checked)}
            />
            <span>{t("confirm.dontAskAgain")}</span>
          </label>
        )}
        <div className="osheep-dialog__actions">
          <button
            type="button"
            className="osheep-dialog__button"
            onClick={() => onFinish(request, false, false)}
          >
            {request.cancelLabel ?? t("common.cancel")}
          </button>
          <button
            ref={confirmRef}
            type="button"
            className={`osheep-dialog__button osheep-dialog__button--${request.destructive === false ? "primary" : "danger"}`}
            disabled={Boolean(request.requiredText && confirmationText !== request.requiredText)}
            onClick={() => onFinish(request, true, remember)}
          >
            {request.confirmLabel ?? t("confirm.confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}

export function useOsheepOverlay(): OsheepOverlayContextValue {
  const value = useContext(OsheepOverlayContext);
  if (!value) throw new Error("useOsheepOverlay must be used inside OsheepOverlayProvider");
  return value;
}

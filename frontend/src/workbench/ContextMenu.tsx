import { useEffect, useLayoutEffect, useRef, useState } from "react";

export interface CtxMenuItem {
  label: string;
  shortcut?: string;
  disabled?: boolean;
  danger?: boolean;
  onSelect?: () => void;
}

export interface CtxMenuSection {
  items: CtxMenuItem[];
}

interface ContextMenuProps {
  x: number;
  y: number;
  sections: CtxMenuSection[];
  onClose: () => void;
}

export function ContextMenu({ x, y, sections, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let nx = x;
    let ny = y;
    if (x + rect.width > vw) nx = Math.max(4, vw - rect.width - 4);
    if (y + rect.height > vh) ny = Math.max(4, vh - rect.height - 4);
    setPos({ x: nx, y: ny });
  }, [x, y]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="ctx-menu"
      style={{ left: pos.x, top: pos.y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {sections.map((section, si) => (
        <div key={si}>
          {si > 0 && <div className="ctx-menu__sep" />}
          {section.items.map((it, ii) => (
            <div
              key={ii}
              className={
                "ctx-menu__item" +
                (it.disabled ? " is-disabled" : "") +
                (it.danger ? " is-danger" : "")
              }
              onClick={() => {
                if (it.disabled) return;
                it.onSelect?.();
                onClose();
              }}
            >
              <span className="ctx-menu__label">{it.label}</span>
              {it.shortcut && <span className="ctx-menu__shortcut">{it.shortcut}</span>}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

import { useCallback, useEffect, useState } from "react";
import { useUiPreferences } from "../i18n/UiPreferences";
import {
  type AgentRecord,
  createAgent as apiCreateAgent,
  deleteAgent as apiDeleteAgent,
  listAgents as apiListAgents,
  updateAgent as apiUpdateAgent,
} from "./api";
import { useOsheepOverlay } from "./OsheepOverlay";
import { DEFAULT_CLI_PROVIDER } from "./settings";

interface AgentViewProps {
  workspaceId: string | null;
}

interface AgentDraft extends AgentRecord {
  originalName: string;
  dirty: boolean;
  isNew: boolean;
  saving: boolean;
  error: string | null;
}

function toDraft(a: AgentRecord): AgentDraft {
  return {
    ...a,
    originalName: a.name,
    dirty: false,
    isNew: false,
    saving: false,
    error: null,
  };
}

function newDraft(): AgentDraft {
  return {
    name: "新 Agent",
    prompt: "",
    providerId: DEFAULT_CLI_PROVIDER.id,
    model: DEFAULT_CLI_PROVIDER.models[0] ?? "default",
    originalName: "",
    dirty: true,
    isNew: true,
    saving: false,
    error: null,
  };
}

export function AgentView({ workspaceId }: AgentViewProps) {
  const { t } = useUiPreferences();
  const { confirm } = useOsheepOverlay();
  const [drafts, setDrafts] = useState<AgentDraft[]>([]);
  const [loading, setLoading] = useState(false);
  const [topError, setTopError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!workspaceId) {
      setDrafts([]);
      return;
    }
    setLoading(true);
    setTopError(null);
    try {
      const list = await apiListAgents(workspaceId);
      setDrafts(list.map(toDraft));
    } catch (e) {
      setTopError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const updateDraft = (idx: number, patch: Partial<AgentDraft>) => {
    setDrafts((prev) =>
      prev.map((d, i) => (i === idx ? { ...d, ...patch, dirty: true, error: null } : d)),
    );
  };

  const handleAdd = () => {
    setDrafts((prev) => [...prev, newDraft()]);
  };

  const handleSave = async (idx: number) => {
    if (!workspaceId) return;
    const draft = drafts[idx];
    if (!draft) return;
    if (!draft.name.trim()) {
      setDrafts((prev) => prev.map((d, i) => (i === idx ? { ...d, error: "名称不能为空" } : d)));
      return;
    }
    setDrafts((prev) => prev.map((d, i) => (i === idx ? { ...d, saving: true, error: null } : d)));
    try {
      const record: AgentRecord = {
        name: draft.name,
        prompt: draft.prompt,
        providerId: DEFAULT_CLI_PROVIDER.id,
        model: DEFAULT_CLI_PROVIDER.models[0] ?? "default",
      };
      if (draft.isNew) {
        await apiCreateAgent(workspaceId, record);
      } else {
        await apiUpdateAgent(workspaceId, draft.originalName, record);
      }
      setDrafts((prev) =>
        prev.map((d, i) =>
          i === idx
            ? {
                ...d,
                originalName: record.name,
                dirty: false,
                isNew: false,
                saving: false,
                error: null,
              }
            : d,
        ),
      );
    } catch (e) {
      setDrafts((prev) =>
        prev.map((d, i) => (i === idx ? { ...d, saving: false, error: (e as Error).message } : d)),
      );
    }
  };

  const handleDelete = async (idx: number) => {
    const draft = drafts[idx];
    if (!draft) return;
    if (draft.isNew) {
      setDrafts((prev) => prev.filter((_, i) => i !== idx));
      return;
    }
    if (!workspaceId) return;
    if (
      !(await confirm({
        message: t("confirm.deleteAgent", { name: draft.originalName }),
        confirmLabel: t("confirm.delete"),
        reminderKey: "delete-agent",
      }))
    )
      return;
    try {
      await apiDeleteAgent(workspaceId, draft.originalName);
      setDrafts((prev) => prev.filter((_, i) => i !== idx));
    } catch (e) {
      setTopError((e as Error).message);
    }
  };

  return (
    <div className="agent-view">
      <div className="agent-view__container">
        <div className="agent-view__title">Agent</div>
        <div className="agent-view__hint">
          {workspaceId
            ? "Agent 配置保存在当前项目的 .osheep/agent/[名称].json"
            : "请打开项目后再管理 Agent"}
        </div>

        {topError && (
          <div className="banner-error" style={{ marginBottom: 12 }}>
            {topError}
            <button className="banner-error__close" onClick={() => setTopError(null)} title="关闭">
              ×
            </button>
          </div>
        )}

        {loading && <div className="settings-view__empty">加载中…</div>}

        {!loading && drafts.length === 0 && (
          <div className="settings-view__empty">尚未创建任何 Agent</div>
        )}

        {drafts.map((d, idx) => (
          <AgentCard
            key={`${d.originalName || "__new__"}:${idx}`}
            draft={d}
            disabled={!workspaceId}
            onChange={(patch) => updateDraft(idx, patch)}
            onSave={() => void handleSave(idx)}
            onDelete={() => void handleDelete(idx)}
          />
        ))}

        <button
          type="button"
          className="primary-btn settings-view__add"
          disabled={!workspaceId}
          onClick={handleAdd}
        >
          + 新建 Agent
        </button>
      </div>
    </div>
  );
}

interface AgentCardProps {
  draft: AgentDraft;
  disabled: boolean;
  onChange: (patch: Partial<AgentDraft>) => void;
  onSave: () => void;
  onDelete: () => void;
}

function AgentCard({ draft, disabled, onChange, onSave, onDelete }: AgentCardProps) {
  return (
    <div className="agent-card">
      <div className="agent-card__row">
        <label className="agent-card__label">名称</label>
        <input
          className="settings-view__input"
          value={draft.name}
          disabled={disabled || draft.saving}
          onChange={(e) => onChange({ name: e.target.value })}
        />
        <button
          type="button"
          className="agent-card__remove"
          disabled={disabled || draft.saving}
          onClick={onDelete}
          title="删除 Agent"
        >
          删除
        </button>
      </div>

      <div className="agent-card__row agent-card__row--top">
        <label className="agent-card__label">提示词</label>
        <textarea
          className="agent-card__prompt"
          value={draft.prompt}
          disabled={disabled || draft.saving}
          placeholder="给该 Agent 的系统提示词"
          onChange={(e) => onChange({ prompt: e.target.value })}
        />
      </div>

      <div className="agent-card__row">
        <span className={`agent-card__save${draft.dirty ? " is-dirty" : ""}`}>
          {draft.saving
            ? "保存中..."
            : draft.error
              ? draft.error
              : draft.isNew
                ? "尚未保存"
                : draft.dirty
                  ? "有未保存的修改"
                  : "已保存"}
        </span>
        <button
          type="button"
          className="settings-view__seg is-active"
          disabled={disabled || draft.saving || !draft.dirty}
          onClick={onSave}
        >
          保存
        </button>
      </div>
    </div>
  );
}

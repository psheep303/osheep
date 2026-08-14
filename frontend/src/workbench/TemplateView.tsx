import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useUiPreferences } from "../i18n/UiPreferences";
import {
  deleteWorkflowTemplate as apiDeleteWorkflowTemplate,
  createWorkflow,
  editWorkflowTemplate,
  getWorkflowTemplate,
  listWorkflowTemplates,
  type TemplateSource,
  updateWorkflowTemplateIcon,
  type WorkflowNode,
  type WorkflowTemplate,
  type WorkflowTemplateSummary,
} from "./api";
import { ContextMenu } from "./ContextMenu";
import { useOsheepOverlay } from "./OsheepOverlay";

const MarkdownPreview = lazy(() =>
  import("./MarkdownPreview").then((module) => ({ default: module.MarkdownPreview })),
);

interface TemplateViewProps {
  activeTemplateId: string | null;
  onOpenTemplate: (source: TemplateSource, templateId: string) => void;
  onTemplateDeleted: (source: TemplateSource, templateId: string) => void;
  developerMode: boolean;
  refreshSignal: number;
}

export function TemplateView({
  activeTemplateId,
  onOpenTemplate,
  onTemplateDeleted,
  developerMode,
  refreshSignal,
}: TemplateViewProps) {
  const { t } = useUiPreferences();
  const { confirm } = useOsheepOverlay();
  const [section, setSection] = useState<TemplateSource>("system");
  const [templates, setTemplates] = useState<{
    system: WorkflowTemplateSummary[];
    user: WorkflowTemplateSummary[];
  }>({ system: [], user: [] });
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    templateId: string;
    title: string;
    source: TemplateSource;
  } | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setTemplates(await listWorkflowTemplates());
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload, refreshSignal]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const source = templates[section];
    if (!needle) return source;
    return source.filter((template) =>
      `${template.title} ${template.description}`.toLowerCase().includes(needle),
    );
  }, [query, section, templates]);

  const deleteTemplate = async (source: TemplateSource, templateId: string, title: string) => {
    if (
      !(await confirm({
        message: t("confirm.deleteTemplate", {
          source: t(source === "system" ? "template.source.system" : "template.source.user"),
          name: title,
        }),
        confirmLabel: t("confirm.delete"),
        reminderKey: "delete-workflow-template",
      }))
    )
      return;
    try {
      await apiDeleteWorkflowTemplate(source, templateId);
      onTemplateDeleted(source, templateId);
      await reload();
    } catch (cause) {
      setError((cause as Error).message);
    }
  };

  return (
    <div className="template-sidebar">
      <div className="template-sidebar__brand">
        TEMPLATES
        {developerMode && <span>DEVELOPER</span>}
      </div>
      <div className="template-sidebar__nav">
        <button
          className={section === "system" ? "is-active" : ""}
          onClick={() => setSection("system")}
        >
          System templates
          <span>{templates.system.length}</span>
        </button>
        <button
          className={section === "user" ? "is-active" : ""}
          onClick={() => setSection("user")}
        >
          User templates
          <span>{templates.user.length}</span>
        </button>
      </div>
      <div className="template-sidebar__heading">
        <span>{section === "system" ? "BUILT IN" : "CUSTOM"}</span>
        <button
          onClick={() => void reload()}
          title="Refresh templates"
          aria-label="Refresh templates"
        >
          <RefreshIcon />
        </button>
      </div>
      <label className="template-sidebar__search">
        <SearchIcon />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search templates"
        />
      </label>
      {error && <div className="template-sidebar__message is-error">{error}</div>}
      {loading && <div className="template-sidebar__message">Loading templates...</div>}
      {!loading && visible.length === 0 && (
        <div className="template-sidebar__message">
          {query
            ? "No matching templates"
            : section === "user"
              ? "No custom templates yet"
              : "No templates"}
        </div>
      )}
      <div className="template-sidebar__cards">
        {visible.map((template) => (
          <button
            key={`${template.source}:${template.id}`}
            className={`template-card${template.id === activeTemplateId ? " is-active" : ""}`}
            onClick={() => onOpenTemplate(template.source, template.id)}
            onContextMenu={(event) => {
              if (template.source === "system" && !developerMode) return;
              event.preventDefault();
              event.stopPropagation();
              setMenu({
                x: event.clientX,
                y: event.clientY,
                templateId: template.id,
                title: template.title,
                source: template.source,
              });
            }}
          >
            <TemplateAvatar template={template} />
            <span className="template-card__copy">
              <strong>{template.title}</strong>
              <small>{template.description}</small>
              <span>{template.nodeCount} blocks</span>
            </span>
          </button>
        ))}
      </div>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          sections={[
            {
              items: [
                {
                  label: menu.source === "system" ? "删除内置模板" : "删除模板",
                  danger: true,
                  onSelect: () => void deleteTemplate(menu.source, menu.templateId, menu.title),
                },
              ],
            },
          ]}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}

interface TemplateDetailProps {
  workspaceId: string | null;
  source: TemplateSource;
  templateId: string;
  onOpenWorkflow: (
    workflowId: string,
    templateBinding?: { source: TemplateSource; id: string },
  ) => void;
  onWorkflowCreated: () => void;
  developerMode: boolean;
  onTemplateChanged: () => void;
}

export function TemplateDetail({
  workspaceId,
  source,
  templateId,
  onOpenWorkflow,
  onWorkflowCreated,
  developerMode,
  onTemplateChanged,
}: TemplateDetailProps) {
  const [template, setTemplate] = useState<WorkflowTemplate | null>(null);
  const [loading, setLoading] = useState(true);
  const [using, setUsing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const templateEditable = source === "user" || developerMode;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void getWorkflowTemplate(source, templateId)
      .then((value) => {
        if (!cancelled) setTemplate(value);
      })
      .catch((cause) => {
        if (!cancelled) setError((cause as Error).message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [source, templateId]);

  const applyTemplate = async () => {
    if (!workspaceId || !template) return;
    setUsing(true);
    setError(null);
    try {
      const workflow = await createWorkflow(workspaceId, {
        title: template.title,
        readme: template.readme,
        nodes: template.nodes.map(resetNode),
        edges: template.edges.map((edge) => ({ ...edge })),
        runs: [],
      });
      onWorkflowCreated();
      onOpenWorkflow(workflow.id);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setUsing(false);
    }
  };

  const editTemplate = async () => {
    if (!workspaceId || !template || !templateEditable) return;
    setUsing(true);
    setError(null);
    try {
      const workflow = await editWorkflowTemplate(workspaceId, template.source, template.id);
      onWorkflowCreated();
      onOpenWorkflow(workflow.id, workflow.templateBinding);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setUsing(false);
    }
  };

  const uploadIcon = async (file: File | undefined) => {
    if (!file || !template || !templateEditable) return;
    if (!file.type.startsWith("image/")) {
      setError("Please choose an image file.");
      return;
    }
    if (file.size > 1_400_000) {
      setError("Template icons must be smaller than 1.4 MB.");
      return;
    }
    try {
      const icon = await readAsDataUrl(file);
      const updated = await updateWorkflowTemplateIcon(template.source, template.id, icon);
      setTemplate(updated);
      onTemplateChanged();
    } catch (cause) {
      setError((cause as Error).message);
    }
  };

  if (loading) return <div className="template-detail__state">Loading template...</div>;
  if (!template)
    return <div className="template-detail__state is-error">{error ?? "Template not found"}</div>;

  return (
    <div className="template-detail">
      <div className="template-detail__hero">
        <button
          className={`template-detail__avatar${templateEditable ? " is-editable" : ""}`}
          onClick={() => templateEditable && fileRef.current?.click()}
          title={templateEditable ? "Upload a custom icon" : template.title}
        >
          <TemplateAvatar template={template} large />
          {templateEditable && <span>Change icon</span>}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
          hidden
          onChange={(event) => {
            void uploadIcon(event.target.files?.[0]);
            event.currentTarget.value = "";
          }}
        />
        <div className="template-detail__identity">
          <span className="template-detail__eyebrow">
            {template.source === "system" ? "SYSTEM TEMPLATE" : "USER TEMPLATE"}
          </span>
          <h1>{template.title}</h1>
          <p>{template.description}</p>
          <div className="template-detail__meta">
            <span>{template.nodes.length} blocks</span>
            <span>Reusable across workspaces</span>
          </div>
          <button
            className="template-detail__use"
            disabled={!workspaceId || using}
            onClick={() => void applyTemplate()}
          >
            {using ? "Adding..." : "Use this template"}
          </button>
          {templateEditable && (
            <button
              className="template-detail__edit"
              disabled={!workspaceId || using}
              onClick={() => void editTemplate()}
            >
              Edit workflow
            </button>
          )}
          {!workspaceId && (
            <small className="template-detail__workspace-hint">
              Open a workspace to use this template.
            </small>
          )}
        </div>
      </div>
      {error && <div className="template-detail__error">{error}</div>}
      <div className="template-detail__content">
        {template.readme.trim() ? (
          <Suspense fallback={<div className="tab-loading-fallback" />}>
            <MarkdownPreview source={template.readme} />
          </Suspense>
        ) : (
          <div className="template-detail__empty">This template does not have a README yet.</div>
        )}
      </div>
    </div>
  );
}

function TemplateAvatar({
  template,
  large = false,
}: {
  template: Pick<WorkflowTemplateSummary, "title" | "icon">;
  large?: boolean;
}) {
  const initial = template.title.trim().charAt(0).toUpperCase() || "T";
  return (
    <span className={`template-avatar${large ? " is-large" : ""}`}>
      {template.icon ? <img src={template.icon} alt="" /> : <span>{initial}</span>}
    </span>
  );
}

function resetNode(node: WorkflowNode): WorkflowNode {
  const { runDetails: _runDetails, ...config } = node.config ?? {};
  return {
    ...node,
    status: "idle",
    summary: "",
    rawOutput: "",
    error: "",
    startedAt: undefined,
    completedAt: undefined,
    config,
  };
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Unable to read the icon file."));
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.readAsDataURL(file);
  });
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden>
      <circle cx="7" cy="7" r="4.5" />
      <path d="m10.5 10.5 3.5 3.5" />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden>
      <path d="M13.5 5.5A6 6 0 1 0 14 9" />
      <path d="M10.5 2.5h3v3" />
    </svg>
  );
}

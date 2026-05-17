import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  searchWorkspace,
  type SearchFileMatch,
  type SearchResult,
} from "./api";

interface SearchViewProps {
  workspaceId: string | null;
  onOpenMatch: (path: string, line: number, column: number) => void;
}

interface ModState {
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
}

const DEFAULT_MOD: ModState = {
  caseSensitive: false,
  wholeWord: false,
  regex: false,
};

export function SearchView({ workspaceId, onOpenMatch }: SearchViewProps) {
  const [query, setQuery] = useState("");
  const [mods, setMods] = useState<ModState>(DEFAULT_MOD);
  const [showFilters, setShowFilters] = useState(false);
  const [include, setInclude] = useState("");
  const [exclude, setExclude] = useState("");
  const [result, setResult] = useState<SearchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(new Set());
  const [hiddenFiles, setHiddenFiles] = useState<Set<string>>(new Set());
  const [hiddenLines, setHiddenLines] = useState<Set<string>>(new Set());

  const queryInputRef = useRef<HTMLInputElement | null>(null);
  const seqRef = useRef(0);
  const debounceRef = useRef<number | null>(null);

  // Auto-focus on mount.
  useEffect(() => {
    queryInputRef.current?.focus();
  }, []);

  const runSearch = useCallback(
    async (immediate = false) => {
      if (!workspaceId) return;
      if (debounceRef.current !== null) {
        window.clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
      const go = async () => {
        if (!query) {
          setResult(null);
          setError(null);
          setLoading(false);
          return;
        }
        const seq = ++seqRef.current;
        setLoading(true);
        setError(null);
        try {
          const r = await searchWorkspace(workspaceId, query, {
            caseSensitive: mods.caseSensitive,
            wholeWord: mods.wholeWord,
            regex: mods.regex,
            include: include || undefined,
            exclude: exclude || undefined,
          });
          if (seq !== seqRef.current) return;
          setResult(r);
          setHiddenFiles(new Set());
          setHiddenLines(new Set());
          setCollapsedFiles(new Set());
        } catch (e) {
          if (seq !== seqRef.current) return;
          setError((e as Error).message);
          setResult(null);
        } finally {
          if (seq === seqRef.current) setLoading(false);
        }
      };
      if (immediate) {
        await go();
      } else {
        debounceRef.current = window.setTimeout(() => {
          void go();
        }, 300);
      }
    },
    [workspaceId, query, mods, include, exclude]
  );

  useEffect(() => {
    void runSearch(false);
    return () => {
      if (debounceRef.current !== null) {
        window.clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
    };
  }, [runSearch]);

  // Re-focus and run on Enter
  const onQueryKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void runSearch(true);
    }
  };

  const toggleMod = (k: keyof ModState) =>
    setMods((m) => ({ ...m, [k]: !m[k] }));

  const visibleMatches = useMemo<SearchFileMatch[]>(() => {
    if (!result) return [];
    return result.matches
      .filter((m) => !hiddenFiles.has(m.path))
      .map((m) => ({
        ...m,
        lines: m.lines.filter((ln) => !hiddenLines.has(lineKey(m.path, ln.line, ln.column))),
      }))
      .filter((m) => m.lines.length > 0);
  }, [result, hiddenFiles, hiddenLines]);

  const totalMatches = visibleMatches.reduce(
    (sum, f) => sum + f.lines.length,
    0
  );

  return (
    <div className="side-view search-view">
      <div className="side-view__header">
        <span className="side-view__title">搜索</span>
      </div>

      <div className="search-view__form">
        <div className="search-view__input-row">
          <button
            className={"search-view__toggle" + (showFilters ? " is-active" : "")}
            onClick={() => setShowFilters((v) => !v)}
            title={showFilters ? "收起 替换 / 过滤" : "展开 替换 / 过滤"}
            aria-label="展开过滤"
          >
            <ChevronIcon open={showFilters} />
          </button>
          <div className="search-view__input-wrap">
            <input
              ref={queryInputRef}
              className="search-view__input"
              type="text"
              placeholder="搜索"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onQueryKey}
              spellCheck={false}
            />
            <div className="search-view__mods">
              <ModButton
                label="Aa"
                title="区分大小写"
                active={mods.caseSensitive}
                onClick={() => toggleMod("caseSensitive")}
              />
              <ModButton
                label="ab"
                title="全词匹配"
                active={mods.wholeWord}
                onClick={() => toggleMod("wholeWord")}
                underline
              />
              <ModButton
                label=".*"
                title="正则"
                active={mods.regex}
                onClick={() => toggleMod("regex")}
              />
            </div>
          </div>
        </div>

        {showFilters && (
          <div className="search-view__filters">
            <input
              className="search-view__input search-view__input--filter"
              type="text"
              placeholder="包含 (例: src/**/*.ts, *.md)"
              value={include}
              onChange={(e) => setInclude(e.target.value)}
              spellCheck={false}
            />
            <input
              className="search-view__input search-view__input--filter"
              type="text"
              placeholder="排除"
              value={exclude}
              onChange={(e) => setExclude(e.target.value)}
              spellCheck={false}
            />
          </div>
        )}
      </div>

      <div className="search-view__status">
        {!workspaceId ? (
          <span className="muted">请先选择工作区</span>
        ) : loading ? (
          <span className="muted">搜索中…</span>
        ) : !query ? (
          <span className="muted">输入关键词以搜索</span>
        ) : error ? (
          <span className="search-view__error">{error}</span>
        ) : result ? (
          <span className="muted">
            {totalMatches === 0
              ? "没有结果"
              : `${totalMatches} 个结果 · ${visibleMatches.length} 个文件`}
            {result.truncated && <span className="search-view__warn"> · 结果已截断</span>}
          </span>
        ) : null}
      </div>

      <div className="search-view__results">
        {visibleMatches.map((file) => {
          const collapsed = collapsedFiles.has(file.path);
          return (
            <div key={file.path} className="search-view__file">
              <div
                className="search-view__file-row"
                onClick={() =>
                  setCollapsedFiles((prev) => {
                    const next = new Set(prev);
                    if (next.has(file.path)) next.delete(file.path);
                    else next.add(file.path);
                    return next;
                  })
                }
                title={file.path}
              >
                <span className="search-view__chevron">
                  <ChevronIcon open={!collapsed} />
                </span>
                <span className="search-view__file-name">
                  {basename(file.path)}
                </span>
                <span className="search-view__file-path">{dirname(file.path)}</span>
                <span className="search-view__file-count">{file.lines.length}</span>
                <button
                  className="search-view__dismiss"
                  title="从结果中移除"
                  onClick={(e) => {
                    e.stopPropagation();
                    setHiddenFiles((prev) => new Set(prev).add(file.path));
                  }}
                >
                  ×
                </button>
              </div>
              {!collapsed && (
                <div className="search-view__lines">
                  {file.lines.map((ln) => {
                    const key = lineKey(file.path, ln.line, ln.column);
                    return (
                      <div
                        key={key}
                        className="search-view__line"
                        onClick={() =>
                          onOpenMatch(file.path, ln.line, ln.column)
                        }
                        title={`${file.path}:${ln.line}:${ln.column}`}
                      >
                        <span className="search-view__line-num">{ln.line}</span>
                        <span className="search-view__line-text">
                          <HighlightedPreview
                            text={ln.preview}
                            start={ln.matchStart}
                            end={ln.matchEnd}
                          />
                        </span>
                        <button
                          className="search-view__dismiss"
                          title="移除该命中"
                          onClick={(e) => {
                            e.stopPropagation();
                            setHiddenLines((prev) => new Set(prev).add(key));
                          }}
                        >
                          ×
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function HighlightedPreview({
  text,
  start,
  end,
}: {
  text: string;
  start: number;
  end: number;
}) {
  if (start < 0 || end <= start || end > text.length) {
    return <>{text}</>;
  }
  return (
    <>
      {text.slice(0, start)}
      <mark className="search-view__hl">{text.slice(start, end)}</mark>
      {text.slice(end)}
    </>
  );
}

function ModButton({
  label,
  title,
  active,
  underline,
  onClick,
}: {
  label: string;
  title: string;
  active: boolean;
  underline?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className={"search-view__mod" + (active ? " is-active" : "")}
      title={title}
      onClick={onClick}
      aria-pressed={active}
    >
      {underline ? <u>{label}</u> : label}
    </button>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="12"
      height="12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{
        transform: open ? "rotate(90deg)" : "rotate(0deg)",
        transition: "transform 0.12s",
      }}
    >
      <path d="M5 3 11 8 5 13" />
    </svg>
  );
}

function basename(p: string): string {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(i + 1) : p;
}

function dirname(p: string): string {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(0, i) : "";
}

function lineKey(path: string, line: number, col: number): string {
  return `${path}:${line}:${col}`;
}

import { type CSSProperties, useEffect, useMemo, useState } from "react";
import { useUiPreferences } from "../i18n/UiPreferences";
import {
  type AllProjectsWorkflowUsage,
  getAllProjectsWorkflowUsage,
  getWorkflowUsageStatistics,
  type WorkflowUsageStatistics as UsageStatistics,
  type WorkflowUsageRange,
} from "./api";

export function WorkflowUsageStatistics({ workspaceId }: { workspaceId: string | null }) {
  const { resolvedLanguage, t } = useUiPreferences();
  const [range, setRange] = useState<WorkflowUsageRange>("30d");
  const [allProjectsData, setAllProjectsData] = useState<AllProjectsWorkflowUsage | null>(null);
  const [projectData, setProjectData] = useState<UsageStatistics | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [refreshVersion, setRefreshVersion] = useState(0);
  const locale = resolvedLanguage === "zh-CN" ? "zh-CN" : "en-US";

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    setAllProjectsData(null);
    setProjectData(null);
    void (async () => {
      const [allProjectsResult, projectResult] = await Promise.allSettled([
        getAllProjectsWorkflowUsage(range),
        workspaceId ? getWorkflowUsageStatistics(workspaceId, range) : Promise.resolve(null),
      ]);
      if (cancelled) return;
      const errors: string[] = [];
      if (allProjectsResult.status === "fulfilled") {
        setAllProjectsData(allProjectsResult.value);
      } else {
        errors.push(
          allProjectsResult.reason instanceof Error
            ? allProjectsResult.reason.message
            : String(allProjectsResult.reason),
        );
      }
      if (projectResult.status === "fulfilled") {
        setProjectData(projectResult.value);
      } else {
        errors.push(
          projectResult.reason instanceof Error
            ? projectResult.reason.message
            : String(projectResult.reason),
        );
      }
      setError(errors.join("; "));
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [range, refreshVersion, workspaceId]);

  const number = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const currency = useMemo(
    () =>
      new Intl.NumberFormat(locale, {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: 2,
        maximumFractionDigits: 6,
      }),
    [locale],
  );

  const projectMetrics = projectData
    ? [
        [
          "tokens",
          t("settings.usage.totalTokens"),
          formatTokenAmount(projectData.totals.totalTokens),
        ],
        ["cost", t("settings.usage.totalCost"), currency.format(projectData.totals.cost)],
        ["runs", t("settings.usage.runs"), number.format(projectData.totals.runs)],
        [
          "input",
          t("settings.usage.inputTokens"),
          formatTokenAmount(projectData.totals.inputTokens),
        ],
        [
          "output",
          t("settings.usage.outputTokens"),
          formatTokenAmount(projectData.totals.outputTokens),
        ],
        [
          "cache-read",
          t("settings.usage.cacheRead"),
          formatTokenAmount(projectData.totals.cacheReadTokens),
        ],
        [
          "cache-write",
          t("settings.usage.cacheWrite"),
          formatTokenAmount(projectData.totals.cacheWriteTokens),
        ],
      ]
    : [];

  return (
    <div className="usage-stats">
      <div className="usage-stats__toolbar">
        <p>{t("settings.usage.description")}</p>
        <div className="usage-stats__actions">
          <div className="usage-stats__range" aria-label={t("settings.usage.range")}>
            {(["7d", "30d", "all"] as const).map((value) => (
              <button
                key={value}
                type="button"
                className={range === value ? "is-active" : ""}
                aria-pressed={range === value}
                onClick={() => setRange(value)}
              >
                {t(`settings.usage.range.${value}`)}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="settings-view__icon-button usage-stats__refresh"
            title={t("common.refresh")}
            aria-label={t("common.refresh")}
            disabled={loading}
            onClick={() => setRefreshVersion((current) => current + 1)}
          >
            <span className={`codicon codicon-refresh${loading ? " is-spinning" : ""}`} />
          </button>
        </div>
      </div>

      {error && (
        <div className="settings-view__error">
          {t("settings.usage.loadFailed", { detail: error })}
        </div>
      )}
      {!allProjectsData && loading && (
        <div className="usage-stats__state">{t("common.loading")}</div>
      )}
      {allProjectsData && (
        <section className="usage-stats__section usage-stats__all-projects">
          <h2>{t("settings.usage.allProjects")}</h2>
          <div className="usage-stats__metrics usage-stats__metrics--global">
            <article className="usage-stats__metric is-tokens">
              <span>{t("settings.usage.totalTokens")}</span>
              <strong title={formatTokenAmount(allProjectsData.totals.totalTokens)}>
                {formatTokenAmount(allProjectsData.totals.totalTokens)}
              </strong>
            </article>
            <article className="usage-stats__metric is-cost">
              <span>{t("settings.usage.totalCost")}</span>
              <strong title={currency.format(allProjectsData.totals.cost)}>
                {currency.format(allProjectsData.totals.cost)}
              </strong>
            </article>
          </div>
        </section>
      )}
      {workspaceId && projectData && (
        <>
          <section className="usage-stats__section">
            <h2>{t("settings.usage.currentProject")}</h2>
            <section className="usage-stats__metrics" aria-label={t("settings.usage.summary")}>
              {projectMetrics.map(([kind, label, value]) => (
                <article key={kind} className={`usage-stats__metric is-${kind}`}>
                  <span>{label}</span>
                  <strong title={value}>{value}</strong>
                </article>
              ))}
            </section>
          </section>

          {projectData.totals.runs === 0 ? (
            <div className="usage-stats__state">{t("settings.usage.empty")}</div>
          ) : (
            <>
              <UsageTrend data={projectData} currency={currency} />
              <div className="usage-stats__rankings">
                <UsageRanking
                  title={t("settings.usage.workflows")}
                  nameLabel={t("settings.usage.workflow")}
                  rows={projectData.workflows.map((item) => ({ name: item.title, ...item }))}
                  number={number}
                  currency={currency}
                />
                <UsageRanking
                  title={t("settings.usage.models")}
                  nameLabel={t("settings.usage.model")}
                  rows={projectData.models.map((item) => ({ name: item.model, ...item }))}
                  number={number}
                  currency={currency}
                />
              </div>
              <RecentRuns data={projectData} locale={locale} currency={currency} />
            </>
          )}
        </>
      )}
    </div>
  );
}

function UsageTrend({ data, currency }: { data: UsageStatistics; currency: Intl.NumberFormat }) {
  const { t } = useUiPreferences();
  const days = data.daily.slice(-30);
  const maxTokens = Math.max(...days.map((day) => day.tokens), 1);

  return (
    <section className="usage-stats__section">
      <h2>{t("settings.usage.trend")}</h2>
      <div className="usage-stats__trend" role="img" aria-label={t("settings.usage.trend")}>
        {days.map((day) => {
          const height = Math.max(3, (day.tokens / maxTokens) * 100);
          const label = `${day.date}: ${formatTokenAmount(day.tokens)} Token, ${currency.format(day.cost)}`;
          return (
            <div key={day.date} className="usage-stats__trend-day" title={label}>
              <div className="usage-stats__trend-value">{formatTokenAmount(day.tokens)}</div>
              <div className="usage-stats__trend-track">
                <span style={{ height: `${height}%` } as CSSProperties} />
              </div>
              <time dateTime={day.date}>{day.date.slice(5)}</time>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function UsageRanking({
  title,
  nameLabel,
  rows,
  number,
  currency,
}: {
  title: string;
  nameLabel: string;
  rows: Array<{ name: string; runs: number; tokens: number; cost: number }>;
  number: Intl.NumberFormat;
  currency: Intl.NumberFormat;
}) {
  const { t } = useUiPreferences();
  return (
    <section className="usage-stats__section">
      <h2>{title}</h2>
      <div className="usage-stats__table-wrap">
        <table className="usage-stats__table">
          <thead>
            <tr>
              <th>{nameLabel}</th>
              <th>{t("settings.usage.runs")}</th>
              <th>Token</th>
              <th>{t("settings.usage.cost")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 8).map((row) => (
              <tr key={row.name}>
                <td title={row.name}>{row.name}</td>
                <td>{number.format(row.runs)}</td>
                <td>{formatTokenAmount(row.tokens)}</td>
                <td>{currency.format(row.cost)}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={4}>{t("settings.usage.noBreakdown")}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function RecentRuns({
  data,
  locale,
  currency,
}: {
  data: UsageStatistics;
  locale: string;
  currency: Intl.NumberFormat;
}) {
  const { t } = useUiPreferences();
  return (
    <section className="usage-stats__section">
      <h2>{t("settings.usage.recentRuns")}</h2>
      <div className="usage-stats__table-wrap">
        <table className="usage-stats__table usage-stats__table--runs">
          <thead>
            <tr>
              <th>{t("settings.usage.workflow")}</th>
              <th>{t("settings.usage.startedAt")}</th>
              <th>{t("settings.usage.status")}</th>
              <th>Token</th>
              <th>{t("settings.usage.cost")}</th>
            </tr>
          </thead>
          <tbody>
            {data.recentRuns.slice(0, 12).map((run) => (
              <tr key={`${run.workflowId}:${run.runId}`}>
                <td title={run.workflowTitle}>{run.workflowTitle}</td>
                <td>{new Date(run.startedAt).toLocaleString(locale)}</td>
                <td>
                  <span className={`usage-stats__status is-${run.status}`}>
                    {t(`workflow.status.${run.status}`)}
                  </span>
                </td>
                <td>{formatTokenAmount(run.tokens)}</td>
                <td>{currency.format(run.cost)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function formatTokenAmount(value: number): string {
  const amount = Number.isFinite(value) && value > 0 ? value : 0;
  const unit =
    amount >= 1_000_000_000
      ? { divisor: 1_000_000_000, suffix: "B" }
      : amount >= 1_000_000
        ? { divisor: 1_000_000, suffix: "M" }
        : amount >= 1_000
          ? { divisor: 1_000, suffix: "K" }
          : null;
  if (!unit) return String(Math.round(amount));

  const scaled = amount / unit.divisor;
  const fractionDigits = scaled < 10 ? 2 : scaled < 100 ? 1 : 0;
  return `${Number(scaled.toFixed(fractionDigits))}${unit.suffix}`;
}

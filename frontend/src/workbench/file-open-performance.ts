import type { HttpResponseMetadata } from "./api";

export type FileOpenCacheStatus = "hit" | "miss" | "bypass" | "revalidated" | "unknown";
export type FileOpenIoDiagnostic =
  | "normal"
  | "slow-local"
  | "slow-sync"
  | "slow-network"
  | "unknown";

export interface FileOpenTrace {
  id: string;
  clickedAt: number;
  requestStartedAt?: number;
  responseReceivedAt?: number;
  serverRequestToReadCompleteMs?: number;
  fileSizeBytes?: number;
  cacheStatus: FileOpenCacheStatus;
  ioDiagnostic?: FileOpenIoDiagnostic;
}

export interface FileOpenMetric {
  event: "file_open_interactive";
  traceId: string;
  fileSizeBytes: number;
  cacheStatus: FileOpenCacheStatus;
  ioDiagnostic: FileOpenIoDiagnostic;
  clickToRequestMs: number;
  serverRequestToReadCompleteMs: number;
  readCompleteToBrowserMs: number;
  browserReceiveToInteractiveMs: number;
  totalMs: number;
}

declare global {
  interface Window {
    __OSHEEP_FILE_OPEN_METRICS__?: FileOpenMetric[];
  }
}

const reportedTraceIds = new Set<string>();

function roundMs(value: number): number {
  return Number(Math.max(0, value).toFixed(2));
}

function createTraceId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function serverReadDuration(headers: Headers): number | undefined {
  const value = headers.get("server-timing") ?? "";
  const match = value.match(/(?:^|,)\s*osheep-file-read;dur=([0-9.]+)/i);
  if (!match) return undefined;
  const duration = Number(match[1]);
  return Number.isFinite(duration) ? duration : undefined;
}

function cacheStatus(metadata: HttpResponseMetadata): FileOpenCacheStatus {
  if (metadata.revalidated) return "revalidated";
  const value = metadata.headers.get("x-osheep-file-cache");
  return value === "hit" || value === "miss" || value === "bypass" ? value : "unknown";
}

function ioDiagnostic(metadata: HttpResponseMetadata): FileOpenIoDiagnostic {
  const value = metadata.headers.get("x-osheep-file-io-diagnostic");
  return value === "normal" ||
    value === "slow-local" ||
    value === "slow-sync" ||
    value === "slow-network"
    ? value
    : "unknown";
}

export function startFileOpenTrace(clickedAt = performance.now()): FileOpenTrace {
  return { id: createTraceId(), clickedAt, cacheStatus: "unknown" };
}

export function attachFileResponse(
  trace: FileOpenTrace,
  metadata: HttpResponseMetadata,
  fileSizeBytes: number,
): FileOpenTrace {
  return {
    ...trace,
    requestStartedAt: metadata.requestStartedAt,
    responseReceivedAt: metadata.bodyReceivedAt,
    serverRequestToReadCompleteMs: serverReadDuration(metadata.headers),
    fileSizeBytes,
    cacheStatus: cacheStatus(metadata),
    ioDiagnostic: ioDiagnostic(metadata),
  };
}

export function completeFileOpenTrace(
  trace: FileOpenTrace,
  interactiveAt = performance.now(),
): FileOpenMetric | null {
  if (
    reportedTraceIds.has(trace.id) ||
    trace.requestStartedAt === undefined ||
    trace.responseReceivedAt === undefined ||
    trace.serverRequestToReadCompleteMs === undefined ||
    trace.fileSizeBytes === undefined
  ) {
    return null;
  }
  reportedTraceIds.add(trace.id);
  const requestToBrowserMs = trace.responseReceivedAt - trace.requestStartedAt;
  const metric: FileOpenMetric = {
    event: "file_open_interactive",
    traceId: trace.id,
    fileSizeBytes: trace.fileSizeBytes,
    cacheStatus: trace.cacheStatus,
    ioDiagnostic: trace.ioDiagnostic ?? "unknown",
    clickToRequestMs: roundMs(trace.requestStartedAt - trace.clickedAt),
    serverRequestToReadCompleteMs: roundMs(trace.serverRequestToReadCompleteMs),
    readCompleteToBrowserMs: roundMs(requestToBrowserMs - trace.serverRequestToReadCompleteMs),
    browserReceiveToInteractiveMs: roundMs(interactiveAt - trace.responseReceivedAt),
    totalMs: roundMs(interactiveAt - trace.clickedAt),
  };
  if (typeof window !== "undefined") {
    const metrics = window.__OSHEEP_FILE_OPEN_METRICS__ ?? [];
    metrics.push(metric);
    if (metrics.length > 500) metrics.splice(0, metrics.length - 500);
    window.__OSHEEP_FILE_OPEN_METRICS__ = metrics;
  }
  console.info("[osheep:file-open]", metric);
  return metric;
}

import { errors } from "./errors.js";

export interface RemoteMcpTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
  [key: string]: unknown;
}

export interface RemoteMcpRequestOptions {
  remoteLink: string;
  postUrl?: string;
  headers?: Record<string, string>;
  apiKey?: string;
  timeoutMs?: number;
}

export interface RemoteMcpDiscovery {
  remoteLink: string;
  postUrl: string;
  tools: RemoteMcpTool[];
  raw: unknown;
  connectedAt: number;
}

export interface RemoteMcpCallResult {
  remoteLink: string;
  postUrl: string;
  ok: boolean;
  result?: unknown;
  error?: unknown;
  response: unknown;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string;
  method: string;
  params?: unknown;
}

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: string | number | null;
  result?: unknown;
  error?: unknown;
  [key: string]: unknown;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MCP_PROTOCOL_VERSION = "2025-03-26";
const DEFAULT_PROTOCOL_HEADERS: Record<string, string> = {
  "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
};
const FORBIDDEN_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "transfer-encoding",
  "upgrade",
]);

export async function discoverRemoteMcp(
  options: RemoteMcpRequestOptions,
): Promise<RemoteMcpDiscovery> {
  return await withRemoteMcpSession(options, async (session) => {
    const response = await session.request({
      jsonrpc: "2.0",
      id: "init-1",
      method: "tools/list",
    });
    if (response.error !== undefined) {
      throw errors.upstreamFailed(`MCP tools/list failed: ${jsonString(response.error)}`);
    }
    return {
      remoteLink: session.remoteLink,
      postUrl: session.postUrl,
      tools: normalizeTools(response.result),
      raw: response.result,
      connectedAt: Date.now(),
    };
  });
}

export async function callRemoteMcp(
  options: RemoteMcpRequestOptions & {
    name: string;
    arguments?: Record<string, unknown>;
  },
): Promise<RemoteMcpCallResult> {
  return await withRemoteMcpSession(options, async (session) => {
    const response = await session.request({
      jsonrpc: "2.0",
      id: `run-${Date.now().toString(36)}`,
      method: "tools/call",
      params: {
        name: options.name,
        arguments: options.arguments ?? {},
      },
    });
    return {
      remoteLink: session.remoteLink,
      postUrl: session.postUrl,
      ok: response.error === undefined,
      result: response.result,
      error: response.error,
      response,
    };
  });
}

interface RemoteMcpSession {
  readonly remoteLink: string;
  readonly postUrl: string;
  connect(): Promise<void>;
  request(payload: JsonRpcRequest): Promise<JsonRpcResponse>;
  notify(payload: JsonRpcNotification): Promise<void>;
  close(): void;
}

class McpTransportError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

async function withRemoteMcpSession<T>(
  options: RemoteMcpRequestOptions,
  fn: (session: RemoteMcpSession) => Promise<T>,
): Promise<T> {
  const sse = new RemoteMcpSseSession(options);
  try {
    await sse.connect();
    await initializeRemoteMcpSession(sse);
    return await fn(sse);
  } catch (e) {
    sse.close();
    if (!shouldFallbackToStreamableHttp(e)) {
      throw toUpstreamError(e);
    }
  }

  const http = new RemoteMcpHttpSession(options);
  try {
    await http.connect();
    await initializeRemoteMcpSession(http);
    return await fn(http);
  } catch (e) {
    throw toUpstreamError(e);
  } finally {
    http.close();
  }
}

async function initializeRemoteMcpSession(session: RemoteMcpSession): Promise<void> {
  const response = await session.request({
    jsonrpc: "2.0",
    id: `initialize-${Date.now().toString(36)}`,
    method: "initialize",
    params: {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: {
        name: "osheep",
        version: "0.2.1",
      },
    },
  });
  if (response.error !== undefined) {
    throw new McpTransportError(`MCP initialize failed: ${jsonString(response.error)}`);
  }
  await session.notify({
    jsonrpc: "2.0",
    method: "notifications/initialized",
  });
}

function shouldFallbackToStreamableHttp(e: unknown): boolean {
  return e instanceof McpTransportError && e.status === 405;
}

function toUpstreamError(e: unknown): Error {
  if (e instanceof McpTransportError) return errors.upstreamFailed(e.message);
  if (e instanceof Error) return errors.upstreamFailed(e.message);
  return errors.upstreamFailed(String(e));
}

class RemoteMcpSseSession implements RemoteMcpSession {
  readonly remoteLink: string;
  private readonly headers: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly abort = new AbortController();
  private readonly endpoint = deferred<string>();
  private readonly pending = new Map<
    string,
    {
      resolve: (value: JsonRpcResponse) => void;
      reject: (reason: unknown) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private buffered = new Map<string, JsonRpcResponse>();
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private closed = false;
  private resolvedPostUrl = "";

  constructor(options: RemoteMcpRequestOptions) {
    this.remoteLink = normalizeRemoteLink(options.remoteLink);
    this.headers = {
      ...DEFAULT_PROTOCOL_HEADERS,
      ...buildAuthHeaders(options.headers, options.apiKey),
    };
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (options.postUrl) {
      this.resolvedPostUrl = resolveEndpointUrl(this.remoteLink, options.postUrl);
    }
  }

  get postUrl(): string {
    return this.resolvedPostUrl;
  }

  async connect(): Promise<void> {
    const response = await fetch(this.remoteLink, {
      method: "GET",
      headers: withDefaults(this.headers, {
        accept: "text/event-stream",
        "cache-control": "no-cache",
      }),
      signal: this.abort.signal,
    });
    if (!response.ok) {
      throw new McpTransportError(
        `MCP SSE connect failed (${response.status}): ${await response.text().catch(() => "")}`,
        response.status,
      );
    }
    if (!response.body) throw errors.upstreamFailed("MCP SSE response has no body");
    void this.pump(response.body);
    this.resolvedPostUrl = await withTimeout(
      this.endpoint.promise,
      this.timeoutMs,
      "Timed out waiting for MCP endpoint event",
    );
  }

  async request(payload: JsonRpcRequest): Promise<JsonRpcResponse> {
    const id = String(payload.id);
    const buffered = this.buffered.get(id);
    if (buffered) {
      this.buffered.delete(id);
      return buffered;
    }

    const wait = this.waitForResponse(id);
    const response = await fetch(this.resolvedPostUrl, {
      method: "POST",
      headers: withDefaults(this.headers, {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      }),
      body: JSON.stringify(payload),
      signal: this.abort.signal,
    });
    if (!response.ok) {
      this.rejectPending(id, `MCP POST failed (${response.status})`);
      throw errors.upstreamFailed(
        `MCP POST failed (${response.status}): ${await response.text().catch(() => "")}`,
      );
    }
    const text = await response.text().catch(() => "");
    if (text.trim()) this.handlePostBody(text);
    return await wait;
  }

  async notify(payload: JsonRpcNotification): Promise<void> {
    const response = await fetch(this.resolvedPostUrl, {
      method: "POST",
      headers: withDefaults(this.headers, {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      }),
      body: JSON.stringify(payload),
      signal: this.abort.signal,
    });
    if (!response.ok) {
      throw new McpTransportError(
        `MCP notification failed (${response.status}): ${await response.text().catch(() => "")}`,
        response.status,
      );
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.abort.abort();
    void this.reader?.cancel().catch(() => undefined);
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`MCP request ${id} was closed`));
    }
    this.pending.clear();
  }

  private waitForResponse(id: string): Promise<JsonRpcResponse> {
    const buffered = this.buffered.get(id);
    if (buffered) {
      this.buffered.delete(id);
      return Promise.resolve(buffered);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for MCP response ${id}`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  private rejectPending(id: string, message: string): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    pending.reject(new Error(message));
  }

  private async pump(body: ReadableStream<Uint8Array>): Promise<void> {
    this.reader = body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let event = "";
    let dataLines: string[] = [];

    const flush = () => {
      if (!event && dataLines.length === 0) return;
      const data = dataLines.join("\n");
      const name = event || "message";
      event = "";
      dataLines = [];
      this.handleSseEvent(name, data);
    };

    try {
      while (!this.closed) {
        const read = await this.reader.read();
        if (read.done) break;
        buffer += decoder.decode(read.value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) !== -1) {
          const raw = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          const line = raw.replace(/\r$/, "");
          if (line === "") {
            flush();
          } else if (line.startsWith(":")) {
          } else if (line.startsWith("event:")) {
            event = line.slice(6).trim();
          } else if (line.startsWith("data:")) {
            dataLines.push(line.slice(5).trimStart());
          }
        }
      }
      flush();
    } catch (e) {
      if (!this.closed && !this.abort.signal.aborted) this.endpoint.reject(e);
    } finally {
      if (!this.closed) {
        for (const [id, pending] of this.pending) {
          clearTimeout(pending.timer);
          pending.reject(new Error(`MCP SSE closed before response ${id}`));
        }
        this.pending.clear();
      }
    }
  }

  private handleSseEvent(event: string, data: string): void {
    if (event === "endpoint") {
      const endpoint = endpointFromData(data);
      if (!endpoint) {
        this.endpoint.reject(new Error("MCP endpoint event did not include a URL"));
        return;
      }
      const url = resolveEndpointUrl(this.remoteLink, endpoint);
      this.resolvedPostUrl = url;
      this.endpoint.resolve(this.resolvedPostUrl);
      return;
    }

    const parsed = parseJson(data);
    if (parsed === null) return;
    this.handleRpcPayload(parsed);
  }

  private handlePostBody(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (trimmed.startsWith("event:") || trimmed.startsWith("data:")) {
      for (const payload of parseSseTextPayloads(trimmed)) this.handleRpcPayload(payload);
      return;
    }
    const parsed = parseJson(trimmed);
    if (parsed !== null) this.handleRpcPayload(parsed);
  }

  private handleRpcPayload(payload: unknown): void {
    if (Array.isArray(payload)) {
      for (const item of payload) this.handleRpcPayload(item);
      return;
    }
    const msg = objectValue(payload);
    if (!msg || msg.id === undefined || msg.id === null) return;
    const id = String(msg.id);
    const response = msg as JsonRpcResponse;
    const pending = this.pending.get(id);
    if (!pending) {
      this.buffered.set(id, response);
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(id);
    pending.resolve(response);
  }
}

class RemoteMcpHttpSession implements RemoteMcpSession {
  readonly remoteLink: string;
  private readonly headers: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly abort = new AbortController();
  private sessionId = "";

  constructor(options: RemoteMcpRequestOptions) {
    this.remoteLink = normalizeRemoteLink(options.remoteLink);
    this.headers = {
      ...DEFAULT_PROTOCOL_HEADERS,
      ...buildAuthHeaders(options.headers, options.apiKey),
    };
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  get postUrl(): string {
    return this.remoteLink;
  }

  async connect(): Promise<void> {
    return;
  }

  async request(payload: JsonRpcRequest): Promise<JsonRpcResponse> {
    const response = await fetch(this.remoteLink, {
      method: "POST",
      headers: this.requestHeaders(),
      body: JSON.stringify(payload),
      signal: this.abort.signal,
    });
    if (!response.ok) {
      throw new McpTransportError(
        `MCP Streamable HTTP request failed (${response.status}): ${await response.text().catch(() => "")}`,
        response.status,
      );
    }
    this.captureSessionId(response);
    const parsed = await parseRpcResponseBody(response, this.timeoutMs);
    const id = String(payload.id);
    const match = findRpcResponse(parsed, id);
    if (!match) {
      throw new McpTransportError(`MCP Streamable HTTP response did not include id ${id}`);
    }
    return match;
  }

  async notify(payload: JsonRpcNotification): Promise<void> {
    const response = await fetch(this.remoteLink, {
      method: "POST",
      headers: this.requestHeaders(),
      body: JSON.stringify(payload),
      signal: this.abort.signal,
    });
    if (!response.ok) {
      throw new McpTransportError(
        `MCP Streamable HTTP notification failed (${response.status}): ${await response.text().catch(() => "")}`,
        response.status,
      );
    }
    this.captureSessionId(response);
  }

  close(): void {
    this.abort.abort();
  }

  private requestHeaders(): Record<string, string> {
    const headers = withDefaults(this.headers, {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    });
    if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;
    return headers;
  }

  private captureSessionId(response: Response): void {
    const id = response.headers.get("mcp-session-id");
    if (id?.trim()) this.sessionId = id.trim();
  }
}

function normalizeRemoteLink(value: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw errors.invalidQuery("Remote MCP Link is required");
  }
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw errors.invalidQuery("Remote MCP Link must be a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw errors.invalidQuery("Remote MCP Link must use http or https");
  }
  return url.toString();
}

function buildAuthHeaders(
  headers: Record<string, string> | undefined,
  apiKey: string | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(headers ?? {})) {
    const key = rawKey.trim();
    if (!key || FORBIDDEN_HEADERS.has(key.toLowerCase())) continue;
    out[key] = rawValue;
  }
  const hasAuthorization = Object.keys(out).some((key) => key.toLowerCase() === "authorization");
  const token = typeof apiKey === "string" ? apiKey.trim() : "";
  if (token && !hasAuthorization) {
    out.Authorization = token.toLowerCase().startsWith("bearer ") ? token : `Bearer ${token}`;
  }
  return out;
}

function withDefaults(
  headers: Record<string, string>,
  defaults: Record<string, string>,
): Record<string, string> {
  const out = { ...headers };
  const present = new Set(Object.keys(out).map((key) => key.toLowerCase()));
  for (const [key, value] of Object.entries(defaults)) {
    if (!present.has(key.toLowerCase())) out[key] = value;
  }
  return out;
}

function endpointFromData(data: string): string {
  const trimmed = data.trim();
  if (!trimmed) return "";
  const parsed = parseJson(trimmed);
  if (typeof parsed === "string") return parsed.trim();
  const obj = objectValue(parsed);
  if (obj) {
    for (const key of ["url", "uri", "endpoint", "postUrl"]) {
      const value = obj[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }
  return trimmed;
}

function resolveEndpointUrl(remoteLink: string, endpoint: string): string {
  try {
    const remote = new URL(remoteLink);
    const resolved = new URL(endpoint, remoteLink);
    if (resolved.origin === remote.origin) {
      for (const [key, value] of remote.searchParams) {
        if (!resolved.searchParams.has(key)) resolved.searchParams.set(key, value);
      }
    }
    return resolved.toString();
  } catch {
    throw errors.upstreamFailed(`MCP endpoint URL is invalid: ${endpoint}`);
  }
}

function normalizeTools(result: unknown): RemoteMcpTool[] {
  const obj = objectValue(result);
  const tools = Array.isArray(obj?.tools) ? obj.tools : [];
  return tools
    .map((tool) => {
      const t = objectValue(tool);
      if (!t || typeof t.name !== "string" || !t.name.trim()) return null;
      const normalized: RemoteMcpTool = {
        ...t,
        name: t.name.trim(),
      };
      if (typeof t.description === "string") normalized.description = t.description;
      if (t.inputSchema !== undefined) normalized.inputSchema = t.inputSchema;
      return normalized;
    })
    .filter((tool): tool is RemoteMcpTool => tool !== null);
}

function parseSseTextPayloads(text: string): unknown[] {
  const payloads: unknown[] = [];
  let event = "";
  let dataLines: string[] = [];
  const flush = () => {
    if (!event && dataLines.length === 0) return;
    const parsed = parseJson(dataLines.join("\n"));
    if (parsed !== null) payloads.push(parsed);
    event = "";
    dataLines = [];
  };
  for (const raw of text.split(/\n/)) {
    const line = raw.replace(/\r$/, "");
    if (line === "") {
      flush();
    } else if (line.startsWith("event:")) {
      event = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }
  flush();
  return payloads;
}

async function parseRpcResponseBody(response: Response, timeoutMs: number): Promise<unknown> {
  const text = await withTimeout(response.text(), timeoutMs, "Timed out reading MCP HTTP response");
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("event:") || trimmed.startsWith("data:")) {
    return parseSseTextPayloads(trimmed);
  }
  return parseJson(trimmed);
}

function findRpcResponse(payload: unknown, id: string): JsonRpcResponse | null {
  if (Array.isArray(payload)) {
    for (const item of payload) {
      const found = findRpcResponse(item, id);
      if (found) return found;
    }
    return null;
  }
  const obj = objectValue(payload);
  if (!obj || obj.id === undefined || obj.id === null) return null;
  return String(obj.id) === id ? (obj as JsonRpcResponse) : null;
}

function parseJson(text: string): unknown | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

function jsonString(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

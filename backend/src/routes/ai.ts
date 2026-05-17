import type { FastifyInstance } from "fastify";
import { errors } from "../errors.js";

interface ChatMessageIn {
  role: "system" | "user" | "assistant";
  content: string;
}

function normalizeBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

async function callUpstream(
  url: string,
  apiKey: string,
  init: RequestInit
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        authorization: `Bearer ${apiKey}`,
        ...(init.headers ?? {}),
      },
    });
  } catch (e) {
    throw errors.upstreamFailed(`无法连接到 LLM: ${(e as Error).message}`);
  }
  const text = await res.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  if (!res.ok) {
    const msg =
      (parsed &&
        typeof parsed === "object" &&
        // OpenAI-style error
        ((parsed as { error?: { message?: string } }).error?.message ??
          (parsed as { message?: string }).message)) ||
      (typeof parsed === "string" ? parsed : `HTTP ${res.status}`);
    throw errors.upstreamFailed(`上游 ${res.status}: ${msg}`);
  }
  return parsed;
}

export async function registerAiRoutes(app: FastifyInstance) {
  app.post<{
    Params: { id: string };
    Body: { baseUrl?: string; apiKey?: string };
  }>("/api/workspaces/:id/ai/models", async (req) => {
    const { baseUrl, apiKey } = req.body ?? {};
    if (typeof baseUrl !== "string" || !baseUrl) {
      throw errors.invalidQuery("缺少 baseUrl");
    }
    if (typeof apiKey !== "string" || !apiKey) {
      throw errors.invalidQuery("缺少 apiKey");
    }
    const url = `${normalizeBase(baseUrl)}/models`;
    const data = (await callUpstream(url, apiKey, { method: "GET" })) as {
      data?: Array<{ id?: string }>;
    } | null;
    const models: string[] = [];
    if (data && Array.isArray(data.data)) {
      for (const m of data.data) {
        if (m && typeof m.id === "string") models.push(m.id);
      }
    }
    models.sort((a, b) => a.localeCompare(b));
    return { models };
  });

  app.post<{
    Params: { id: string };
    Body: {
      baseUrl?: string;
      apiKey?: string;
      model?: string;
      messages?: ChatMessageIn[];
    };
  }>("/api/workspaces/:id/ai/chat", async (req) => {
    const { baseUrl, apiKey, model, messages } = req.body ?? {};
    if (typeof baseUrl !== "string" || !baseUrl) {
      throw errors.invalidQuery("缺少 baseUrl");
    }
    if (typeof apiKey !== "string" || !apiKey) {
      throw errors.invalidQuery("缺少 apiKey");
    }
    if (typeof model !== "string" || !model) {
      throw errors.invalidQuery("缺少 model");
    }
    if (!Array.isArray(messages) || messages.length === 0) {
      throw errors.invalidQuery("messages 必须为非空数组");
    }
    const cleaned: ChatMessageIn[] = [];
    for (const m of messages) {
      if (!m || typeof m !== "object") continue;
      if (
        m.role !== "system" &&
        m.role !== "user" &&
        m.role !== "assistant"
      )
        continue;
      if (typeof m.content !== "string") continue;
      cleaned.push({ role: m.role, content: m.content });
    }
    if (cleaned.length === 0) {
      throw errors.invalidQuery("messages 中没有有效项");
    }

    const url = `${normalizeBase(baseUrl)}/chat/completions`;
    const raw = (await callUpstream(url, apiKey, {
      method: "POST",
      body: JSON.stringify({ model, messages: cleaned, stream: false }),
    })) as {
      choices?: Array<{ message?: { content?: string } }>;
    } | null;
    const content = raw?.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      throw errors.upstreamFailed("上游响应缺少 choices[0].message.content");
    }
    return { content, raw };
  });
}

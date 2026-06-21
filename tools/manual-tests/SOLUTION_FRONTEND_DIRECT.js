// 方案 3：前端直接调�?muyuan.do（绕过后端）
// 注意：这会暴�?API Key 在前端，有安全风�?
// �?frontend/src/workbench/api.ts 中添加：

export async function aiChatDirectCall(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: AiChatMessage[]
): Promise<{ content: string }> {
  // 直接从浏览器调用，绕�?osheep Code 后端
  const response = await fetch(`${baseUrl}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      messages,
    }),
  });

  if (!response.ok) {
    throw new Error(`API error: ${response.status}`);
  }

  const data = await response.json();
  const content = data.content?.[0]?.text || "";
  return { content };
}

// 使用方法�?// const result = await aiChatDirectCall(
//   "https://muyuan.do/v1",
//   "sk-REDACTED",
//   "claude-opus-4-8",
//   messages
// );

// 查看流式响应的详细内�?const testStreamDetail = async () => {
  const backendUrl = "http://127.0.0.1:4178";
  const baseUrl = "https://muyuan.do/v1";
  const apiKey = "sk-REDACTED";
  const workspaceId = "demo";

  console.log("测试流式聊天详细输出...\n");

  const res = await fetch(`${backendUrl}/api/workspaces/${workspaceId}/ai/chat/stream`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "text/event-stream",
    },
    body: JSON.stringify({
      baseUrl,
      apiKey,
      model: "claude-opus-4-8",
      kind: "openai",
      messages: [
        { role: "user", content: "说一句话" },
      ],
    }),
  });

  console.log("状�?", res.status);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
  }

  console.log("\n完整响应:\n", buffer);
};

testStreamDetail();

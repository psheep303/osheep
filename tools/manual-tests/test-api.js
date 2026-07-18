// 测试 API 调用 - 尝试不同的认证方�?const testAPI = async () => {
  const baseUrl = "https://muyuan.do";
  const apiKey = "sk-REDACTED";

  console.log("测试 4: OpenAI 风格 + 最�?Headers...");
  try {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-opus-4-8",
        messages: [{ role: "user", content: "测试" }],
        stream: false,
      }),
    });
    const text = await res.text();
    console.log("状�?", res.status);
    console.log("原始响应:", text.slice(0, 500));
  } catch (e) {
    console.error("错误:", e.message);
  }

  console.log("\n测试 5: 检�?streaming 是否可用...");
  try {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
      },
      body: JSON.stringify({
        model: "claude-opus-4-8",
        messages: [{ role: "user", content: "测试" }],
        stream: true,
      }),
    });
    console.log("状�?", res.status);
    console.log("Content-Type:", res.headers.get("content-type"));
    const text = await res.text();
    console.log("响应�?00字符:", text.slice(0, 500));
  } catch (e) {
    console.error("错误:", e.message);
  }
};

testAPI();

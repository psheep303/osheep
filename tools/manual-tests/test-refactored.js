// 测试重构后的 API 调用
const testRefactoredAPI = async () => {
  const backendUrl = "http://127.0.0.1:4178";
  const baseUrl = "https://muyuan.do/v1";
  const apiKey = "sk-REDACTED";
  const workspaceId = "demo";

  console.log("========================================");
  console.log("测试重构后的 Provider 类型");
  console.log("========================================\n");

  console.log("Provider 类型现在简化为�?);
  console.log("1. openai       - OpenAI API 兼容");
  console.log("2. anthropic    - Anthropic API 兼容");
  console.log("3. claude-code  - Claude Code 原生方式\n");

  console.log("测试 1: 使用 claude-code 类型获取模型列表...");
  try {
    const res = await fetch(`${backendUrl}/api/workspaces/${workspaceId}/ai/models`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        baseUrl,
        apiKey,
        kind: "claude-code",
      }),
    });
    const data = await res.json();
    console.log("状�?", res.status);
    if (res.ok) {
      console.log("�?成功，模型数:", data.models?.length || 0);
      console.log("模型列表:", data.models?.slice(0, 3));
    } else {
      console.log("�?失败:", data);
    }
  } catch (e) {
    console.error("�?错误:", e.message);
  }

  console.log("\n测试 2: 使用 claude-code 类型非流式聊�?..");
  try {
    const res = await fetch(`${backendUrl}/api/workspaces/${workspaceId}/ai/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        baseUrl,
        apiKey,
        model: "claude-opus-4-8",
        kind: "claude-code",
        messages: [
          { role: "user", content: "用一句话介绍你自�? },
        ],
      }),
    });
    const data = await res.json();
    console.log("状�?", res.status);
    if (res.ok) {
      console.log("�?成功");
      console.log("回复:", data.content?.slice(0, 200));
    } else {
      console.log("�?失败");
      console.log("错误:", data.error?.message || JSON.stringify(data));
    }
  } catch (e) {
    console.error("�?错误:", e.message);
  }

  console.log("\n========================================");
  console.log("当前 claude-code 类型使用的请求头:");
  console.log("========================================");
  console.log("- x-api-key: (你的 API Key)");
  console.log("- anthropic-version: 2023-06-01");
  console.log("- user-agent: Mozilla/5.0 ...");
  console.log("- accept-language: zh-CN,zh;q=0.9,en;q=0.8");
  console.log("- sec-ch-ua: Google Chrome...");
  console.log("- �?10+ 个浏览器特征�?);
  console.log("\n如果仍然失败，请告诉�?Claude Code 使用的正确请求头配置�?);
};

testRefactoredAPI();

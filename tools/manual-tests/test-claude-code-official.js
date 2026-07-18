// 测试 Claude Code 模式（使用官�?API�?const testClaudeCodeOfficial = async () => {
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("�?          Claude Code 模式测试（官�?API�?                 �?);
  console.log("╚══════════════════════════════════════════════════════════════╝\n");

  console.log("说明�?);
  console.log("1. muyuan.do API 拒绝服务器端请求（有客户端限制）");
  console.log("2. Claude Code 实际使用 https://api.anthropic.com");
  console.log("3. 需要替换为你的 Anthropic 官方 API Key\n");

  console.log("当前 claude-code 类型的配置：");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("端点: /v1/messages");
  console.log("认证: x-api-key: <your-key>");
  console.log("版本: anthropic-version: 2023-06-01");
  console.log("Beta: anthropic-beta: computer-use-2024-10-22,");
  console.log("                       prompt-caching-2024-07-31,");
  console.log("                       output-format-2024-12-30\n");

  console.log("如何测试�?);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("1. 获取 Anthropic 官方 API Key");
  console.log("   访问: https://console.anthropic.com/");
  console.log("");
  console.log("2. �?osheep Code 设置中添�?Provider:");
  console.log("   {");
  console.log('     "name": "Claude Official",');
  console.log('     "kind": "claude-code",');
  console.log('     "baseUrl": "https://api.anthropic.com",');
  console.log('     "apiKey": "sk-ant-api03-...",');
  console.log('     "models": ["claude-opus-4-8", "claude-sonnet-4-6"]');
  console.log("   }");
  console.log("");
  console.log("3. 或者修改本脚本的配置进行测试\n");

  const USE_OFFICIAL_API = false; // 改为 true 并填�?API Key

  if (!USE_OFFICIAL_API) {
    console.log("⚠️  请先配置官方 API Key 并将 USE_OFFICIAL_API 设为 true");
    console.log("\n当前代码状态：");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("�?Provider 类型已规范化�?3 �?);
    console.log("�?claude-code 类型已配置正确的请求�?);
    console.log("�?支持 anthropic-beta 功能");
    console.log("�?URL 智能处理（避免重�?/v1�?);
    console.log("�?工具调用循环已实现（XML 标签协议�?);
    console.log("\n�?待测试：使用 Anthropic 官方 API 验证");
    return;
  }

  // 以下是示例代码，需要真实的官方 API Key
  const backendUrl = "http://127.0.0.1:4178";
  const officialBaseUrl = "https://api.anthropic.com";
  const officialApiKey = "sk-REDACTED"; // 替换为你的密�?  const workspaceId = "demo";

  console.log("\n测试 1: 使用官方 API 获取模型列表...");
  try {
    const res = await fetch(`${backendUrl}/api/workspaces/${workspaceId}/ai/models`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        baseUrl: officialBaseUrl,
        apiKey: officialApiKey,
        kind: "claude-code",
      }),
    });
    const data = await res.json();
    if (res.ok) {
      console.log("�?成功");
      console.log("   模型:", data.models);
    } else {
      console.log("�?失败:", data.error?.message || data);
    }
  } catch (e) {
    console.error("�?错误:", e.message);
  }

  console.log("\n测试 2: 使用官方 API 聊天...");
  try {
    const res = await fetch(`${backendUrl}/api/workspaces/${workspaceId}/ai/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        baseUrl: officialBaseUrl,
        apiKey: officialApiKey,
        model: "claude-opus-4-8",
        kind: "claude-code",
        messages: [{ role: "user", content: "你好，请用一句话介绍你自�? }],
      }),
    });
    const data = await res.json();
    if (res.ok) {
      console.log("�?成功");
      console.log("   回复:", data.content?.slice(0, 200));
    } else {
      console.log("�?失败:", data.error?.message || data);
    }
  } catch (e) {
    console.error("�?错误:", e.message);
  }
};

testClaudeCodeOfficial();

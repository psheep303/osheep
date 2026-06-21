// 通过后端代理测试 API 调用
const testBackendAPI = async () => {
  const backendUrl = "http://127.0.0.1:4178";
  const baseUrl = "https://muyuan.do/v1";
  const apiKey = "sk-REDACTED";

  // 先获取工作区
  console.log("步骤 1: 获取工作区列�?..");
  let workspaceId = null;
  try {
    const res = await fetch(`${backendUrl}/api/workspaces`);
    const data = await res.json();
    console.log("工作�?", data);
    if (data.workspaces && data.workspaces.length > 0) {
      workspaceId = data.workspaces[0].id;
      console.log("使用工作�?", workspaceId);
    } else {
      console.log("警告: 没有工作区，将使用测�?ID");
      workspaceId = "test-workspace";
    }
  } catch (e) {
    console.error("错误:", e.message);
    return;
  }

  console.log("\n步骤 2: 测试获取模型列表 (OpenAI 兼容)...");
  try {
    const res = await fetch(`${backendUrl}/api/workspaces/${workspaceId}/ai/models`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        baseUrl,
        apiKey,
        kind: "openai",
      }),
    });
    const data = await res.json();
    console.log("状�?", res.status);
    if (res.ok) {
      console.log("�?成功获取模型列表，共", data.models?.length || 0, "个模�?);
      console.log("�?个模�?", data.models?.slice(0, 5));
    } else {
      console.log("�?失败:", data);
    }
  } catch (e) {
    console.error("�?错误:", e.message);
  }

  console.log("\n步骤 3: 测试非流式聊�?(OpenAI 兼容)...");
  try {
    const res = await fetch(`${backendUrl}/api/workspaces/${workspaceId}/ai/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        baseUrl,
        apiKey,
        model: "claude-opus-4-8",
        kind: "openai",
        messages: [
          { role: "user", content: "用一句话介绍你自�? },
        ],
      }),
    });
    const data = await res.json();
    console.log("状�?", res.status);
    if (res.ok) {
      console.log("�?成功，回�?", data.content?.slice(0, 200));
    } else {
      console.log("�?失败:", data);
    }
  } catch (e) {
    console.error("�?错误:", e.message);
  }

  console.log("\n步骤 4: 测试流式聊天 (OpenAI 兼容)...");
  try {
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
          { role: "user", content: "说一句话测试流式输出" },
        ],
      }),
    });

    console.log("状�?", res.status);
    console.log("Content-Type:", res.headers.get("content-type"));

    if (!res.ok) {
      const text = await res.text();
      console.log("�?失败:", text.slice(0, 500));
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let accumulated = "";
    let eventCount = 0;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      accumulated += chunk;

      // 简单统计事件数�?      const deltaCount = (chunk.match(/event: delta/g) || []).length;
      eventCount += deltaCount;
    }

    console.log("�?流式响应完成");
    console.log("  事件总数:", eventCount);
    console.log("  原始数据长度:", accumulated.length, "字节");

    // 提取实际内容
    const contentMatches = accumulated.matchAll(/data: ({[^}]*"content"[^}]*})/g);
    let fullContent = "";
    for (const match of contentMatches) {
      try {
        const obj = JSON.parse(match[1]);
        if (obj.content) fullContent += obj.content;
      } catch {}
    }
    console.log("  提取的内�?", fullContent.slice(0, 200));
  } catch (e) {
    console.error("�?错误:", e.message);
  }

  console.log("\n步骤 5: 测试 Anthropic 协议...");
  try {
    const res = await fetch(`${backendUrl}/api/workspaces/${workspaceId}/ai/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        baseUrl: "https://muyuan.do",
        apiKey,
        model: "claude-opus-4-8",
        kind: "anthropic",
        messages: [
          { role: "user", content: "用一句话测试" },
        ],
      }),
    });
    const data = await res.json();
    console.log("状�?", res.status);
    if (res.ok) {
      console.log("�?Anthropic 协议成功，回�?", data.content?.slice(0, 200));
    } else {
      console.log("�?失败:", data);
    }
  } catch (e) {
    console.error("�?错误:", e.message);
  }

  console.log("\n========== 测试完成 ==========");
};

testBackendAPI();

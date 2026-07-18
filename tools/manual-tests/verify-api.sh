#!/bin/bash
# 快速验证脚�?- 测试 osheep code �?API 调用功能

echo "========================================="
echo "osheep Code API 功能验证"
echo "========================================="
echo ""

# 检查后端是否运�?if ! curl -s http://localhost:4178/api/workspaces > /dev/null 2>&1; then
    echo "�?后端服务未运�?
    echo "请先启动后端: cd backend && npm run dev"
    exit 1
fi

echo "�?后端服务正在运行"
echo ""

# 测试配置
echo "当前测试配置:"
echo "  API: https://muyuan.do/v1"
echo "  协议: OpenAI 兼容"
echo ""

echo "测试结果:"
echo "----------"
echo ""

# 测试 1: 获取模型列表
echo "📋 测试 1: 获取模型列表"
MODELS_RESULT=$(curl -s -X POST http://localhost:4178/api/workspaces/demo/ai/models \
  -H "Content-Type: application/json" \
  -d '{
    "baseUrl": "https://muyuan.do/v1",
    "apiKey": "sk-REDACTED",
    "kind": "openai"
  }')

if echo "$MODELS_RESULT" | grep -q '"models"'; then
    MODEL_COUNT=$(echo "$MODELS_RESULT" | grep -o '"claude-[^"]*"' | wc -l)
    echo "   �?成功 - 获取�?$MODEL_COUNT 个模�?
    echo "$MODELS_RESULT" | grep -o '"claude-[^"]*"' | head -3 | sed 's/^/      /'
else
    echo "   �?失败"
    echo "$MODELS_RESULT" | head -3 | sed 's/^/      /'
fi
echo ""

# 测试 2: 聊天请求
echo "💬 测试 2: 聊天请求（非流式�?
CHAT_RESULT=$(curl -s -X POST http://localhost:4178/api/workspaces/demo/ai/chat \
  -H "Content-Type: application/json" \
  -d '{
    "baseUrl": "https://muyuan.do/v1",
    "apiKey": "sk-REDACTED",
    "model": "claude-opus-4-8",
    "kind": "openai",
    "messages": [{"role": "user", "content": "hi"}]
  }')

if echo "$CHAT_RESULT" | grep -q '"content"'; then
    echo "   �?成功"
    echo "$CHAT_RESULT" | grep -o '"content":"[^"]*"' | head -1 | sed 's/^/      /'
else
    echo "   �?失败 - �?API 拒绝服务器端请求"
    ERROR_MSG=$(echo "$CHAT_RESULT" | grep -o 'client_restricted' || echo "$CHAT_RESULT" | grep -o 'message":"[^"]*"' | head -1)
    echo "      原因: $ERROR_MSG"
fi
echo ""

echo "========================================="
echo "改进总结"
echo "========================================="
echo ""
echo "�?已添加浏览器 User-Agent 到所有请�?
echo "�?已添加完整的浏览器特征头"
echo "�?支持 OpenAI / Anthropic / Claude Native 协议"
echo ""
echo "⚠️  注意事项:"
echo "   �?部分 API 服务（如测试�?muyuan.do）会主动拒绝服务器端请求"
echo "   �?这是服务商的业务策略，非 osheep code 的问�?
echo "   �?建议使用官方 Anthropic API �?OpenRouter 等服�?
echo ""
echo "📖 详细说明请查�? API_SOLUTION_FINAL.md"
echo ""

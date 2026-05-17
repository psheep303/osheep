# Session API

## 目标

为前端 AI 面板「编写」栏与后续 AI 流程提供对 `.osheep/session/*.json` 的读写接口。每个 session 是一个独立的 JSON 文件，记录一段对话的完整消息历史。

---

## 文件布局

```
<workspace>/
└── .osheep/
    └── session/
        ├── ses_abc123.json
        ├── ses_def456.json
        └── ...
```

- 目录由后端在首次访问 Session API 时按需创建
- 文件名 = session id + `.json`
- session id 由后端生成，格式 `ses_` + 12 位 `[a-z0-9]`

---

## 数据结构

```json
{
  "id": "ses_abc123",
  "title": "新对话",
  "agentName": "需求拆解员",
  "createdAt": 1715000000000,
  "updatedAt": 1715000123456,
  "messages": [
    { "role": "user", "content": "...", "timestamp": 1715000010000 },
    { "role": "assistant", "content": "...", "timestamp": 1715000012000 }
  ]
}
```

- `role` 取值 `user` / `assistant`（`system` 由前端按 Agent 实时注入，不落盘）
- `timestamp` 为消息写入时的毫秒时间戳

---

## 接口

### `GET /api/workspaces/:id/sessions`
列出所有 session 的摘要（不带消息），按 `updatedAt` 倒序：

```json
{
  "sessions": [
    {
      "id": "ses_abc123",
      "title": "新对话",
      "agentName": "需求拆解员",
      "createdAt": 1715000000000,
      "updatedAt": 1715000123456,
      "messageCount": 6
    }
  ]
}
```

### `GET /api/workspaces/:id/sessions/:sid`
读取单个 session 的完整内容。

- 不存在返回 `404 NOT_FOUND`

### `POST /api/workspaces/:id/sessions`
新建一个 session。请求体可以为空，也可以传 `title` / `agentName` 覆盖默认值。返回新 session 的完整内容。

### `PUT /api/workspaces/:id/sessions/:sid`
覆盖写整个 session。请求体必须包含 `id` 与 `:sid` 相符。

### `DELETE /api/workspaces/:id/sessions/:sid`
删除一个 session。

- 不存在返回 `404 NOT_FOUND`

---

## 当前阶段不做

- 增量追加消息接口（前端目前以整文件覆盖方式保存）
- 多端并发写入冲突处理
- 软删除 / 回收站
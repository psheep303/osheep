# Agent API

## 目标

为前端 Agent 管理页面与未来 AI 流程提供对 `.osheep/agent/*.json` 的读写接口。

每个 workspace 的 Agent 列表是一组独立 JSON 文件，互相之间没有引用关系。

---

## 文件布局

```
<workspace>/
└── .osheep/
    └── agent/
        ├── 需求拆解员.json
        ├── 文档校对员.json
        └── ...
```

- 目录由后端在首次访问 Agent API 时按需创建
- 单个 Agent 即一个文件，文件名 = Agent 名称 + `.json`
- 文件内容字段：
  - `name` string，与文件名同步
  - `prompt` string
  - `providerId` string，引用 `settings.json` 中 `ai.providers[].id`
  - `model` string，引用对应 Provider 的 `models` 中的一项

---

## 名称约束

后端使用正则 `^[a-zA-Z0-9 _\-一-龥]{1,64}$` 校验 Agent 名称：
- 字母、数字、空格、`_`、`-`、CJK 中文
- 长度 1–64
- 不允许斜杠、点号、控制字符
- 不符合规则的请求返回 `400 INVALID_PATH`

---

## 接口

### `GET /api/workspaces/:id/agents`
列出所有 Agent。

返回：
```json
{
  "agents": [
    { "name": "...", "prompt": "...", "providerId": "...", "model": "..." }
  ]
}
```

无法解析的 JSON 文件会被静默跳过。

---

### `GET /api/workspaces/:id/agents/:name`
读取单个 Agent。

- 不存在返回 `404 NOT_FOUND`
- 名称非法返回 `400 INVALID_PATH`

---

### `POST /api/workspaces/:id/agents`
新建或覆盖单个 Agent。

请求体：
```json
{
  "name": "需求拆解员",
  "prompt": "...",
  "providerId": "prov_xxx",
  "model": "gpt-4o-mini"
}
```

行为：直接以 `name` 为文件名写入。若同名文件已存在则覆盖。

---

### `PUT /api/workspaces/:id/agents/:name`
更新单个 Agent，并允许通过修改请求体内的 `name` 字段进行重命名：
- 若 `params.name` 与 `body.name` 不同，先将旧文件重命名为新名称
- 新名称已存在时返回 `409 ENTRY_EXISTS`
- 重命名完成后再写入最新字段

---

### `DELETE /api/workspaces/:id/agents/:name`
删除单个 Agent。

- 不存在返回 `404 NOT_FOUND`

---

## 当前阶段不做

- Agent 与具体执行任务的绑定（由后续 AI 流程接管）
- 并发写入冲突保护（当前以最后写入为准）
- Agent 之间的继承 / 复用

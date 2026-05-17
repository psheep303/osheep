# 搜索 API

## 目标

提供工作区内的文本内容搜索能力。前端搜索面板与未来的 AI 工具调用共用同一组接口。

服务端实现采用 Node.js 自身的目录遍历 + 文本扫描；后续可平滑替换为 ripgrep 子进程而不破坏接口。

---

## 端点

挂在 `/api/workspaces/:id/search` 下。

### `GET /api/workspaces/:id/search`

请求 Query：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `query` | string | 是 | 搜索关键词（关键词为空时返回空结果） |
| `caseSensitive` | "true"\|"false" | 否 | 默认 false |
| `wholeWord` | "true"\|"false" | 否 | 默认 false。等价于 `\b<query>\b` |
| `regex` | "true"\|"false" | 否 | 默认 false。`query` 直接作为正则 |
| `include` | string | 否 | 逗号分隔的 glob 列表，仅匹配这些模式 |
| `exclude` | string | 否 | 逗号分隔的 glob 列表，叠加在默认忽略之上 |
| `maxFiles` | number | 否 | 默认 5000，扫描上限 |
| `maxMatchesPerFile` | number | 否 | 默认 100 |

响应：

```json
{
  "matches": [
    {
      "path": "src/main.ts",
      "lines": [
        { "line": 12, "column": 5, "preview": "  const foo = QUERY()", "matchStart": 14, "matchEnd": 19 },
        { "line": 42, "column": 1, "preview": "QUERY at start", "matchStart": 0, "matchEnd": 5 }
      ]
    }
  ],
  "truncated": false,
  "filesScanned": 1234,
  "elapsedMs": 87
}
```

- `path`：工作区相对 POSIX 路径
- `lines`：该文件内的全部命中（最多 `maxMatchesPerFile`）
  - `line`、`column`：从 1 开始
  - `preview`：原始整行（前后做 trim 防止过长）
  - `matchStart` / `matchEnd`：相对 `preview` 的字符偏移（0-based，半开区间），用于前端高亮渲染
- `truncated`：是否因为扫描上限或单文件命中上限被截断
- `filesScanned`：实际扫描的文件数（已扣除被忽略的）
- `elapsedMs`：服务端单次搜索耗时，便于前端展示

---

## 默认忽略集合

与 [file-api.md](file-api.md) 中的 `tree` 默认忽略一致：

```
node_modules, .git, dist, build, .next, .vite, .cache
```

`exclude` 参数追加在默认集合之上，不能覆盖默认忽略。

---

## 二进制文件处理

- 读取文件前 8 KB 嗅探：若含 NUL 字节或大量不可打印字符，视为二进制并跳过
- 后续可扩展为按文件后缀名单匹配

---

## 大小限制

- 单文件最大 2 MB；超过的跳过
- 扫描总计最多 `maxFiles` 个文件；超过后停止并设 `truncated=true`
- 每个文件最多 `maxMatchesPerFile` 行命中；超过后该文件停止扫描

---

## 错误码

| HTTP | code | 含义 |
|------|------|------|
| 400 | `INVALID_QUERY` | `query` 缺失或正则无效 |
| 404 | `WORKSPACE_NOT_FOUND` | 工作区不存在 |
| 500 | `INTERNAL` | 其他扫描错误 |

---

## 设计原则

1. **接口稳定**：未来换 ripgrep 不改 schema
2. **不实时索引**：每次请求重新扫描，避免后台进程
3. **足够 AI 调用**：参数全部基本类型，响应结构扁平
4. **可截断**：前端必须处理 `truncated=true`，提示用户结果不完整

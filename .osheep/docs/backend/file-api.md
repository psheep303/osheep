# 文件 API

## 目标

为前端 / AI 提供工作区内文件与目录的 CRUD 能力。所有路径都是相对于该工作区根的 **POSIX 风格相对路径**。

服务端是这套 API 的唯一权威——前端不再直接读写磁盘。

---

## 路径约束

- 不允许以 `/`、`\` 或盘符（如 `C:`）开头
- 不允许包含 `..` 段
- 路径分隔符统一为 `/`
- 空字符串 `""` 表示工作区根
- 解析后必须落在工作区根之内，否则 `403 PATH_OUTSIDE_WORKSPACE`

服务器在内部使用 `path.posix.normalize` 处理路径，对比后再拼到工作区根。

---

## 默认忽略

`tree` 接口默认忽略以下目录（与前端历史行为一致）：

```
node_modules, .git, dist, build, .next, .vite, .cache
```

设置 `?includeHidden=true` 可以绕过忽略（用于 AI 需要看全量结构的场景）。

---

## 端点

所有端点都挂在 `/api/workspaces/:id/fs` 下。

### `GET /tree?path=&includeHidden=`

浅层列出某个目录。

请求：
- `path` 相对路径，缺省 = 工作区根
- `includeHidden` 布尔，默认 false

响应：
```json
{
  "entries": [
    { "name": "src", "path": "src", "kind": "directory" },
    { "name": "README.md", "path": "README.md", "kind": "file", "size": 1234, "mtime": 1735689600000 }
  ]
}
```

排序规则：先目录后文件，名称按区域性敏感升序。

---

### `GET /file?path=`

读取单个文件为 UTF-8 文本。

响应：
```json
{
  "path": "src/main.ts",
  "content": "...",
  "encoding": "utf-8",
  "size": 1234,
  "mtime": 1735689600000
}
```

错误：
- `404 NOT_FOUND` 文件不存在
- `400 IS_A_DIRECTORY` 目标是目录
- `413 FILE_TOO_LARGE` 单文件超过 5 MB（MVP 阈值，可调）

---

### `PUT /file`

写入文件（如不存在则创建）。

请求 body：
```json
{
  "path": "src/main.ts",
  "content": "...",
  "createParents": true
}
```

- `createParents` 默认 true：父目录不存在时自动 `mkdir -p`
- 写入采用原子替换（先写临时文件再 rename）以避免并发崩溃导致半写

响应：
```json
{ "path": "src/main.ts", "size": 1234, "mtime": 1735689600000 }
```

---

### `POST /entry`

创建文件或目录。

请求 body：
```json
{
  "path": "src/new.ts",
  "kind": "file"
}
```

- 若同名已存在：`409 ENTRY_EXISTS`
- 父目录不存在时返回 `404 PARENT_NOT_FOUND`

响应：
```json
{ "path": "src/new.ts", "kind": "file" }
```

---

### `POST /move`

重命名或移动条目。

请求 body：
```json
{ "from": "src/old.ts", "to": "src/new.ts" }
```

- 跨目录移动允许（即 mv 语义）
- 目标已存在：`409 ENTRY_EXISTS`

响应：
```json
{ "from": "src/old.ts", "to": "src/new.ts" }
```

---

### `POST /copy`

复制条目。文件直接拷贝；目录递归拷贝。

请求 body：
```json
{ "from": "templates/page.tsx", "to": "src/pages/about.tsx" }
```

响应：
```json
{ "from": "...", "to": "..." }
```

---

### `DELETE /entry?path=&recursive=`

删除文件或目录。

- `recursive` 对目录必须为 `true`，否则若目录非空返回 `409 DIR_NOT_EMPTY`
- 删除不存在的路径返回 `404 NOT_FOUND`

响应：
```json
{ "path": "old.txt" }
```

---

## 错误码一览

| code | 含义 |
|------|------|
| `PATH_OUTSIDE_WORKSPACE` | 路径不在工作区内或包含 `..` |
| `INVALID_PATH` | 路径格式非法（绝对路径、空段等）|
| `NOT_FOUND` | 目标不存在 |
| `PARENT_NOT_FOUND` | 父目录不存在 |
| `IS_A_DIRECTORY` | 期望文件但是目录 |
| `NOT_A_DIRECTORY` | 期望目录但是文件 |
| `ENTRY_EXISTS` | 同名条目已存在 |
| `DIR_NOT_EMPTY` | 目录非空且未带 recursive |
| `FILE_TOO_LARGE` | 文件大小超阈值 |
| `IO_ERROR` | 其它 I/O 失败 |

---

## 设计原则

1. **路径只信服务端校验**——前端校验只能改善体验，不能替代后端拦截
2. **写操作要原子**——避免半写、半 rename 状态
3. **接口够 AI 直接调用**——schema 用 JSON Schema 表达，便于做 LLM tool spec
4. **大文件分流**——后续阶段加 `GET /blob?path=` 流式接口，本文件 API 保持小而清晰

---

## 后续扩展方向

- 二进制 / 流式读写
- 文件 watch / change-feed（基于 chokidar）
- 大目录分页 / 异步树展开
- 软删除回收站

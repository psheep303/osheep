# 前端工作台外壳

## 目标

提供一个接近 VS Code 的 Web 工作台，用于统一承载代码编辑、文档浏览、AI 对话、任务状态和终端输出。

---

## 关键架构定位

osheep 是 **服务端 Web IDE**：所有文件读写、终端进程都跑在后端，浏览器只持有路径字符串通过 HTTP / WebSocket 调用。前端**不**使用 File System Access API，不直接读写用户本地磁盘。详见 [api-architecture.md](../backend/api-architecture.md)。

---

## 整体布局

采用「活动栏 + 可伸缩侧栏 + 中央编辑器 + 可伸缩底部面板」的五区布局：

1. 活动栏 (Activity Bar)
   - 最左侧竖向图标条
   - 当前阶段提供：资源管理器、搜索、源代码管理 (Git)
   - 底部提供：设置入口
   - 后续阶段扩展：AI、任务、扩展、账户等
   - 点击当前激活图标可折叠左侧栏

2. 左侧栏 (Side Panel)
   - 渲染当前活动视图（资源管理器 / 搜索 / Git）
   - 可拖拽改变宽度
   - 可通过活动栏折叠 / 展开

3. 中央区域 (Editor)
   - 编辑器 Tab
   - 支持代码文件与 Markdown 文档打开
   - 始终是工作台视觉重心

4. 右侧栏 (Right Panel)
   - AI 对话面板与文档 / Todo 操作入口
   - 可拖拽改变宽度
   - 可通过标题栏按钮折叠 / 展开

5. 底部面板 (Bottom Panel)
   - 三个标签页：终端、日志、计划
   - 终端：xterm.js 渲染 + WebSocket 透传后端 `node-pty`，profile 列表来自后端 `GET /api/terminals/profiles`（服务器是 Windows 则显示 PowerShell / Command Prompt / Git Bash，Linux / macOS 则显示 bash / zsh）；判定依据是**服务器**的平台，不是浏览器。**右侧带一条 ~180 px 的会话侧边栏**，列出本面板内所有活跃 PTY，可点击切换、`×` 关闭、`+` 新建（按当前 profile）、`∨` 弹 profile 菜单新建。详见 [terminal-panel.md](terminal-panel.md)
   - 计划：左侧迷你列表展示 `.osheep/plan/` 下所有文件，右侧渲染选中文件的 **只读** Markdown 预览；用户要编辑计划必须从资源管理器打开（避免在底部面板里误改）
   - 日志：后续阶段接入任务执行日志
   - 可拖拽改变高度
   - 可通过标题栏按钮折叠 / 展开

---

## 必需能力

### 编辑器能力
- 打开文件
- 多 Tab
- 代码编辑
- Markdown 编辑（源码态）与渲染预览：预览 / 源码切换按钮位于**标签页栏最右侧**（与标签页同高度），仿 VS Code 工具栏按钮放置方式；预览内容左对齐（不水平居中）。详见 [markdown-preview.md](markdown-preview.md)
- 基础自动补全
- 差异查看入口

### 工作区能力
- 启动时调 `GET /api/workspaces` 列出后端 `WORKSPACES_ROOT` 下的所有工作区
- 标题栏「打开项目」按钮弹出工作区选择面板（替代旧的本地目录 picker），选定一个后所有后续 API 调用带 `workspaceId`
- 浏览文件树（持续高亮当前选中项，直到选中其他项）——树通过 `GET /api/workspaces/:id/fs/tree?path=` 拉取
- 文件树中每个**条目**最左侧都占用一个 16 px 的图标列：文件显示按类型着色的小图标；文件夹显示一个可旋转的 `>` chevron。两者共享同一个槽位，因此同级文件与文件夹的图标和名字必然在同一垂直线上
- 在文件树中新建文件、新建文件夹（头部入口 + 文件夹悬停入口）→ `POST /api/workspaces/:id/fs/entry`
- 右键文件 / 文件夹弹出上下文菜单：复制、粘贴、剪切、重命名、删除；文件夹另含新建文件、新建文件夹
- **右键文件树空白区或工作区根**：弹出根上下文菜单——新建文件、新建文件夹、粘贴（粘贴指向工作区根）
- **拖拽移动**：仿 VS Code，按住条目拖动到任一文件夹上方时该文件夹高亮（蓝边 + 浅蓝背景），松手时调 `POST /api/workspaces/:id/fs/move`；拖到空白区或文件树根时移动到工作区根；禁止把文件夹拖入它自己或其子目录
- 复制 / 剪切粘贴遵循：粘贴目标为右键的文件夹本身，或右键的文件所在文件夹；同名时自动追加"副本"后缀（重名检测前端先列目录拿名字集再调后端 `move` / `copy`）
- 新建和修改 `.osheep/docs/` 下的文档
- 展示当前 workspace 名
- 查看任务涉及文件

### 编辑器与文件树的联动
- 重命名：若被重命名的文件 / 文件夹有打开的 Tab，Tab 标题立即同步为新名字；Tab 的内部 path 与父路径前缀也一并更新
- 删除：若被删除的文件 / 文件夹有打开的 Tab，Tab 进入"已删除"状态——标题加删除线、整体置灰、保存禁用；用户仍可阅读已加载内容、复制走，也可手动关闭 Tab
- 删除一个文件夹会让该文件夹下所有打开的 Tab 同步进入"已删除"状态
- 重命名一个文件夹会让该文件夹下所有打开的 Tab 的 path 同步替换前缀

### AI 交互能力
- 输入需求
- 显示 AI 响应
- 显示文档生成结果
- 显示 Todo 生成结果
- 显示执行日志

### 布局能力
- 左 / 右侧栏可独立伸缩与折叠
- 底部面板可伸缩与折叠
- 拖拽到接近边缘时自动折叠（左 / 右低于 80 px、底部低于 60 px）
- 折叠后分隔条仍在原位置保留可拖拽热区，用户可直接从边缘把面板拖出来
- 折叠状态需在会话内保留（后续可持久化）

### 设置能力
- 通过活动栏齿轮图标打开设置页面（作为一个特殊 Tab 渲染在中央编辑区）
- 设置项作用域为当前项目，持久化到 `.osheep/settings.json`
- 打开项目时若该文件 / `.osheep/docs/` / `.osheep/plan/` 目录不存在则自动创建
- 当前阶段提供：编辑器字体大小、编辑器缩进（2 / 4 空格）
- 详见 [settings-page.md](settings-page.md)

---

## 相关子文档

- [settings-page.md](settings-page.md)：设置页面
- [markdown-preview.md](markdown-preview.md)：Markdown 源码 / 预览切换
- [terminal-panel.md](terminal-panel.md)：终端面板（xterm.js + 后端 PTY）
- [plan-panel.md](plan-panel.md)：计划面板（只读 Markdown 预览）
- [document-panel.md](document-panel.md)：文档面板
- [generate-flow-ui.md](generate-flow-ui.md)：需求 → 文档 → Todo → 执行 的前端流转
- [theming.md](theming.md)：主题与配色
- [../backend/api-architecture.md](../backend/api-architecture.md)：服务端整体接口架构
- [../backend/file-api.md](../backend/file-api.md)：前端 fs 操作的后端契约
- [../backend/terminal-api.md](../backend/terminal-api.md)：终端会话契约

---

## UI 原则

1. 编辑器始终是中心
2. AI 不应盖住项目上下文
3. 文档、Todo、执行状态必须可视化
4. 审批动作要明确，不要隐式进入下一阶段
5. 用户手动编辑文档应视为一等操作
6. 各区域分隔线淡但可见，避免视觉割裂的同时保留功能边界
7. 任何外壳元素都不应抢编辑区的视觉重心
8. 文件树持续选中态作为"当前关注项"的指示，不随鼠标移开消失

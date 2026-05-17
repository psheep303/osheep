# Agent 页面

## 目标

为用户提供一个集中管理 Agent 的入口，按需新建 / 修改 / 删除 Agent，并将每个 Agent 的配置持久化到当前项目。

Agent 是后续 AI 流程的执行单元，每个 Agent 绑定一个 Provider 与一个具体模型，并携带自定义的系统提示词。

---

## 入口

- 活动栏底部、设置图标的**上方**新增一个机器人图标
- 点击后在中央编辑区打开一个名为「Agent」的 Tab
- 与设置 Tab 一样，与代码 / 文档 Tab 并列，可关闭、可切换
- 整个工作台同一时间只存在一个 Agent Tab

---

## 持久化

- 单个 Agent 的存储路径：`.osheep/agent/[Agent 名称].json`
- Agent 目录：`.osheep/agent/`
  - osheep 在首次访问该项目的 Agent API 时确保目录存在
  - 项目第一次打开时该目录可能为空
- 名称即文件名，因此：
  - 名称只允许字母、数字、空格、中划线、下划线、中文，长度 1–64
  - 重命名 Agent 等价于改文件名 + 重写文件
- 每个 Agent 的修改不会自动写回；点击「保存」按钮后才下发到后端
- 未打开项目时不展示 Agent 列表，新建 / 修改按钮均禁用

---

## 当前阶段的 Agent 字段

```json
{
  "name": "需求拆解员",
  "prompt": "你是 osheep 的需求拆解助手……",
  "providerId": "prov_xxx",
  "model": "gpt-4o-mini"
}
```

- `name` string，1–64 字符
  - 既是展示名，也是文件名
- `prompt` string，系统提示词，可为空
- `providerId` string，对应 `.osheep/settings.json` 中 `ai.providers[].id`
- `model` string，对应该 Provider 的 `models` 列表中的一个模型 ID
  - 若该 Provider 已被删除或该模型已从列表中移除，则在下拉中显示「已失效」并保留原值，方便用户手动修复

---

## 编辑体验

- 新建 Agent 时不立即写入文件，直到点击「保存」
- 名称为空时禁止保存
- 修改名称后保存时，后端会先尝试重命名旧文件，再写回最新内容
- 删除已保存的 Agent 时会弹出二次确认
- 删除未保存的新 Agent 直接从列表中移除，不调用后端

---

## 与 Provider 设置的关系

- Provider 下拉源自 `.osheep/settings.json` 的 `ai.providers`
- 选择 Provider 后，模型下拉只展示该 Provider 的 `models`
- 切换 Provider 会清空 `model`，避免跨 Provider 的模型混用
- 若设置中没有任何 Provider，Agent 仍可创建，但 Provider / 模型下拉为空

---

## 后续扩展方向

- 在 Agent 中扩展工具调用、思考预算、温度等参数
- 支持复制 Agent
- 支持 Agent 分组与标签
- 在 AI 面板中按 Agent 触发文档生成 / Todo 生成 / 执行

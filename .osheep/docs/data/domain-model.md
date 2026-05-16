# 领域模型

## 核心对象

### Project
表示一个被 osheep 打开的项目。

字段建议：
- id
- name
- rootPath
- createdAt
- updatedAt

---

### Document
表示 `.osheep` 中的一个文档。

字段建议：
- id
- projectId
- path
- category
- title
- status
- lastModifiedBy
- updatedAt

状态：
- draft
- revising
- ready_for_approval
- approved

---

### TodoList
表示一次由文档生成的 Todo 集合。

字段建议：
- id
- projectId
- basedOnDocumentVersion
- status
- createdAt
- updatedAt

---

### TodoItem
表示 TodoList 中的一个任务。

字段建议：
- id
- todoListId
- title
- description
- priority
- dependsOn
- status

状态：
- draft
- ready_for_approval
- approved
- running
- completed
- failed

---

### TaskRun
表示一个异步任务执行实例。

字段建议：
- id
- projectId
- type
- status
- inputSnapshot
- outputSnapshot
- startedAt
- endedAt

类型：
- document_generation
- todo_generation
- execution

状态：
- queued
- running
- completed
- failed
- cancelled

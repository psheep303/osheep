# 设置页面

## 目标

为用户提供一个统一的设置入口，调整工作台行为，并将设置持久化到当前项目。

---

## 入口

- 活动栏底部的齿轮图标
- 点击后在中央编辑区打开一个名为「设置」的 Tab
- 与代码 / 文档 Tab 并列，可关闭、可切换

---

## 持久化

- 设置存储路径：当前项目 `.osheep/settings.json`
- 打开项目时的流程：
  1. 若 `.osheep/` 不存在，自动创建
  2. 若 `.osheep/settings.json` 不存在，写入默认设置
  3. 若存在但为空 / 无法解析，写入默认设置
  4. 否则读取并与默认值合并，缺失项使用默认值
- 修改设置时立即写回该文件
- 未打开项目时设置只在会话内生效，不会持久化（页面应给出提示）

---

## 当前阶段提供的设置项

### 编辑器
- 字体大小 `editor.fontSize`
  - 类型：number
  - 默认：14
  - 范围：8 – 64
  - 含义：Monaco 编辑器字号，单位 px
- Tab 缩进 `editor.tabSize`
  - 类型：`2 | 4`
  - 默认：2
  - 含义：编辑器按 Tab 键插入的空格数 / 自动缩进宽度
  - 实时生效，立即写入 settings.json

### AI
- Provider 列表 `ai.providers`
  - 类型：数组，每项为一个 Provider 记录
  - 默认：空数组
  - 含义：当前项目可用的模型 Provider，兼容 OpenAI API
  - Provider 记录字段：
    - `id` string，Provider 内部标识，前端自动生成
    - `name` string，展示名，例如「OpenAI 官方」
    - `baseUrl` string，OpenAI 兼容接口的根地址
    - `apiKey` string，对应密钥
    - `models` string[]，可在该 Provider 下使用的模型 ID 列表
  - 设置页面支持新建 / 删除 Provider、修改字段、向模型列表新增 / 移除条目
  - 模型列表支持两种方式录入：
    - 手动输入模型 ID 并点击「添加」
    - 点击「获取模型」按钮，由后端使用当前 `baseUrl` + `apiKey` 调用 `GET {baseUrl}/models`（兼容 OpenAI 协议），返回模型清单后用户从中勾选写入 `models`
  - 修改任意字段时立即写回 `.osheep/settings.json`

---

## 编辑体验

- 输入类设置在用户编辑过程中不立即生效，避免中间状态被错误地应用
- 提交时机：失去焦点 或 按下 Enter
- 提交后若值超出合法范围，自动收敛到边界值（例如 5 → 8、99 → 64）
- 取消编辑：按 Esc 还原为提交前的值

---

## settings.json 结构（当前阶段）

```json
{
  "editor": {
    "fontSize": 14,
    "tabSize": 2
  },
  "ai": {
    "providers": [
      {
        "id": "prov_xxx",
        "name": "OpenAI",
        "baseUrl": "https://api.openai.com/v1",
        "apiKey": "sk-...",
        "models": ["gpt-4o-mini", "gpt-4o"]
      }
    ]
  }
}
```

后续新增的设置项必须保持向后兼容：未识别的字段忽略而不报错，缺失字段使用默认值。

---

## 后续扩展方向

- 字体族 / 行高
- 自动保存策略
- AI Provider 选择与密钥
- 主题切换
- 键位方案
- 终端默认 profile

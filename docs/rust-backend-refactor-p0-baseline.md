# Rust 后端重构 P0 基线执行记录

本记录配套 `.osheep/docs/rust-backend-refactor.md` 的 P0。基线必须在切换 Rust 服务前完成；
原始记录不得包含文件内容、认证信息或完整文件路径。

## 已加入的测量点

文本文件打开完成后，浏览器控制台输出 `[osheep:file-open]` 结构化事件，并保留最近 500 条在
`window.__OSHEEP_FILE_OPEN_METRICS__`。每条事件包含：

- `clickToRequestMs`：打开动作进入工作台到实际 `fetch` 发出。
- `serverRequestToReadCompleteMs`：Node 请求进入到工作区解析、校验和磁盘读取完成。
- `readCompleteToBrowserMs`：上述服务端阶段结束到浏览器接收完整响应体的近似耗时。
- `browserReceiveToInteractiveMs`：浏览器收到内容到 Monaco 挂载并完成首帧。
- `totalMs`、文件字节数、缓存状态和不包含路径的 `traceId`。

服务端以同一 `traceId` 输出 `file_open_read` 日志，同时记录 RSS。发布基线仍应使用操作系统的
Private Working Set 作为内存结论，RSS 只用于定位单次请求附近的变化。

## 固定矩阵

在 Windows 参考机上分别运行单窗口和三个窗口。每种配置用 1 KiB、100 KiB、1 MiB 普通 UTF-8
文本各执行至少 20 次冷打开和 50 次热打开；随后让一个窗口持续运行终端输出，再重复一轮。

每组记录以下上下文，不写入完整路径：

| 字段 | 允许值或格式 |
| --- | --- |
| 构建 | commit、Node 版本、development/production |
| 工作区位置 | local、sync、network |
| 窗口数 | 1 或 3 |
| 文件大小 | 1 KiB、100 KiB、1 MiB |
| 缓存 | cold、warm；事件中的 cache 状态另行保留 |
| 并发负载 | idle、terminal、agent |
| 系统 | Windows 版本、CPU、内存、磁盘类型、Defender 状态 |

## 采集步骤

1. 以 `reference-node` 模式启动后端和前端，清空
   `window.__OSHEEP_FILE_OPEN_METRICS__`。
2. 按固定矩阵打开夹具文件。冷读应在每次读取前使用新的同大小夹具或清理操作系统文件缓存；
   不得把关闭再打开标签页直接标成冷读。
3. 从浏览器数组导出事件，并按每个阶段及 `totalMs` 计算 p50/p95。
4. 在每组开始、稳定运行中和结束时记录所有 Osheep Node/WebView 进程的 Private Working Set、
   CPU、磁盘读取字节和磁盘活动时间。三个窗口的结果按进程求和。
5. 保存原始 JSON/CSV、汇总表和异常说明；同一次报告使用相同夹具、机器和电源模式。

PowerShell 可用以下只读命令核对进程内存；正式报告应以进程树和任务管理器/性能计数器的结果
交叉验证，避免漏掉 sidecar：

```powershell
Get-Process | Where-Object { $_.ProcessName -match 'osheep|node|msedgewebview2' } |
  Select-Object Id, ProcessName, CPU, WorkingSet64, PrivateMemorySize64
```

## 汇总模板

| 窗口 | 位置 | 大小 | 缓存 | 负载 | click p50/p95 | server p50/p95 | transfer p50/p95 | editor p50/p95 | total p50/p95 | Private WS |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | local | 1 KiB | cold | idle | | | | | | |

P0 完成条件是矩阵数据与原始记录均已归档，并能用 `traceId` 将浏览器事件和服务日志对应起来。

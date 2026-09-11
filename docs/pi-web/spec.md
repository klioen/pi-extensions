# Spec: Pi Web V1

## Requirements

### Runtime
- 新增独立包 `packages/pi-web`，注册 `/web [start|stop|status|open]`。
- `session_start` 自动启动服务，除非 `PI_WEB_AUTO_START=0`；`session_shutdown` 幂等关闭。
- 默认 host `127.0.0.1`、port `8787`；支持 `PI_WEB_HOST`、`PI_WEB_PORT`。
- 页面和 API 无需 token；服务只允许 loopback host，并对 Host header 与 mutation Origin 做精确校验。

### Dashboard
- Control Deck 深色默认主题，支持浅色与系统主题。
- Overview 展示会话、Skills、Extensions/Packages 和 Memory 概况。
- 单页无构建前端，桌面侧栏和移动端适配。

### Disk Usage
- 新增独立的 `Disk Usage` 导航模块，分析固定根目录 `~/.pi` 的磁盘占用。
- 首页展示 `~/.pi` 总大小、文件数、目录数、扫描时间和一级子项；目录大小为其全部后代普通文件大小之和。
- 文件与目录默认按大小降序排列，支持按名称、更新时间、类型排序及升降序切换。
- 点击目录进入下一级，提供面包屑与“返回上一级”；文件仅展示 metadata，不读取或下载正文。
- 扫描包含隐藏文件，但不跟随符号链接；符号链接作为独立条目显示，大小只计链接本身。
- 使用异步文件系统 API、服务级共享并发上限、同请求合并和短 TTL 缓存；只保留当前层展示节点，后代仅保留聚合值，并设置最大深度/条目预算，避免大目录扫描长期阻塞或耗尽内存。
- 浏览器只能提交相对路径；服务端 canonicalize 后必须确认目标仍在固定 `~/.pi` 根目录内，并拒绝 symlink 目录下钻；每次读取目录前后重新检查 realpath 与 inode，以发现普通目录替换。
- 威胁模型不把同一 OS 账户下可持续重命名 `~/.pi` 子目录的恶意进程作为安全边界：Node/macOS 没有可用于该扫描器的 handle-relative `openat/readdir` API，而该进程本身已具有相同文件 metadata 读取权限。
- 权限失败、目录竞态、inode 重复、深度或条目预算超限以 partial diagnostics 返回，不使整个页面失败。

### Sessions
- 使用 Pi `SessionManager.listAll()` 建立列表。
- 列表按 session `cwd` 的文件目录逐级构建可折叠树；目录节点展示后代 session 数量和最近更新时间，session 叶节点展示名称、ID、消息数和更新时间。
- 同一目录下 session 按更新时间倒序，目录按名称排序；缺失 `cwd` 的旧 session 归入 `Unknown project`。
- 搜索继续匹配名称、ID、cwd 和消息正文；结果树只保留匹配 session 及其祖先目录并默认展开。
- Sessions 页面使用 master-detail 分栏：左侧目录树，点击 session 后不跳页，右侧异步展示 bounded JSONL header、entries、统计和截断状态；窄屏降级为上下布局。
- 每个 session 叶节点提供 `更多` 菜单，包含重命名与删除。重命名使用 Pi 原生 `session_info` 追加语义，不修改 JSONL 文件名；删除优先进入系统废纸篓，失败后永久删除。
- Session mutation 必须按 ID 重新解析 allowlist、校验 revision、限制名称并通过 same-origin；当前运行 session 的重命名走 runtime `setSessionName` 以同步状态，当前运行 session 禁止删除。
- 浏览器不提交或打开 cwd/session 文件路径。

### Skills
- 正常 Pi Extension 运行时以 `pi.getCommands()` 中 `source === "skill"` 的最终快照为准，展示经过 Pi ResourceLoader 的 settings、packages、CLI、extension resources、用户与可信项目目录合并、过滤和同名去重后的全部生效 Skills。
- 展示名称、description、scope、origin、source、路径和诊断；API 仅映射字段白名单，不返回未知 runtime 对象字段。
- 未注入 Pi runtime 快照时，保留静态目录扫描作为独立 server 测试和降级路径，但不宣称其代表全部生效 Skills。
- 编辑权限与发现来源分离：仅允许创建/修改/删除用户 `~/.pi/agent/skills` 或当前可信项目 `.pi/skills`、`.agents/skills` allowed roots 下的 `SKILL.md`；package、`~/.agents/skills`、祖先 `.agents/skills`、CLI 和 extension 动态 Skill 默认只读。使用 revision compare-and-swap 与原子写入。

### Extensions and packages
- 读取全局和项目 settings，展示 packages 与 extension paths。
- 扫描用户/项目 extension 入口，展示文件和范围。
- V1 不执行 package install/update/remove，不加载 extension 代码。

### Memory Observatory V1.1
- 将 Memory 页面升级为只读流水线观测台：Overview、Jobs、Indexed Sessions、Rollout Memory、Phase 2、Logs。
- Artifacts 不设独立 tab；Overview 固定资源卡片直接进入对应只读文件/目录详情。
- Database/Schema 健康摘要、Pipeline 流程和 Worker Leases 只在 Overview 展示，不设独立 Pipeline tab；其他页面仅在异常或 capability 缺失时显示诊断告警。
- Pipeline 节点时间统一格式化为本地日期时间，不直接展示原始时间戳。
- 通过只读 SQLite 连接展示 `jobs`、`phase1_outputs`、`worker_leases`、`sessions`、`session_scan_state` 的安全字段和派生状态；不执行 migration、checkpoint、VACUUM 或任何写操作。
- `rollout memory` 在 UI 中明确区分 `raw_memory`、`rollout_summary`、物化 `rollout_summaries/*.md` 和集合级 `raw_memories.md`。
- Phase 1 列表只返回 metadata/长度；`raw_memory` 和 `rollout_summary` 仅在用户明确展开后通过独立 bounded endpoint 加载。
- 展示 Phase 2 global job、选择 watermark、selected outputs、物化文件一致性、published artifacts 和 recall usage。
- Memory Overview 固定展示 `memory_summary.md`、`MEMORY.md`、`raw_memories.md`、`rollout_summaries/`、`skills/` 的更新时间、大小或条目数及健康状态；点击进入只读详情。
- 三个 Markdown 文件详情进入页面后直接使用 bounded read 展示只读内容；两个目录详情只枚举 allowlist 范围内的直接/递归文件，点击子文件后直接展示受控文件内容，不设置二次确认按钮。
- Memory 页面不提供文件编辑入口；现有 summary/handbook PUT API 从 Pi Web 移除。
- 永不返回 job `payload`、`ownership_token`、原始 DB 下载或任意非 allowlist 文件。
- DB 缺失或 schema 较旧时返回 capability/availability 降级信息，而不是让整个页面失败。
- summary、handbook、raw memories、rollout summaries、memory skills、SQLite 和 worker log 在 Pi Web 中全部只读。

## API
- `GET /api/overview`
- `GET /api/sessions?q=`、`GET /api/sessions/:id`
- `PATCH /api/sessions/:id`（原生 session_info 重命名）、`DELETE /api/sessions/:id`（受控删除）
- `GET /api/skills`、`GET|PUT|DELETE /api/skills/:id`
- `GET /api/extensions`
- `GET /api/disk-usage?path=<relative>&sort=size|name|modified|type&order=asc|desc&refresh=0|1`
- `GET /api/memory`、`GET /api/memory/:document`
- `GET /api/memory/observatory/overview|workers|jobs|sessions|phase1|phase2|artifacts|logs`
- `GET /api/memory/observatory/phase1/:sessionId`
- `GET /api/memory/observatory/phase1/:sessionId/content?field=rolloutSummary|rawMemory`
- `GET /api/memory/observatory/artifacts/:artifactId/content`
- 所有 `/api/*` 必须验证 Host header；mutation 还必须验证 same-origin。

## Concerns
- Session、tool output 和 memory 可能包含敏感数据，因此服务强制仅 loopback、验证 Host/Origin 且不提供目录自由浏览；任何能访问本机账户的进程仍可访问该控制面。
- 项目 extension 是可执行代码，V1 仅静态枚举，不为展示而加载。
- 跨 Pi 进程写同一 Markdown 使用带存活 PID 检测的 lock file 串行化，并在锁内校验 revision；异常退出留下的 stale lock 会自动回收。

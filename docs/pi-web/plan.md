# Plan: Pi Web V1 + Memory Observatory V1.1（from spec.md 2026-09-11，approved by user）

## Files that change
- 新增 `packages/pi-web/package.json`、`extensions/pi-web.ts`：包和 Pi 生命周期/命令。
- 新增/修改 `packages/pi-web/lib/*.cjs` 与声明：安全路径、catalog、HTTP server、Memory SQLite Observatory 查询与状态派生。
- 修改 `packages/pi-web/public/*`：Control Deck 单页 UI、Memory Observatory 和独立 Disk Usage 导航。
- 新增 `packages/pi-web/lib/disk-usage-core.cjs` 与声明：`~/.pi` 异步递归扫描、缓存、排序、路径安全和诊断。
- 新增/修改 `tests/pi-web-*.test.mjs`：路径、revision、skill/memory、只读 DB、磁盘扫描与 API 路由测试。
- 修改根 `package.json`、`README.md`、`AGENTS.md`：umbrella、安装说明和项目约定。

## Order of work
1. 保留现有 catalog/security core，新增无 Pi runtime 依赖的 Memory Observatory core。
2. 以只读 SQLite 连接实现 Overview、Worker、Jobs、Sessions、Phase 1、Phase 2、Logs API；Artifacts 仅作为 Overview 卡片和详情路由，不设独立 tab。
3. Phase 1 敏感正文和 artifact 正文使用独立 allowlist endpoint 与 bounded read。
4. 实现 Memory Observatory 二级导航、流水线、表格、详情和敏感内容确认。
5. Memory Overview 展示三个文件和两个目录的 metadata；详情页只读展示文件内容或目录条目，移除 summary/handbook 编辑入口与 PUT API。
6. 实现独立 Disk Usage 模块：固定 `~/.pi` 根、异步递归统计、短 TTL 缓存、排序、面包屑和目录下钻。
7. 将 Sessions 平铺表格改为按 `cwd` 路径逐级分组的可折叠目录树；搜索结果保留祖先分支并自动展开，旧 session 归入 `Unknown project`。
8. 将 Sessions 改为 master-detail 分栏；左侧 session 选择在右侧异步加载 bounded JSONL 详情，不跳转页面。
9. 新增 session 更多菜单和受控 mutation：revision/CAS 重命名、废纸篓优先删除、当前 session 删除保护，且不接受客户端路径。
10. Skills 正常运行时改用 `pi.getCommands()` 的 `source === "skill"` 最终快照，按字段白名单映射为 catalog；静态扫描仅保留为无 runtime 注入时的降级路径，编辑权限继续由 allowed roots 独立判定。
11. 跑完整测试、diff check、Pi 加载验证和安全复审。

## Risks
- 最大风险是路径逃逸和把敏感数据暴露到网络；通过强制 loopback、严格 Host 校验、固定资源 ID、realpath containment 和 same-origin mutation 防护。
- Extension reload/session replacement 会关闭并重启 server；V1 使用固定端口，且 close/listen 均幂等。
- `SessionManager.listAll()` 可能扫描较慢；V1 按请求读取，后续可增加短 TTL cache。
- `cwd` 可包含很深路径或 Windows drive/UNC 形式；树构建需规范化分隔符但不得解析、读取或暴露 session 文件 `path`，UI 深层节点需可横向滚动。
- Session rename/delete 与正在运行的 Pi 可能并发；mutation 必须在操作前重新按 ID 查找并核对文件 revision。当前 session 重命名必须委托 runtime `setSessionName`，删除则拒绝；历史 session 重命名使用 `SessionManager.open().appendSessionInfo()`。
- 删除不可逆 fallback 风险较高；确认弹窗需明确说明优先废纸篓、废纸篓不可用时永久删除，并在 mutation 前再次校验 revision。
- Runtime Skill 快照包含 package、CLI 和 extension 动态来源；不得把 `sourceInfo.scope` 等同于可写权限。必须重新通过 canonical path containment 判断是否位于受控 writable root，未知字段不得透传。
- 不采用 React/Vue，避免为本地管理台引入构建链和第三方运行时依赖。
- SQLite 处于 WAL 模式；Observatory 必须使用 SQLite 只读连接读取主库与 WAL 的一致视图，不能只复制或直接解析 `memory.db`。
- DB schema 可能演进；查询层先探测表/列 capabilities，并对缺失字段降级。
- `~/.pi` 可能包含 npm/git 大目录与大量小文件；扫描必须异步、有并发上限、短 TTL 缓存且不跟随 symlink。

## Proof
- `npm test` 全部通过且零失败。
- `git diff --check`。
- 临时 HOME/agentDir 下启动 server，验证 Host/Origin、Skill revision 冲突、summary 校验和静态页面。
- 单元测试覆盖 POSIX/Windows cwd 层次、目录计数和时间聚合、同目录 session 排序、缺失 cwd 归组及搜索后的树剪枝。
- Server 测试覆盖分栏 UI 契约、rename 追加合法 `session_info`、revision 冲突、当前 session runtime 重命名、当前 session 删除拒绝、历史 session 删除及路径不从浏览器输入。
- Skill 测试覆盖 runtime 最终快照过滤、package/settings/CLI/extension source 映射、同名结果按 runtime 保持、字段白名单、只读权限和 Overview 计数；真实 Pi runtime 验证当前生效 Skill 数量。
- 临时 SQLite fixture 验证只读连接、敏感字段不泄露、状态派生、分页、Phase 1 正文按需加载和物化一致性。
- 临时目录 fixture 验证递归大小、隐藏文件、符号链接、排序、下钻、路径逃逸和 partial diagnostics。

# Plan: pi-memory 全局 worker 协调（approved 2026-09-09）

## Files that change
- 修改 `packages/memory/lib/memory-core.cjs` 与 `.d.cts`：增加 SQLite 全局 worker lease 的 claim、heartbeat、release、inspect。
- 修改 `packages/memory/extensions/memory.ts`：启动 worker 前竞争全局 lease；非 leader 不 fork；状态展示全局 owner。
- 修改 `packages/memory/worker/worker.cjs`：按 coordinator token heartbeat，失权停止接活并退出，退出时安全释放。
- 修改 `tests/memory-core.test.mjs`：覆盖并发 claim、有效 lease拒绝、过期接管、旧 token 隔离和主动释放。
- 将 memory DB 语义从 Codex 的 `thread_id/threadId` 统一为 pi 的 `session_id/sessionId`；按用户要求不保留旧 DB 兼容性并删除现有 DB 数据。
- 新增 `sessions` 索引表（一条 pi session/rollout JSONL 一行）；每轮只 UPSERT 当前 session，并从 DB 查询其他 idle session，不再重复扫描和解析全部 JSONL。
- Phase 1 输入预算改为当前模型 `contextWindow` 的 70%；缺失时回退 150,000 tokens，并使用 pi 的 `ceil(chars / 4)` 估算做首尾截断。
- Phase 1 模型调用改由受控 `pi --print` 子进程执行，使用当前 provider/model 的原生 runtime、鉴权和协议；不再硬编码 `/chat/completions`。

## Order of work
1. 在 SQLite 新增独立 `worker_leases` 表和 token-safe core API。
2. Extension 在 session start 和 enqueue 后尝试 leader claim；仅 winner fork worker。
3. Worker 收到有效 token 后运行，定期 heartbeat；失去 ownership 后停止并退出。
4. 正常 shutdown、signal 和 parent disconnect 时按 token 释放 lease。
5. `/memory` 显示全局 leader，而不是只显示当前进程的局部 child 状态。
6. 统一源码、schema、payload 和物化文件中的 session 命名，验证新空库 schema。
7. 不做历史 backfill；只索引启用新版本后实际启动/settled 的 pi session，worker 只用 DB 索引选候选。
8. 将 Phase 1 固定字符预算替换为 context-window token 预算，移除 `PI_MEMORY_ROLLOUT_CHARS`。
9. Phase 1 通过 `pi --print --no-session --no-tools --no-skills --no-context-files` 调用当前 provider runtime，并设置 memory child 防递归环境。
10. 运行单测、跨进程竞争测试和 extension 回归；停止旧 worker 后删除现有 DB/WAL/SHM。

## Risks
- Leader 交接最危险：旧 worker 延迟退出时不能继续 claim jobs，也不能释放新 owner 的 lease。
- 已运行的旧版 worker不认识新 lease；部署后需关闭旧 pi 进程并 `/reload` 或重启。
- 第一个成功 claim 的 session 提供全局 worker 的模型配置；其他 session 不再各启 worker。
- 不采用 PID 文件：PID 可复用，异常退出和不同 DB 路径下难以可靠回收；SQLite lease 与现有 job ownership 模型一致。

## Proof
- `npm test`
- `git diff --check`
- 多进程/多连接竞争：同一 DB 同时只有一个 claim winner。
- 旧 token heartbeat/release 不能影响新 leader；lease 过期和主动释放后可接管。
- 多个 pi session enqueue 时不再各自产生 active worker。
- `/memory` 可观察全局 leader owner 和 lease deadline。

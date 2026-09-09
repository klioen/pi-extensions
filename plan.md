# Plan: 拆分独立 `pi-todo` 与 `pi-plan`（approved 2026-09-08）

## Files that change
- 新增 `packages/todo/`：独立提供 `todo_write` 和 session 状态/history card。
- 新增 `packages/plan/`：独立提供只读 `/plan`、tool gate 和 session 状态恢复。
- 删除 `packages/sdlc/extensions/plan.ts`、`packages/sdlc/lib/plan-core.*`：`pi-sdlc` 只保留 SDLC skills 与 `/init`。
- 修改根 `package.json`：加载 `pi-todo` 和 `pi-plan`。
- 移动 `tests/sdlc-plan-core.test.mjs` 到 `tests/plan-core.test.mjs`，新增 todo core 测试。
- 修改 `AGENTS.md`：记录新的 package 边界和验证要求。

## Order of work
1. 保持 todo 数据模型与 renderer 独立，不向模型上下文写入状态。
2. 将 `/plan` extension/core 原样迁至 `pi-plan`；保留 command、只读 allowlist 与 `/plan off` 行为。
3. session state 新写为 `pi-plan-state`，恢复时兼容旧 `pi-sdlc-plan` entries，避免已有 session 无法启动。
4. 从 `pi-sdlc` 删除 plan 实现，使其只提供 `/init` 和 skills。
5. 跑单测、diff check、TypeScript 和 pi RPC extension discovery；验证 plan mode 禁止 `todo_write` 与写工具。

## Behavior
- `todo_write` 接受 explanation 和最多 20 个带稳定 id 的步骤，状态为 `pending`、`in_progress`、`completed` 或 `blocked`。
- `todo_write` 状态保存在 session JSONL，使用 transcript history card 展示，不写项目文件且不进入模型上下文。
- `/plan` 是只读协作模式，限制为 `read`、`grep`、`find`、`ls`、受限 `bash`；不允许 `todo_write`。
- `/plan off` 恢复进入前的工具集合，不代表实施批准。

## Risks
- 已有 session 仍含 `pi-sdlc-plan`，迁移若不兼容会使恢复路径报错；新 package 必须读取该 legacy custom entry。
- 同时加载新旧 plan extension 会产生重复 `/plan` command；必须移除 sdlc 中的旧 extension 文件。
- 不采用自然语言 `Plan:` / `[DONE:n]` 解析，因为缺乏稳定 id 和可靠的修订语义。

## Proof
- `npm test`
- `git diff --check`
- TypeScript 编译
- pi RPC 发现 `/plan` 与 `todo_write`
- 隔离验证：PLAN MODE 阻止 `todo_write`、`edit`、`write` 和非 allowlisted bash，`/plan off` 恢复工具。

# Plan: 为 pi-sdlc 增加结构化 `update_plan`（approved 2026-09-08）

## Files that change
- 修改 `packages/sdlc/extensions/plan.ts`：注册 `update_plan` 工具、恢复/展示 session 计划状态。
- 修改 `packages/sdlc/lib/plan-core.cjs` 与 `.d.cts`：计划校验、状态迁移、渲染辅助和模型指引。
- 修改 `tests/sdlc-plan-core.test.mjs`：覆盖结构化计划与状态迁移。
- 修改 `AGENTS.md`：记录隔离验证要求。

## Order of work
1. 提交本计划作为批准审计链。
2. 实现纯 core 数据模型与迁移验证。
3. 注册 `update_plan`，把计划写入 session custom entry，并用有限 widget/footer 展示。
4. 保持 `/plan` 只读边界；在普通模式也允许更新进度，但不授予权限或代表批准。
5. 跑单测、TypeScript、RPC discovery 与隔离 session 验证。

## Behavior
- `update_plan` 接受 explanation 和最多 20 个带稳定 id 的步骤，状态为 `pending`、`in_progress`、`completed` 或 `blocked`。
- 同时最多一个 `in_progress`；`blocked` 需要 explanation；已完成步骤不可无说明地回退。
- 状态保存在 pi session JSONL，不写项目 `plan.md`、TODO 文件或代码。
- footer 只显示简短计数；widget 最多显示 5 个步骤，避免占用编辑器空间。
- `/plan off` 不清除计划，也不表示实施批准。

## Risks
- UI 状态可能被误解为正式批准；必须在工具提示、状态文案和 AGENTS.md 中明确它不授权实施。
- 过度频繁更新会造成 session/TUI 噪声；限制步骤数量和 widget 行数，并要求仅在阶段变化时调用。
- 不采用自然语言 `Plan:` / `[DONE:n]` 解析，因为缺乏稳定 id 和可靠的修订语义。

## Proof
- `npm test`
- `git diff --check`
- TypeScript 编译
- pi RPC 发现 `/plan` 与 `update_plan`
- 隔离 session 验证 session entry 恢复、工具只读边界和不创建项目文件。

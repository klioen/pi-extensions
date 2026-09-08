# Plan: 为 pi-sdlc 增加只读协作 `/plan`（approved 2026-09-08）

## Files that change
- 新增 `packages/sdlc/extensions/plan.ts`：纯只读 `/plan [off|status]` 模式、工具限制、session 持久化与状态栏。
- 新增 `packages/sdlc/lib/plan-core.cjs` 与 `.d.cts`：参数、严格只读 bash allowlist、计划提示词和状态归一化。
- 新增 `tests/sdlc-plan-core.test.mjs`：覆盖参数、shell 拦截和提示词护栏。
- 更新 `AGENTS.md`：记录隔离验证要求。

## Order of work
1. 提交本计划，形成审批审计链。
2. 实现并测试纯 core 的参数、命令安全和提示词逻辑。
3. 实现 extension：禁用写工具、二次拦截 bash、注入规划指令、持久化/恢复状态。
4. 执行完整测试、TypeScript 检查与 pi RPC command discovery。

## Behavior
- `/plan` 进入只读协作规划模式；`/plan off` 退出并恢复进入前工具集；`/plan status` 显示状态。
- 只允许 `read`、`grep`、`find`、`ls`、`bash`；bash 只能运行单段 allowlist 中的只读检查命令。
- 只输出可审核方案，不创建 `plan.md`、不修改项目文件、不提供自动执行或 todo 完成追踪。
- 退出 plan mode 不构成对任何实施计划的批准。

## Risks
- 仅靠 system prompt 不能阻止写入；因此采取 active-tool allowlist + `tool_call` shell/write 二次拦截。
- 宽松 bash 正则会被 `;`、重定向、管道或命令替换绕过；core 默认拒绝且拒绝 shell 控制/组合语法。
- 用户手工 `!command` 不属 agent tool call，不由此模式拦截。

## Proof
- `npm test`
- `git diff --check`
- TypeScript 编译
- pi RPC command discovery 出现 `/plan`
- 隔离会话验证 plan mode 工具集与写 shell 拒绝行为。

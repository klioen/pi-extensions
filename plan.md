# Plan: 为 pi-sdlc 增加 Codex 对齐的 `/init`（approved 2026-09-08）

## Files that change
- 新增 `packages/sdlc/extensions/init.ts`：注册 `/init`，将项目感知的初始化任务交给当前 pi agent。
- 新增 `packages/sdlc/lib/init-core.cjs`：参数解析、AGENTS.md 状态判断与初始化 prompt 构建。
- 修改 `packages/sdlc/package.json`：同时暴露 `extensions` 与既有 `skills`。
- 新增 `tests/sdlc-init-core.test.mjs`：覆盖参数、保留既有指令和 prompt 护栏。
- 更新 `AGENTS.md`：记录 pi-sdlc extension 结构与 `/init` 验证方式。

## Order of work
1. 提交本计划，形成用户批准的审计链。
2. 实现并测试纯 core 逻辑。
3. 实现 extension command，调用当前 agent 完成只读勘察和 AGENTS.md 创建/更新。
4. 注册 package extension，补充项目约定。
5. 跑完整单测、TypeScript 检查及隔离手工验证。

## Behavior
- `/init`：若根 `AGENTS.md` 不存在则创建；存在则保留人工规则并增量更新。
- `/init --force`：允许基于实际勘察重写根 `AGENTS.md`。
- 不生成或修改 `CLAUDE.md`；不编造项目命令或规则。
- 无已选模型时显示清晰错误；不假装已完成。

## Risks
- 最大风险是静态模板编造项目命令；因此命令只构造严格任务，要求当前 agent 先只读勘察再落盘。
- 已有 `AGENTS.md` 的人工内容可能被覆盖；默认更新模式明确要求保留，只有 `--force` 可重写。
- 不采用 extension 自行扫描/写静态内容：这种方案无法对齐 Codex 的项目感知 `/init`。

## Proof
- `npm test`
- `git diff --check`
- TypeScript 编译
- 隔离项目中手动运行 `/init`，检查创建内容和既有规则保留行为。

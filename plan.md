# Plan: 清理 OpenViking-memory 残留（approved 2026-09-08）

## Files that change
- 新增 `AGENTS.md`：项目约定、验证命令和改动流程。
- 修改 `packages/env/extensions/env.ts`：删除过时的 `pi-openviking-memory` 注释引用。

## Order of work
1. 提交本计划和项目级约定，保留审批审计链。
2. 删除 env 扩展中唯一的 OpenViking-memory 引用。
3. 搜索残留，并执行测试。
4. 提交清理实现。

## Risks
- 唯一运行时代码风险是误改 `.env` 加载说明；实现仅删过时注释，不修改加载行为。
- 不删除 package，因为只读勘察确认仓库中不存在 `openviking-memory` package 或安装入口。

## Proof
- `git grep -inE 'openviking|viking-memory'` 无输出。
- `npm test` 通过。

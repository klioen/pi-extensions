# Intent: 统一 pi-sdlc 变更文档目录

Author: 用户。 Status: accepted。

## Problem

pi-sdlc 只规定产出 `intent.md`、`spec.md` 和 `plan.md`，没有统一存放位置，导致产物散落在仓库根目录、`docs/` 和 `plans/`，不同变更还会反复覆盖根目录单例文件。

## Proposed outcome

所有 SDLC 产物严格存放在 `docs/<change-slug>/{intent.md,spec.md,plan.md}`。`<change-slug>` 表示独立变更单元；同一目标和交付周期内的方案调整更新原目录，已交付后的新目标、bugfix 或 incident 创建新目录。

## Affected users and systems

- 使用 pi-sdlc 创建、实现、测试、维护和审查变更的开发者与 agent。
- `packages/sdlc/skills/*/SKILL.md`。
- 仓库中已有的 SDLC 文档和自动化测试。

## Constraints

- 禁止在仓库根目录或 `plans/`、`intent/` 等分散目录创建 SDLC 产物。
- 同一变更的三个文档必须位于同一 `docs/<change-slug>/` 目录。
- 迁移旧文档时保留内容和 Git 可追踪性，不伪造历史上不存在的文档。
- 规则必须由自动化测试执行，而不只依赖文字约定。

## Open questions

无。

# Spec: pi-sdlc 变更文档目录

Status: accepted。Source: `docs/pi-sdlc-artifact-layout/intent.md`。

## Requirements

1. 所有新 SDLC 产物必须使用 `docs/<change-slug>/intent.md`、`docs/<change-slug>/spec.md`、`docs/<change-slug>/plan.md`。
2. `<change-slug>` 必须是稳定、可读的 kebab-case 独立变更名称，而不是可被后续任务覆盖的通用单例。
3. 同一目标、同一交付周期内调整方案时更新原目录；已经交付或形成独立验收目标时新建目录。
4. 新功能使用描述性 slug；bugfix 推荐 `fix-<component>-<problem>`；事故修复推荐 `incident-<component>-<problem>`。
5. plan、build、maintain 和 review 阶段必须显式读写对应变更目录中的文档。
6. 禁止在仓库根目录、`plans/`、`intent/` 或其他分散位置创建这些 SDLC 产物。
7. 若历史变更缺少三件套中的任一产物，不得伪造缺失文档，也不得保留不完整目录；直接清理该旧产物，历史内容仍可从 Git 历史追溯。
8. 自动化测试必须检查 pi-sdlc 技能中的规则，并检查本仓库每个 SDLC 目录都恰好包含完整三件套。

## Design

- 在各个 pi-sdlc Skill 中加入一致的“产物路径”规则和路径示例。
- sdlc-plan 负责选择 change slug 并创建 intent/spec；sdlc-build 只在同一目录创建或更新 plan；sdlc-maintain 为 incident/bugfix 创建独立目录；sdlc-review 从变更目录读取基线。
- 在 `AGENTS.md` 固化仓库级约定。
- 使用 Node 内置 `node:test` 添加零依赖结构测试。

## Concerns

- 历史 `plans/pi-lark.md` 只有 plan，没有 intent/spec。为保证严格三件套且不伪造审计记录，直接清理；内容仍可从 Git 历史追溯。

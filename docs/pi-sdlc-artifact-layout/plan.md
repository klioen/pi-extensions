# Plan: 统一 pi-sdlc 变更文档目录

Status: approved by user。

## Files that change

- 修改 `packages/sdlc/skills/sdlc-plan/SKILL.md`、`sdlc-build/SKILL.md`、`sdlc-maintain/SKILL.md`、`sdlc-review/SKILL.md`，统一 `docs/<change-slug>/` 规则。
- 修改 `AGENTS.md`，记录仓库级 SDLC 产物约定。
- 新增 `tests/sdlc-artifacts.test.mjs`，把目录规则变成可执行护栏。
- 将根目录 Pi Web 对话文档迁移到 `docs/pi-web-chat/`。
- 清理不完整的历史 `plans/pi-lark.md` 并删除空的 `plans/`；不伪造缺失的 intent/spec，历史内容由 Git 保留。
- 新增本次变更的 `docs/pi-sdlc-artifact-layout/{intent.md,spec.md,plan.md}`。

## Order of work

1. 迁移旧产物并清理旧路径。
2. 更新四个会创建或读取 SDLC 产物的 Skill。
3. 更新项目约定并增加结构测试。
4. 检索残留宽松规则，运行完整测试并检查 Git diff。

## Risks

- 最大风险是迁移时丢失历史内容；使用文件移动保留原文，并通过 Git diff 检查 rename。
- 另一风险是规则只写在文档中却继续漂移；使用自动化测试扫描 Skill 和受版本控制的产物路径。
- 不为历史上不存在的 pi-lark intent/spec 补写虚假记录；为满足严格三件套，删除其孤立 plan。

## Proof

- `npm test`
- `git ls-files | grep -E '(^|/)(intent|spec|plan)\\.md$|^plans/'`
- 检索 pi-sdlc 中旧的宽松路径表述，结果应为空。

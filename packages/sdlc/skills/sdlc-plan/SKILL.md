---
name: sdlc-plan
description: Start a new feature, requirement, idea, or project change the right way. Use whenever the user describes a new idea, requests a feature, files a ticket-style request, or wants to turn a vague ask into an actionable spec. Produces the intent.md → spec.md artifact chain in git (AI-native SDLC, distilled from Anthropic's playbook).
---

# sdlc-plan — 需求与设计

想法不再等人写文档。意图只捕获一次，存成版本化 artifact（`intent.md`），下一个阶段直接读它行动。

## 适用场景

- 用户提出新想法/新功能/新需求/改造方向
- 需求还是模糊的一句话，需要澄清成可执行的东西
- 从工单、告警、渠道消息过来的诉求需要结构化

## 流程

### Step 1 — 澄清（分析式提问）

向用户提出分析师会问的问题，直到想法具体：

- 现在做不到什么？（问题/痛点）
- 谁受影响？（用户/系统）
- 更好的样子是什么？（期望结果）
- 边界是什么？（不做/超出范围）
- 约束是什么？（技术、合规、PII、性能）
- 成功长什么样？（可验证的指标）

### Step 2 — 产出 `intent.md`

用下面的模板把澄清结果写成 `intent.md`（仓库根 `intent/` 目录或文档目录，随项目约定），提交到 git。

```
# Intent: <简短标题>
Author: <提出人>。 Status: draft。

## Problem
<问题是什么，用原始需求方的话>

## Proposed outcome
<期望的最终结果，可验证>

## Affected users and systems
<受影响用户、团队、系统>

## Constraints
<技术/合规/边界约束>

## Open questions
<待确认问题>
```

### Step 3 — 确认

- 把 `intent.md` 给用户（需求方/负责人）确认，修正误解
- **接受/拒绝**记录为 git 的 merge/close review

### Step 4 — 产出 `spec.md`（需求+设计合一）

被接受的 `intent.md` 进入设计：

1. 读取项目约定（`AGENTS.md`、现有代码结构）
2. 产出 `spec.md`：
   - 需求：把 intent 转成可规划的需求
   - 设计：涉及的系统/模块/接口变更
   - **concern 标记**：无法同时满足的冲突政策、风险点、需要政策负责人裁决的地方，显式标出
3. 设计完成后把 `spec.md` 与 `intent.md` 一起提交（文件对记录"要了什么、定了什么"）

### Step 5 — 人类决策

- `spec.md` 交给负责人/技术负责人 review（高风险变更必须人工）
- **接受 spec = 进入 build 阶段**（触发 sdlc-build）

## 产物与审计

- `intent.md` + `spec.md` 提交进 git（作者、时间戳、修订历史 = 审计链）
- 后续 review（sdlc-review）用 spec 对照"改的是不是被批准的东西"

## 衡量

- 从第一次对话到提交 `intent.md` 的时间（目标：从多周降到几小时）
- 被接受的 intent 占比（vs 被关闭的）

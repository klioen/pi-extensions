---
name: sdlc-maintain
description: >-
  Handle production incidents, alerts, and monitoring anomalies the right way. Use whenever there is
  an on-call issue, a production bug, an alert, a metric breach, a failed CI run, or any "things broke
  in production" situation. Runs deterministic detection with tiered autonomy (log → diagnose → act),
  writes findings back as intent.md to restart the pipeline, and converts each incident into a
  regression eval. Distilled from Anthropic's AI-native SDLC playbook, adapted for pi.
---

# sdlc-maintain — 维护与闭环

循环闭合：触发器无人在调用路径上也能唤起 agent，发现的问题以 `intent.md` 重新进入流水线。

## 适用场景

- 线上事故 / bug / 告警 / 指标越界 / CI 失败
- 需要诊断生产问题、写 post-mortem、把修复送回开发流程

## 流程

### Step 1 — 确定性检测（不含模型）

- 选一个有稳定基线的指标：CI 失败率、部署后 5xx 率、PR 周期
- 检测脚本：滚动窗口的均值/标准差 + 规则（如 Western Electric），抓慢漂移和尖峰
- **检测保持完全确定性，不用模型**；脚本版本化、有单测

### Step 2 — 分层响应（tiered autonomy）

按严重度分层，配置版本化（`bands.yaml` 风格）：

```yaml
metric: ci_test_failure_rate
baseline: rolling_30d
rules: western_electric
tiers:
  1sigma: { action: log }
  2sigma: { action: diagnose, tools: "Read,Grep,Bash(gh run view *)" }
  3sigma: { action: propose, routes: [ pull_request, runbook:rollback-deploy ] }
```

- **1σ**：只记录
- **2σ**：agent 只读诊断
- **3σ**：agent 可行动——但只能开 PR 进 review 门，或触发**预先批准的 runbook**（如回滚）

### Step 3 — 诊断写回 `intent.md`

agent 把诊断写成 `intent.md`（sdlc-plan 的格式）：

- 异常与证据
- 建议结果
- 受影响系统
- 开放问题

从那里，finding 像任何改动一样走完整流水线（plan → build → test → review）。

### Step 4 — 事故 → eval 回归

- 修复上线后，**把事故的复现写成一条 eval**（sdlc-test 的 evals），留在套件里防再犯
- 回滚路径要是流水线里演练最多的：单命令、agent 能跑、定期在 staging 演练

### Step 5 — 人工 triage

- 服务负责人/on-call 工程师 triage 队列：修复 / 排期 / 驳回
- 驳回会调优检测带宽（降低噪音）

## 护栏

- 权限分层来自版本化配置（managed settings 拒绝生产访问）
- 调用、发现、triage 决策带时间戳记录
- agent 触发的 runbook 预先批准过

## 产物与审计

- 事故记录（intent.md + 修复 PR + eval）都版本化
- 检测脚本日志有 breach 时间戳与 tier
- 渠道对话（Slack 等）即审计链：请求、诊断、授权、修复都留在事发处

## 衡量

- breach 到 intent.md 入 triage 队列的时间
- finding 变成 merged fix 的占比
- 同类事故复发率（应随 eval 累积下降）

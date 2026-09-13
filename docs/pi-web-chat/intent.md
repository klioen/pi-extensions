# Intent: Pi Web 对话工作台与整体 UI 重构
Author: 用户。 Status: accepted，architecture revision accepted（2026-09-11）。

## Problem
当前 `pi-web` 定位为本地 Control Deck，只能浏览 Session JSONL、管理 Skills/Extensions/Packages 和查看 Memory，不能在 Web 中直接与当前 pi Session 对话。现有界面采用暗色运维控制台风格，大量使用等宽字体、全大写标题、强边框卡片，与成熟智能体产品的对话体验和信息密度存在差距。

用户希望参考 `/Users/bytedance/Code/volcclaw-monorepo` 中 `apps/arkclaw-enterprise` 的企业服务智能体对话交互和整体 UI 设计，升级 pi-web，但不复制 ArkClaw 品牌、内部组件、业务协议或企业服务耦合。

## Proposed outcome
- pi-web 增加可用的 Web 对话入口，第一阶段面向当前活动 Session：可读取历史、发送消息、流式显示 assistant 输出、展示运行/工具状态并停止当前生成。
- 对话运行时以 `sessionId + runId` 路由事件，明确 `queued/running/done/killed/failed` 状态，处理发送确认前事件、历史加载与实时流并发、快速切换 Session 等竞态。
- Session 页面从 JSONL 检查器升级为会话工作台：左侧浏览项目与 Session，右侧使用文档式消息流展示 user、assistant、tool/toolResult，并在当前 Session 下提供 Composer；技术原始记录仍可按需展开查看。
- pi-web 整体视觉参考企业版 ArkClaw 的布局密度与交互模式：浅色中性工作台、三段式可折叠侧栏、56px 紧凑顶栏、低阴影卡片、清晰空状态、局部滚动和移动端 Drawer。
- 保留 Pi 自身品牌和 Control Deck 能力；Skills、Extensions、Disk Usage、Memory 等现有页面统一迁移到同一套中性设计 token 和组件样式。
- 保留 dark/light/system 主题能力，但以新的浅色视觉作为主要设计基线。
- 将 pi-web 前端从原生 HTML/CSS/JS 重构为可独立发布的 React 技术栈：React 18、TypeScript 5.9、React Router 7、Valtio、Less、Tailwind CSS 4、Vitest，并使用 Vite 构建。
- React 源码与构建产物分离；`packages/pi-web/public/` 保留为 extension server 直接服务的已构建静态产物，使安装后的 pi package 不需要现场编译。

## Affected users and systems
- 使用浏览器管理和操作本地 pi 的开发者。
- `packages/pi-web/extensions/pi-web.ts`：当前 Session、agent lifecycle 与 Web server 的桥接。
- `packages/pi-web/server/server.cjs`：消息发送、停止、事件订阅和现有 REST API。
- `packages/pi-web/src/**`：React 应用壳层、路由、页面、组件、状态和样式源码。
- `packages/pi-web/public/**`：由 Vite 生成并随包发布的静态产物。
- `packages/pi-web/lib/*` 与 `tests/*.test.mjs`：协议纯逻辑、消息归一化、状态机、安全与回归测试。

## Constraints
- 继续仅监听 loopback；写操作必须校验 Host 和同源 Origin，并限制请求体大小。
- 第一阶段只允许 Web 操作当前活动 Session，不直接切换、恢复或写入任意历史 Session。
- 不直接修改 Session JSONL 来伪造对话；消息必须通过 pi 当前 runtime/extension API 进入 Agent 流程。
- 停止操作只发送 abort intent，收到真实终态后才将 run 标记为结束。
- Session JSONL 是最终历史权威源；实时事件用于低延迟显示，终态后按需重新读取历史校准。
- 非当前 Session 的事件不得污染当前视图；所有异步响应落地前检查 active Session。
- 不复制 ArkClaw/ByteClaw/BytePlus 名称、Logo、SVG、字体、内部依赖、企业 BFF、Cookie 鉴权、Claw 实例模型、共享 Agent、云盘、云电脑或 Tea/Slardar 协议。
- 已批准迁移到 React 18、TypeScript 5.9、React Router 7、Valtio、Less、Tailwind CSS 4、Vitest、Vite；这些依赖仅用于前端开发、测试和构建，最终浏览器运行代码必须打包进 `public/`。
- 不引入 EdenX、EMO、`@byted/claw-*`、`@chat-lab/ui`、`@cloud-materials/common`、Starling、Tea、Slardar 或企业内部 workspace 依赖。
- 保留可访问性：键盘操作、焦点态、`prefers-reduced-motion`、移动端可用性；不复制禁止页面缩放的做法。
- 现有 Overview、Sessions、Skills、Extensions、Disk Usage、Memory 能力不得回退。

## Confirmed decisions
- 首版只支持“当前活动 Session 对话”，历史 Session 保持只读；后续再评估从 Web 创建或切换 Session。
- Web 提交消息时，如果 Agent 正在运行，默认以 `followUp` 排队；首版不开放 `steer`。
- 工具调用默认只显示名称和状态，参数与结果折叠，用户主动展开。
- 以浅色作为默认视觉基线，同时保留 Dark/System 主题。
- 首版不提供“新建会话”入口，避免引入 Session replacement 与扩展重载边界。
- 前端技术栈采用可独立发布的等价方案：React 18、TypeScript 5.9、React Router 7、Valtio、Less、Tailwind CSS 4、Vitest、Vite；不直接复制 EdenX/EMO 和企业内部依赖。

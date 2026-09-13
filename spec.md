# Spec: Pi Web 对话工作台与整体 UI 重构
Status: architecture revision accepted（2026-09-11）。Source: `intent.md`（architecture revision accepted 2026-09-11）。

## 1. Goals

1. 在 pi-web 中增加独立 `#/chat` 页面，让浏览器能够与当前活动 pi Session 对话。
2. 支持当前历史加载、用户消息提交、assistant 流式更新、Tool Call 状态、停止生成和终态校准。
3. 将整个 pi-web 重构为 Pi 品牌下的浅色中性工作台，同时保留 dark/system 主题及现有管理能力。
4. 对话传输、运行状态和 React 展示分层，避免把协议、状态机和页面渲染堆入单一入口组件。
5. 将前端迁移为可独立发布的 React 18、TypeScript 5.9、React Router 7、Valtio、Less、Tailwind CSS 4、Vitest、Vite 技术栈。

## 2. Non-goals

- 不从 Web 创建、恢复、fork、切换或删除当前活动 Session；历史 Session 仍为只读浏览对象（现有重命名和非当前 Session 删除能力保持不变）。
- 不提供 `steer`、消息重新生成、附件上传、语音输入、Agent 选择或模型切换。Thinking 展示限制已由 2026-09-12 批准的 raw local Chat content 变更覆盖：展示 pi 提供的 reasoning 文本，不做内容脱敏。
- 不复制 ArkClaw 内部 React 组件、字体、SVG、BFF、实例模型、共享 Agent 或埋点协议。
- 不把 Web server 改成可从局域网访问的服务，不新增鉴权服务。
- 不迁移服务端和 extension 到 React/TypeScript 应用框架；技术栈迁移仅针对浏览器前端。
- 不使用 EdenX、EMO、企业内部 workspace 包、Starling、Tea 或 Slardar；Vite 是独立包的构建替代。

## 3. Reference design mapping

参考实现来自：

- `apps/arkclaw-enterprise/src/pages/Chat/components/ChatShell.tsx`
- `apps/arkclaw-enterprise/src/pages/Chat/components/ChatShell.module.less`
- `apps/arkclaw-enterprise/src/pages/Chat/components/Welcome/*`
- `packages/claw-chat/src/ui/chat/hooks/useChatRuntimeBridge.ts`
- `packages/claw-chat/src/app/chat/session-lifecycle-controller.ts`
- `packages/chat-ui/src/hooks/useClawChat/clawCompletion.ts`

迁移原则：

- 迁移布局密度、交互状态和竞态处理思想。
- 不迁移品牌、业务名词、协议格式和依赖实现。
- pi Session JSONL 对应权威 history；pi extension lifecycle events 对应实时 transport。

## 4. User experience

### 4.1 Application shell

桌面端：

```text
┌──── 240px collapsible sidebar ────┬──────── workspace ────────────┐
│ compact Pi brand                  │ 56px page header              │
│ primary navigation               ├───────────────────────────────┤
│ scrollable recent sessions       │ independently scrolling view  │
│ runtime status / theme           │                               │
└───────────────────────────────────┴───────────────────────────────┘
```

- 侧栏展开 `240px`，折叠 `72px`。
- 顶栏高度 `56px`，显示页面标题或当前 Session 名称、运行状态和页面动作。
- 主内容自行滚动，侧栏和顶栏固定。
- `<= 720px` 时侧栏变成 Drawer；不禁用浏览器缩放。
- 侧栏增加 `Chat` 入口和可滚动 Recent Sessions 区；点击历史 Session 进入 `#/sessions/<id>` 只读详情，不切换 pi runtime。

### 4.2 Visual language

浅色基线：

- 页面背景 `#f7f8fa`
- Surface `#fff`
- Sidebar `#f0f2fa`
- 主文字 `#0c0d0e`
- 次文字 `#42464e`
- 弱文字 `#7a7880`
- Border `#eaedf1`
- Hover/active `#e9e9ef`
- Pi primary 使用中性紫蓝色，不使用 ArkClaw 品牌资产
- 导航与列表圆角 `8px`，卡片 `12px`，面板 `16px`，Composer `24px`

排版：

- UI 使用 system sans-serif；路径、ID、时间、日志和代码才使用 mono。
- 移除大部分全大写 eyebrow 和高字距运维风格。
- 标准正文/列表为 `14px/22px`；辅助信息 `12–13px/20px`。
- 卡片主要依赖浅边框和背景层次，阴影只用于浮层。

主题：

- 默认主题从 dark 改为 light。
- 保留 `light | dark | system`，使用同一组语义 token 映射。
- 继续支持 `prefers-reduced-motion`。

### 4.3 Chat page

`#/chat` 只绑定当前活动 Session。

页面状态：

1. **Unavailable**：没有活动 Session/runtime，显示说明，不展示可用 Composer。
2. **Idle empty**：欢迎标题、提示文案、居中的 Composer。
3. **Idle history**：消息流 + 底部 Composer。
4. **Running**：流式 assistant 内容、工具状态、Composer 可继续输入并以 follow-up 发送，发送按钮切换为 Stop 主动作。
5. **Queued**：用户消息已接受为 follow-up，在消息上标记 queued。
6. **Disconnected/reloading**：SSE 断开时显示非阻塞重连状态，禁止写操作直到 snapshot 恢复。

消息布局：

- Assistant：左侧标识、无大气泡的文档式正文，最大内容宽 `960px`。
- User：右对齐、轻灰背景，最大文本宽 `720px`。
- Tool Call/Result：内嵌 `<details>` 卡片，摘要展示名称、running/done/error；参数与结果默认折叠。
- System/custom/diagnostic：弱化的小号状态行，不伪装为对话消息。
- 原始 JSONL 通过“查看原始记录”入口保留，不作为默认对话展示。

Composer：

- 最大宽 `800px`，普通态最小高约 `120px`，圆角 `24px`。
- textarea 自动增高；`Enter` 发送，`Shift+Enter` 换行。
- 空内容、runtime unavailable 或 SSE 未同步时禁用提交。
- idle 时发送立即触发 turn；running 时固定 `{ deliverAs: "followUp" }`。
- running 时提供 Stop；Stop 只终止当前 agent operation，不清空已排队 follow-up。

## 5. Runtime architecture

### 5.1 Layers

```text
Pi extension adapter
  ├─ captures current session/context
  ├─ pi.sendUserMessage()
  ├─ ctx.abort()
  └─ lifecycle event normalization
             │
             ▼
Pi Web chat event hub
  ├─ monotonic event id
  ├─ bounded replay buffer
  ├─ session/run state
  └─ SSE subscribers
             │
             ▼
HTTP server
  ├─ snapshot/history REST
  ├─ send/abort REST
  └─ SSE stream
             │
             ▼
Browser chat runtime
  ├─ event reducer
  ├─ active-session guard
  ├─ history/stream buffer
  └─ DOM renderer
```

### 5.2 Identity model

Pi lifecycle events do not expose a provider `runId` equivalent。pi-web 因此定义本地 UI run identity：

- `requestId`：浏览器为每次提交生成 UUID，服务端用于幂等和 queued 状态。
- `runId`：extension 在 `agent_start` 时生成 UUID，仅用于该 pi 进程内的实时事件关联。
- `sessionId`：始终取当前 `ctx.sessionManager.getSessionId()`。

所有实时事件至少携带：

```ts
interface ChatEventEnvelope {
  id: number;
  type: string;
  timestamp: number;
  sessionId: string;
  runId?: string;
  requestId?: string;
  data: unknown;
}
```

约束：

- Browser 只把 `sessionId === snapshot.currentSessionId` 的事件应用到当前 Chat view。
- `session_start`、`session_shutdown` 或 current Session ID 改变时发布 `session.changed`，浏览器清空临时 run 并重新加载 snapshot/history。
- `runId` 不写入 Session JSONL，不作为跨重启持久身份。

### 5.3 Run state

```ts
type RunState = "queued" | "running" | "done" | "killed" | "failed";
```

转换：

```text
POST send while idle -> accepted -> agent_start -> running
POST send while busy -> queued -> later agent_start -> running
running -> agent_settled -> done
running -> abort requested -> aborting -> agent_settled -> killed
running -> observed terminal error -> failed
session shutdown/change -> transient run discarded, client reloads snapshot
```

`agent_settled` 才表示无 retry、auto-compaction 或 queued continuation；不能用单次 `agent_end` 作为整个队列完成信号。

因为 pi 的 `sendUserMessage()` 返回 `void` 且内部异步调度，`POST /messages` 返回的是“已被扩展接受”，不是模型已开始运行的确认。真实运行状态由 SSE `run.started` 更新。

### 5.4 Request association

- Server 对 `requestId` 建立有界去重表；同一 ID 重复 POST 返回原 acceptance，不重复调用 `pi.sendUserMessage()`。
- Extension adapter 记录待发送 request FIFO。
- `input` event 中 `source === "extension"` 时，将最早待发送 request 标记为已进入输入链。
- `agent_start` 将最早已进入输入链的 request 绑定到新 `runId`。
- TUI/RPC 触发的 run 没有 `requestId`，仍生成 `runId` 并正常发布事件。
- 关联只用于 UI 状态，不参与 pi 对话语义；终态后由权威 Session history 校准。

## 6. Server API

所有 API 继续执行现有严格 Host 校验。所有非 GET/HEAD 请求继续要求精确同源 `Origin`。

### 6.1 `GET /api/chat/snapshot`

返回当前 runtime 状态：

```json
{
  "available": true,
  "currentSessionId": "...",
  "sessionName": "...",
  "cwd": "...",
  "idle": true,
  "hasPendingMessages": false,
  "activeRun": null,
  "eventCursor": 42,
  "capabilities": {
    "send": true,
    "followUp": true,
    "abort": true,
    "steer": false,
    "createSession": false,
    "switchSession": false
  }
}
```

不返回 Session 文件绝对路径、system prompt、环境变量或 provider credentials。

### 6.2 `GET /api/chat/history`

- 只返回当前 Session 的规范化、bounded history。
- Server 从当前 Session 记录读取；客户端不能提交任意路径或任意 session ID。
- 返回 `sessionId`、`revision`、`truncated` 和 normalized message entries。
- 初始上限沿用 Session 文件 `16 MiB` 读取上限与最多 `2000` records；超限明确标记。
- history 返回可展示消息内容；Assistant thinking block 归一化为 `{ type: "thinking", text }`。本地 Chat 内容不做敏感文本或字段脱敏，但仍受结构和大小限制。

### 6.3 `POST /api/chat/messages`

Request：

```json
{
  "requestId": "uuid",
  "sessionId": "current-session-id",
  "text": "user input"
}
```

规则：

- `requestId` 必须为 UUID。
- `sessionId` 必须与当前 Session 完全一致，否则 `409 SESSION_CHANGED`。
- `text` trim 后不能为空，UTF-8 最大 `64 KiB`。
- idle：`pi.sendUserMessage(text, { expandPromptTemplates: false })`。
- busy：`pi.sendUserMessage(text, { deliverAs: "followUp", expandPromptTemplates: false })`。
- 默认不展开 slash command、Skill 或 prompt template，避免 Web 文本越权触发扩展命令；用户输入按普通消息处理。
- Response `202`：`{ accepted: true, requestId, delivery: "immediate" | "followUp" }`。

### 6.4 `POST /api/chat/abort`

Request：

```json
{
  "sessionId": "current-session-id",
  "runId": "current-local-run-id"
}
```

规则：

- 两个 ID 必须匹配服务端当前 active run，否则 `409 RUN_CHANGED`。
- 调用当前 ExtensionContext 的 `abort()`。
- Response `202` 仅表示 abort intent 已发送。
- SSE 发布 `run.abort_requested`；最终 `run.settled` 才转为 `killed`。

### 6.5 `GET /api/chat/events`

SSE response：

- `Content-Type: text/event-stream`
- `Cache-Control: no-store`
- `Connection: keep-alive`
- 每 15 秒 heartbeat comment。
- 每个事件带 `id:`，支持 `Last-Event-ID`。
- Event hub 保留最近 512 个事件或 5 分钟（先达到者淘汰）。
- Cursor 仍在 buffer 中则 replay；过期则发送 `stream.reset`，客户端重新请求 snapshot/history。
- 每客户端队列和写缓冲有上限；慢客户端主动断开，避免拖垮 pi 进程。
- Server stop/session shutdown 时关闭所有 subscriber。

事件类型：

- `snapshot`
- `session.changed`
- `request.accepted`
- `run.started`
- `message.started`
- `message.delta`
- `message.completed`
- `tool.started`
- `tool.updated`
- `tool.completed`
- `run.abort_requested`
- `run.settled`
- `stream.reset`
- `runtime.error`

事件内容必须经过白名单归一化和单事件大小限制；不直接 `JSON.stringify(event)` 暴露 pi 内部对象。

## 7. Extension integration

`packages/pi-web/extensions/pi-web.ts` 维护最新的 session-bound adapter：

- `session_start`：记录 `sessionId`、cwd、session name、最新 `ExtensionContext`，启动/更新 server bridge。
- `session_shutdown`：先发布 shutdown/session change，再关闭 server 和 SSE clients；旧 context 不得继续使用。
- `input`：仅为 extension-originated Web request 做 request association，不改变输入文本。
- `agent_start`：创建 local `runId`，发布 `run.started`。
- `message_start/update/end`：规范化 user/assistant/toolResult 内容并发布。
- `tool_execution_start/update/end`：发布折叠工具卡片事件。
- `agent_settled`：根据 abort/error 标志发布最终状态并触发 history revision refresh hint。

Server callbacks：

```ts
interface PiWebChatAdapter {
  getSnapshot(): ChatSnapshot;
  getCurrentSessionRecord(): Promise<CurrentSessionRecord | undefined>;
  sendUserMessage(input: { requestId: string; text: string }): ChatAcceptance;
  abort(input: { sessionId: string; runId: string }): void;
  subscribe(listener: (event: ChatEventEnvelope) => void): () => void;
}
```

server 不直接 import 或模拟 AgentSession。

## 8. Browser runtime and build architecture

### 8.1 Source layout

```text
packages/pi-web/
  index.html
  vite.config.ts
  tsconfig.json
  tsconfig.app.json
  tsconfig.node.json
  src/
    main.tsx
    app/
      App.tsx
      router.tsx
      store.ts
    api/
      client.ts
      chat.ts
      resources.ts
    chat/
      runtime.ts
      reducer.ts
      types.ts
      ChatPage.tsx
      MessageList.tsx
      Composer.tsx
      ToolCard.tsx
    layout/
      AppShell.tsx
      Sidebar.tsx
      Header.tsx
    pages/
      OverviewPage.tsx
      SessionsPage.tsx
      SkillsPage.tsx
      ExtensionsPage.tsx
      DiskUsagePage.tsx
      MemoryPage.tsx
    components/
      Card.tsx
      EmptyState.tsx
      StatusBadge.tsx
      Dialog.tsx
    styles/
      tokens.less
      global.less
      utilities.css
  public/                # Vite build output committed/published
```

具体拆分可在实施中微调，但必须保持 API、Chat runtime、页面、布局和共享组件的职责边界，禁止形成新的巨型 `App.tsx` 或 `ChatPage.tsx`。

### 8.2 Technology choices

- React `18.3.x` + React DOM。
- React Router DOM `7.x`，使用 hash router 维持当前 `#/...` URL 与静态 server 兼容。
- Valtio `1.13.x` 管理 session/chat/theme/sidebar 等跨组件状态；请求缓存不额外引入 TanStack Query。
- TypeScript `~5.9`，strict、DOM libs、`jsx: react-jsx`。
- Less 用于组件和设计 token；CSS Modules 默认用于组件样式。
- Tailwind CSS 4 仅用于少量布局 utility，`preflight: false`，避免覆盖现有基础组件语义；主要视觉仍由 Less/token 控制。
- Vitest 4 + jsdom + React Testing Library 测试组件、路由和状态；协议/server 测试继续使用 Node `node:test`。
- Vite 构建，`base: "./"`，输出固定到 `packages/pi-web/public/`，构建前清理旧原生入口产物。

### 8.3 Package and distribution boundary

- React、Valtio、Router 进入浏览器 bundle，但在 `packages/pi-web/package.json` 中作为前端构建依赖管理；安装后的 extension 不从 Node runtime import 它们。
- Vite、TypeScript、Vitest、Testing Library、Less、Tailwind 属 `devDependencies`。
- `public/` 构建产物必须提交并随 npm/git package 发布；`pi install` 后不运行 Vite。
- server 继续只服务 `public/`，不认识 React source，也不启动 dev middleware。
- 开发命令由 `packages/pi-web/package.json` 明确定义，根 package 仅增加代理脚本，不改变其他 package runtime。

### 8.4 Dev proxy

Vite dev server 使用固定 loopback 地址，并将 `/api` 代理到由 `PI_WEB_PORT` 指定的 pi-web server（默认 `8787`）。生产构建继续同源请求，不引入 CORS。

### 8.5 History/stream fence

1. 获取 snapshot，记下 `eventCursor = C` 和 `currentSessionId = S`。
2. 建立 SSE，从 `C` 后开始接收；history 未完成前事件进入 buffer。
3. 获取当前 history。
4. 如果 history 的 session ID 不再是 `S`，废弃结果并重启同步。
5. 渲染 history，再按 event ID 回放 buffer。
6. 收到 `run.settled` 后重新读取 history；权威结果替换对应临时 streaming message。

### 8.6 Reconnect

- EventSource 使用浏览器自动重连，并带 `Last-Event-ID`。
- `stream.reset`、session mismatch 或长时间无 heartbeat 时重新执行完整 snapshot/history fence。
- 同一时间只允许一个 reconnect/sync pipeline；使用 generation token 防止旧请求覆盖新状态。

### 8.7 Rendering safety

- 所有文本默认通过 `textContent` 或现有 `esc()` 输出。
- 首版不引入任意 HTML Markdown renderer；代码/普通文本可做安全的结构化展示，但不得执行模型返回 HTML。
- Tool args/results 使用 `<pre>`，受大小限制并默认折叠。
- DOM 更新只更新对应 message/run 节点，避免每个 token 全量重绘页面。

## 9. Existing page redesign

- **Overview**：保留指标与最近 Session，但采用轻量卡片和统一 12px radius。
- **Sessions**：左侧目录树密度调整；右侧默认显示 Chat-style transcript，原始 header/statistics/JSONL 收入可展开技术详情。
- **Skills**：列表/编辑器功能不变，统一 header、form、dialog 和状态样式。
- **Extensions/Packages**：功能不变，减少强边框表格，强化分组与来源信息。
- **Disk Usage**：保留表格与 breadcrumbs，适配新 token。
- **Memory**：保留现有 observatory 信息架构，统一导航、卡片、详情和日志样式。

所有页面必须继续支持当前搜索、修改、revision conflict、readonly 和错误反馈行为。

## 10. Security and resource limits

- 仅允许 host 为 `127.0.0.1`、`::1`、`localhost`；保持服务器启动时的 loopback hard gate。
- 写请求要求精确 `Origin`；不增加 CORS。
- CSP 继续为 self-only；新增脚本和样式均为本地静态文件。
- 消息最大 `64 KiB`；JSON body 全局仍最大 `1 MiB`。
- SSE 单事件序列化后最大 `128 KiB`；Tool 参数/结果单字段截断并标记 `truncated`。
- Event replay buffer 有数量和时间上限；request idempotency 表有 TTL/容量上限。
- 不通过 API 暴露 Session JSONL 文件定位信息或 system prompt；Chat 消息、reasoning 和 Tool 内容按原始本地数据返回，不做敏感内容脱敏。服务仍受 loopback、Host/Origin、CSP 和资源上限约束。
- Web 能触发当前 Agent 使用已有工具，这是显式能力，不宣称它是只读 UI；页面应显示“Local agent access”状态。

## 11. Error semantics

新增稳定错误码：

- `CHAT_UNAVAILABLE` → 503
- `SESSION_CHANGED` → 409
- `RUN_CHANGED` → 409
- `INVALID_CHAT_MESSAGE` → 400
- `MESSAGE_TOO_LARGE` → 413
- `DUPLICATE_REQUEST` → 返回原 acceptance（非错误）
- `SSE_REPLAY_EXPIRED` → SSE `stream.reset`

浏览器收到 409 时不自动重发消息，先重同步并保留草稿，避免对新 Session 重复执行任务。

## 12. Files expected to change

- `intent.md`：记录已确认需求和技术栈修订。
- `spec.md`：本规格。
- `plan.md`：build 阶段文件级迁移计划。
- 根 `package.json`：增加 pi-web 前端 build/typecheck/test/dev 代理脚本和构建发布门禁。
- 根 lockfile：锁定新前端依赖。
- `packages/pi-web/package.json`：前端 runtime/dev dependencies、Vite/Vitest scripts 和发布文件边界。
- 新增 `packages/pi-web/index.html`、`vite.config.ts`、TypeScript/Tailwind/PostCSS/Vitest 配置。
- 新增 `packages/pi-web/src/**` React/TypeScript 应用源码、Less/CSS Modules 和测试。
- `packages/pi-web/extensions/pi-web.ts`
- `packages/pi-web/server/server.cjs`
- `packages/pi-web/server/server.d.cts`
- `packages/pi-web/lib/pi-web-core.cjs`
- `packages/pi-web/lib/pi-web-core.d.cts`
- 新增 `packages/pi-web/lib/chat-core.cjs`
- 新增 `packages/pi-web/lib/chat-core.d.cts`
- `packages/pi-web/public/**`：由 Vite 重新生成；移除手写 `app.js`、`chat-runtime.js`、`chat-view.js` 和对应手写 CSS 入口。
- `tests/pi-web-core.test.mjs`
- `tests/pi-web-server.test.mjs`
- 新增 `tests/pi-web-chat-core.test.mjs`

具体组件文件可在 build 勘察后缩小，但不得把 chat runtime 堆入单一 React 组件或 `server.cjs`。

## 13. Verification and acceptance criteria

### Automated

运行统一验证命令：

```bash
npm test
npm run pi-web:typecheck
npm run pi-web:build
```

三者必须零失败。新增测试至少覆盖：

1. chat event envelope 白名单和大小截断。
2. run 状态合法转换及 abort 终态。
3. request ID 幂等，重复 POST 不重复发送。
4. idle immediate 与 busy follow-up 分支。
5. 非当前 Session、过期 run、空消息、超长消息拒绝。
6. SSE event id、replay、expired reset、heartbeat 和断开清理。
7. history 只能读取当前 Session；消息、reasoning 和 Tool 内容保持原文，并继续验证结构、条数和大小上限。
8. extension 注册正确 lifecycle hooks，并调用 `sendUserMessage`/`abort`。
9. 现有 Sessions、Skills、Memory、Disk Usage API 和 UI 回归测试继续通过。
10. 静态 CSP 不允许外部脚本/样式。
11. React Router 各 route、Sidebar 折叠、Recent Sessions、主题持久化和移动 Drawer。
12. Chat reducer 的 pre-ack、follow-up、SSE reset/replay、history fence、Tool details 和 abort。
13. Vite build 产物仅引用相对本地 assets，且 server 可正确提供 hashed JS/CSS。

### Manual after `/reload` or restart

1. 打开 `/web`，确认默认浅色工作台和所有原页面可达。
2. 在 TUI 与 Web 间交替发送消息，Web 可实时显示当前 Session 内容。
3. Web idle 发送立即运行；running 发送显示 queued，并在当前 run settled 后执行。
4. Stop 后等待真实 aborted/settled 状态，不产生虚假 completed。
5. 工具调用默认折叠，展开后内容有界；assistant 流式内容不卡住页面。
6. 快速刷新、断开网络再连接、切换/新建 TUI Session 时不串会话、不重复发送。
7. 终态后 history 校准，刷新浏览器得到一致对话。
8. 720px 以下侧栏为 Drawer，Composer、消息和所有管理页面仍可操作。
9. light/dark/system 切换和刷新持久化正常。

## 14. Concerns requiring implementation discipline

- **Concern: pi 没有原生 runId。** 本地 `runId` 只能用于 Web 实时关联，不能被描述为 provider 或持久 run identity。
- **Concern: `pi.sendUserMessage()` 是 void。** HTTP 202 只能表示扩展接受请求；必须靠 lifecycle event 确认实际运行。
- **Concern: abort 是当前 agent 级操作。** 当前 context 的 `abort()` 不接受 runId；服务端必须先严格比对当前 local run，避免陈旧页面误停新任务。
- **Concern: follow-up 可能在当前 run settled 前后形成连续 agent 流程。** 使用 `agent_settled` 和 request FIFO，不以单次 assistant message 完成判断全局 idle。
- **Concern: 前端技术栈迁移可能造成已有页面功能回退。** 必须按 route 逐页迁移，并在删除原生入口前完成 React 行为测试和 API contract 回归。
- **Concern: 构建产物与源码可能漂移。** `npm test` 必须验证 `public/` 是由当前源码构建生成且工作树无额外产物差异；发布前强制 build。
- **Concern: package 安装只安装生产依赖。** extension runtime 不得 import 任何前端依赖；安装后的 server 只依赖已提交 `public/`。

# Plan: Pi Web React/TypeScript 技术栈迁移（from accepted architecture revision, 2026-09-11）

Status: implemented；ChatKit-equivalent conversation flow enhancement approved（2026-09-12）。

## Files that change

### Package and build configuration
- 修改根 `package.json`
  - 保留 `npm test` 作为全仓统一测试入口。
  - 增加 `pi-web:dev`、`pi-web:build`、`pi-web:typecheck`、`pi-web:test`。
  - `npm test` 串联现有 Node `node:test` 与 pi-web Vitest，确保迁移后仍是一条健康命令。
- 新增根 `package-lock.json`
  - 锁定新增前端依赖，保证本地、CI 和 git package 安装一致。
- 修改 `packages/pi-web/package.json`
  - `dependencies`：`react@18.3.x`、`react-dom@18.3.x`、`react-router-dom@7.x`、`valtio@1.13.x`。
  - `devDependencies`：Vite、TypeScript 5.9、Vitest 4、jsdom、React Testing Library、Less、Tailwind CSS 4、PostCSS、React 类型。
  - 声明 build/dev/typecheck/test scripts 和 `files` 发布边界。
- 新增 `packages/pi-web/vite.config.ts`
  - `base: "./"`。
  - 输入 `packages/pi-web/index.html`。
  - 输出到 `packages/pi-web/public/`，构建前清理旧产物。
  - dev server 仅监听 loopback，将 `/api` 代理到 `PI_WEB_PORT` 或 `8787`。
  - Vitest 使用 jsdom、setup file 和 CSS Modules。
- 新增 `packages/pi-web/tsconfig.json`、`tsconfig.app.json`、`tsconfig.node.json`。
- 新增 `packages/pi-web/postcss.config.cjs`、`tailwind.config.ts`。
  - Tailwind 4，`preflight: false`，只扫描 `src/**/*.{ts,tsx}`。
- 新增 `packages/pi-web/index.html`
  - Vite 开发入口，仅保留 root、meta、无外部资源。

### React application foundation
- 新增 `packages/pi-web/src/main.tsx`
  - 创建 React root，加载全局 Less/Tailwind 样式。
- 新增 `packages/pi-web/src/app/App.tsx`
  - Provider 与 Error Boundary 装配，不承载具体页面逻辑。
- 新增 `packages/pi-web/src/app/router.tsx`
  - 使用 `createHashRouter` 或等价 React Router 7 Hash Router。
  - 保持 `#/overview`、`#/chat`、`#/sessions/:id?`、`#/skills/:id?`、`#/extensions`、`#/disk/*`、`#/memory/*`。
- 新增 `packages/pi-web/src/app/store.ts`
  - Valtio 管理 theme、sidebar、connection、recent sessions 和全局 toast/dialog 状态。
  - localStorage 读写集中处理，避免组件散落访问。
- 新增 `packages/pi-web/src/api/client.ts`
  - 同源 fetch、JSON envelope、稳定错误类型、AbortSignal 和连接状态。
- 新增 `packages/pi-web/src/api/types.ts`
  - REST/SSE payload 的前端类型，不复制 server 私有对象。
- 新增 `packages/pi-web/src/styles/tokens.less`、`global.less`、`utilities.css`。
  - 迁移现有 Pi-native light/dark token。
  - Tailwind utilities 与 Less 共存，禁止 preflight 覆盖。

### Shared layout and components
- 新增 `packages/pi-web/src/layout/AppShell.tsx`
- 新增 `packages/pi-web/src/layout/Sidebar.tsx`
- 新增 `packages/pi-web/src/layout/Header.tsx`
  - 三段式侧栏、240/72px 折叠、Recent Sessions、56px 顶栏、移动 Drawer。
- 新增 `packages/pi-web/src/components/**`
  - `Card`、`StatusBadge`、`EmptyState`、`LoadingState`、`ErrorState`、`Dialog`、`ToastRegion`、`DefinitionList`、`DataTable`。
  - 组件职责单一，用户数据始终作为 React text node 渲染。
- 每个组件使用同目录 `*.module.less`；通用 token 不重复定义。

### Chat migration
- 新增 `packages/pi-web/src/chat/types.ts`
- 新增 `packages/pi-web/src/chat/reducer.ts`
  - 迁移现有 history tool merge、pre-ack reconciliation、run/tool/message 状态。
  - 保持纯函数，便于 Vitest 覆盖。
- 新增 `packages/pi-web/src/chat/runtime.ts`
  - snapshot/history/SSE fence、generation guard、512 event buffer、指数退避、Session guard、send/abort。
  - EventSource 生命周期由 React hook 管理，但 runtime 不依赖 React。
- 新增 `packages/pi-web/src/chat/useChatRuntime.ts`
  - 创建/销毁 runtime，将状态桥接给组件。
- 新增 `packages/pi-web/src/chat/ChatPage.tsx`
- 新增 `packages/pi-web/src/chat/MessageList.tsx`
- 新增 `packages/pi-web/src/chat/Composer.tsx`
- 新增 `packages/pi-web/src/chat/ToolCard.tsx`
  - Tool 默认折叠，展示原文且有界的 details。
  - textarea 自动高度、Enter 发送、Shift+Enter 换行、Stop、409 草稿保留。
- 新增对应 `*.module.less` 和 `*.test.ts(x)`。

### Existing route migration
- 新增 `packages/pi-web/src/pages/OverviewPage.tsx`
- 新增 `packages/pi-web/src/pages/SessionsPage.tsx`
  - 项目目录树、Chat-style transcript、折叠原始 JSONL、重命名/删除。
- 新增 `packages/pi-web/src/pages/SkillsPage.tsx`
  - 列表、详情、revision 编辑与删除。
- 新增 `packages/pi-web/src/pages/ExtensionsPage.tsx`
- 新增 `packages/pi-web/src/pages/DiskUsagePage.tsx`
  - breadcrumbs、排序、刷新、partial diagnostics。
- 新增 `packages/pi-web/src/pages/MemoryPage.tsx` 与 `memory/**`
  - Overview、Jobs、Indexed Sessions、Rollouts、Phase 2、Logs、Artifact detail。
- 每个页面新增 focused Vitest/RTL 测试；不依赖真实网络。

### Build output and server integration
- 重建 `packages/pi-web/public/**`
  - Vite 生成 `index.html` 和 hashed `assets/*`。
  - 删除旧手写：`app.js`、`chat-runtime.js`、`chat-view.js`、`app.css`、`chat.css`。
- 修改 `packages/pi-web/server/server.cjs`
  - 保持 REST/SSE 不变。
  - 静态资源 Content-Type 支持 Vite 产物（如 `.map`、字体若后续使用）。
  - SPA hash route 无需 history fallback；根入口继续服务 `public/index.html`。
- 修改 `tests/pi-web-server.test.mjs`
  - 删除对旧手写源码字符串的断言。
  - 改为验证 manifest/构建产物、local hashed assets、CSP 和 server serving。
  - 保留 Chat/server/security 全部行为测试。

### Tests and documentation
- 新增 `packages/pi-web/src/test/setup.ts`。
- 新增 Chat reducer/runtime、router/layout、各页面关键交互测试。
- 迁移当前 VM browser tests 到 Vitest，删除测试中读取旧脚本文本执行的 helper。
- 修改 `AGENTS.md`
  - 记录新的已验证命令、源码/产物边界和“修改前端必须同步 build public”的规则。
- 保留 `intent.md`、`spec.md`；实现偏离时同步更新本 `plan.md`。

## Order of work

### Phase 1 — Establish the toolchain without deleting the old UI
1. 在 `packages/pi-web/package.json` 和根 `package.json` 增加 scripts/dependencies。
2. 运行 `npm install` 生成根 lockfile；检查 production runtime dependency 边界。
3. 新增 Vite/TS/Vitest/Less/Tailwind 配置和最小 React `index.html`/`main.tsx`。
4. 写基础 smoke test，验证 Hash Router、jsdom 和 CSS Modules 可用。
5. 构建到临时目录或配置临时 outDir，暂不覆盖当前 `public/`，证明 toolchain 工作。

### Phase 2 — Migrate API, state, layout, and shared primitives
6. 先迁移 API client/types 和 Valtio global store，并写错误、abort、theme/sidebar persistence 测试。
7. 实现 AppShell、Sidebar、Header 和共享组件；用 RTL 覆盖桌面折叠、Recent Sessions、移动 Drawer、主题。
8. 建立 route skeleton，所有现有 URL 可导航，尚未迁移的页面显示明确占位而不是回退到原生 DOM。

### Phase 3 — Migrate Chat with behavior parity first
9. 将原生 Chat runtime 拆成 `reducer.ts` 和 `runtime.ts`；先移植当前 VM 测试为 Vitest。
10. 确认 pre-ack、follow-up、多 agent_start、SSE reset/replay、bounded buffer、history fence、abort 全部 green。
11. 实现 ChatPage/MessageList/ToolCard/Composer；用 RTL 覆盖发送、停止、草稿保留、Tool 折叠和 route unmount cleanup。
12. 与现有 Node server fake 做 API contract 测试，不改变 server schema。

### Phase 4 — Route-by-route migration
13. 迁移 Overview 和 Sessions，先保证当前会话与历史只读边界。
14. 迁移 Skills，验证 revision conflict 和 readonly。
15. 迁移 Extensions/Packages 和 Disk Usage。
16. 迁移 Memory 全部子路由与 sensitive-content confirmation。
17. 每迁移一页运行该页测试和全量前端测试，禁止最后一次性补测试。

### Phase 5 — Cut over build output
18. 所有 React routes 通过后，将 Vite outDir 切到 `public/`。
19. 删除旧手写前端文件，执行生产 build 生成 hashed assets。
20. 更新 server 静态资源测试和 CSP 断言；确认无 CDN、无绝对路径、无 source 内容泄露。
21. 更新根 `npm test` 串联 Node 与 Vitest，并增加 `pi-web:typecheck`/`pi-web:build`。
22. 更新 `AGENTS.md` 与 package 发布文件边界。

### Phase 6 — Review and verification
23. 三遍式 review：Bugs、Security、Compliance against accepted spec。
24. 运行全部 proof 命令；修复后重复直到零失败。
25. `/reload` 或重启 pi，真实浏览器验证全部 route、Chat 流、reload、mobile 和 theme。

## Risks

### Highest-risk step
删除旧原生入口并切换 Vite build output 风险最高。若 React route 尚未完整迁移就清理 `public/`，现有管理功能会整体回退。必须在临时 outDir 完成所有行为测试后才能 cut over。

### What may break
- Vite 依赖或 assets 路径不是相对路径，导致 pi server 下资源 404。
- `npm install --omit=dev` 后构建产物缺失或 package `files` 未包含 `public/`。
- React StrictMode/Effect 重挂载导致重复 EventSource、重复 POST 或 listener 泄漏。
- Hash Router route 与当前手写 route 参数编码语义不同。
- Valtio snapshot 被错误传给需要 proxy 的 API，导致状态不更新。
- Tailwind preflight 或 Less 全局样式覆盖表格、textarea、dialog 和现有可访问性。
- 页面迁移时遗漏 Memory sensitive confirmation、Skill revision conflict、Session 当前项删除保护等非视觉行为。
- 构建产物提交后与源码漂移。

### Rejected alternatives
- **直接复制 EdenX/EMO 配置**：依赖内部 registry、workspace 和发布基础设施，不适合独立 pi package。
- **直接依赖 `@byted/claw-*` / `@chat-lab/ui`**：这些不是本仓库可独立发布的稳定依赖，并会引入企业业务协议。
- **React CDN/UMD**：违反 self-only CSP、离线和可复现安装要求。
- **server-side JSX/SSR**：当前是本地控制台，不需要 SSR，会扩大 extension runtime 依赖面。
- **一次性重写后再补测试**：无法证明当前 145 项行为没有回退。
- **不提交 `public/`，安装后现场 build**：pi package production install 不保证 devDependencies，启动延迟和失败面不可接受。

## Approved enhancement — Full ChatKit-equivalent session experience（2026-09-12）

### Files that change
- 扩展 `packages/pi-web/src/chat/ConversationFlow*`，形成实时 Chat 与历史 Session 共用的消息、工具、错误和动作渲染层。
- 新增安全 Markdown 与代码块组件，支持 GFM 风格正文、链接、表格、引用、inline/fenced code 和复制；不允许原始 HTML。
- 修改 `MessageList*` 为 ChatKit-equivalent live viewport：流式跟随、用户上滚后停止跟随、scroll-to-bottom、完成后高度校正。
- 修改 `Composer*` 和 `ChatPage*`：hero/compact 两种布局、loading skeleton、welcome、Chat 子 header、running 时空草稿 Stop/有草稿 follow-up。
- `SessionsPage` 继续复用同一 ConversationFlow，但保持只读、无 live region、无自动滚动、无 runtime。
- 修改 React tests 覆盖 Markdown/Copy、消息错误、工具组状态、follow-up 主按钮、滚动、loading/empty 和 live/read-only renderer 一致性。
- 重新生成并提交 `packages/pi-web/public/`。

### Order of work
1. 先写失败测试锁定 Markdown、消息动作/错误、ToolGroup 生命周期、running follow-up 按钮、scroll-to-bottom 和 loading/empty 行为。
2. 实现共享 Markdown/message primitives，统一 `960px` thread、`720px` user、`800px` composer 的尺寸体系和 ChatKit 消息节奏。
3. 实现紧凑 ToolGroup：运行中自动展开、完成后自动收起；步骤时间线中再按项展开 arguments/result。原“隐藏 reasoning”要求已被后续 raw local Chat content 变更取代。
4. 实现 live/readonly viewport 分层：实时页负责 auto-follow 与回底按钮，历史页仅复用 renderer。
5. 实现 compact/hero Composer 和 Chat 页面状态；running 时空草稿 Stop、有草稿 Send follow-up，鼠标与键盘语义一致。
6. 保持现有 REST/SSE、Session guard、幂等、followUp、abort 和服务边界不变；Chat 内容脱敏要求已被后续 raw local Chat content 变更取代。
7. 执行 focused tests、全量测试、typecheck、生产 build、committed-public drift check 和 package audit。

### Risks
- Markdown 会扩大渲染面；必须禁用 raw HTML，外链使用 `noopener noreferrer`，代码/表格限制宽度。
- 扁平化 pi history 不保留 ChatKit 原始 assistant content-part 边界；采用相邻 Tool 的确定性分组，不伪造缺失结构。
- ToolGroup 状态变化必须在 running 时展开、terminal 后收起，同时保留用户在稳定状态下的手动操作。
- 最危险的是实时滚动逻辑抢占用户阅读位置；必须用 near-bottom/follow 状态和显式回底按钮测试。
- 历史 Session 不得复用 live viewport，否则会产生 aria-live 大量播报和错误自动滚动。

### Proof
- Assistant Markdown、代码复制、用户气泡、消息时间/复制与消息内错误符合共享 renderer 行为。
- Tool group 运行态展开、完成态收起，原始参数/结果位于二级详情；原“reasoning 不显示”验收已被后续变更取代。
- running 时空草稿按钮 Stop，有草稿按钮 Send 且产生 follow-up；Enter/Shift+Enter/IME 保持正确。
- live viewport 自动跟随但尊重用户上滚，并提供 scroll-to-bottom；readonly viewport 无实时行为。
- Loading skeleton 与 empty hero composer 互斥，连接/错误状态位于 Chat 子 header。
- Chat 和历史 Session 使用相同共享 renderer，无内部企业依赖。
- `npm test`、`npm run pi-web:typecheck`、`npm run pi-web:build`、`npm run pi-web:verify-public`、`npm audit`、`git diff --check` 全部通过。

## Proposed enhancement — Projects navigation and session chat workspace（2026-09-12）

Status: implemented（2026-09-12）。

### Files that change
- `packages/pi-web/src/api/types.ts`、`api/resources.ts`
  - Session summary 正式声明 `cwd` 与服务端不透明 `projectId`；加载全部 Session 并按完整 cwd 归并 Projects，不再截断 Recent Sessions。
- `packages/pi-web/src/app/store.ts`
  - 将 sidebar 的 recent-session 状态重构为 project catalog 状态。
- `packages/pi-web/src/layout/Sidebar.tsx`、`Sidebar.module.less`、`AppShell.test.tsx`
  - 将 `Recent sessions` 改为 `Projects`；每个去重 cwd 是一个入口，显示目录 basename 与父路径辅助文本。
- `packages/pi-web/src/pages/SessionsPage.tsx`、`SessionsPage.module.less`、`CorePages.test.tsx`
  - 删除完整目录树；按选中的完整 cwd 过滤并展示扁平 Session 列表。
  - 点击 Session 后，右侧直接渲染共享 `ConversationFlow` 只读 Chat。
  - 保留搜索、rename/delete、当前 Session 禁删、详情重试和技术摘要。
- `packages/pi-web/src/app/router.tsx` / route tests（如需）
  - 保持 `#/sessions/:id?`，使用 `?project=<opaque projectId>` 持久化 Project 选择和刷新状态，避免把绝对 cwd 写入浏览器历史。
- `packages/pi-web/public/**`
  - 重新生成生产资产。

### Order of work
1. 先写失败测试：sidebar 显示全部去重 Projects；点击 Project 更新 route；Sessions 页只展示所选 Project 的 Session；点击 Session 后右侧直接展示 Chat。
2. 扩展公共 Session 类型和 project grouping helper，由服务端基于完整 cwd 生成稳定不透明 Project ID，缺失 cwd 归入 `Unknown project`。
3. 将 Sidebar 从 recent sessions 改成 project catalog，并保持 loading/error/mobile drawer/collapsed 行为。
4. 重构 Sessions 页为“该 Project 的 Session 列表 + 右侧只读 Chat”；删除递归目录树 UI。
5. 保持现有 Session 搜索、route-param 同步、rename/delete、revision conflict 和安全 history 行为。
6. 执行 Bugs/Security/Compliance review，重建 committed `public/` 并跑完整验证。

### Risks
- cwd 可能包含用户目录信息；仅在 loopback UI 的 Project 标签/标题中按功能需要显示，URL query 使用不透明 Project ID。
- 搜索结果可能暂时不包含 route 中已选 Project；页面需显示空列表而不是自动跳到其他 Project。
- Project 与 Session route 状态必须单向同步，避免点击 Session 后列表刷新覆盖选择。
- 不能直接复用 live `MessageList`，历史 Chat 仍只共享 `ConversationFlow`，避免 aria-live 和自动滚动。
- 目录数量可能较多；侧栏必须独立滚动、去重并稳定排序，不截断数据。

### Proof
- Sidebar 只显示唯一 Projects，覆盖全部 Session cwd；不再出现 `Recent sessions`。
- 点击 Project 只显示该目录的 Sessions，刷新 URL 后选择仍保留。
- 点击 Session 后右侧直接显示共享 Chat renderer，不显示完整目录树。
- Search、rename/delete、当前 Session 保护和详情错误恢复测试继续通过。
- `npm test`、`npm run pi-web:typecheck`、`npm run pi-web:build`、`npm run pi-web:verify-public`、`npm audit`、`git diff --check` 全部通过。

## Proof

### Dependency and package boundary
```bash
npm install
npm ls --all
npm pack --dry-run --workspace packages/pi-web
```

检查 tarball 包含 extension/server/lib/public，不依赖源码构建即可运行；不包含 node_modules、测试缓存或企业内部依赖。

### Automated verification
```bash
npm test
npm run pi-web:typecheck
npm run pi-web:build
git diff --check
```

健康输出：
- Node `node:test` 全部通过。
- pi-web Vitest 全部通过。
- TypeScript 无错误。
- Vite production build 成功。
- build 后 `git diff --exit-code -- packages/pi-web/public`，证明产物已同步。

### Static safety checks
```bash
rg -n "ArkClaw|ByteClaw|BytePlus|@byted|@cloud-materials|@chat-lab|https?://" \
  packages/pi-web/src packages/pi-web/public packages/pi-web/package.json
rg -n "eval\(|new Function|dangerouslySetInnerHTML" packages/pi-web/src
```

预期无品牌、内部依赖、CDN、动态代码执行或未经批准的原始 HTML 注入。

### Manual after reload/restart
1. `/web` 打开 React 版 Control Deck，所有 assets 从 loopback 本地加载。
2. 所有旧 route 和 deep link 可用，刷新不会白屏。
3. Chat idle、follow-up、Stop、Tool 折叠、SSE reconnect 和 pi reload 行为与迁移前一致。
4. Sessions、Skills、Extensions、Disk Usage、Memory 全部功能与错误态不回退。
5. Sidebar 折叠/Projects、light/dark/system、移动 Drawer 和键盘操作正常。
6. 浏览器 Network 无外部资源请求；Chat 内容按后续 raw local Chat content 变更保留原文，其他页面仍遵守各自的数据最小化约束。

## Approved fix — Session history active branch and large-file tail（2026-09-12）

### Files that change
- 修改 `tests/pi-web-core.test.mjs`：先锁定完整 `id`/`parentId` 树只选择最后 leaf 的祖先链，排除 abandoned branch，并验证旧无 `parentId` 记录保持线性兼容。
- 修改 `tests/pi-web-server.test.mjs`：先复现超过 16 MiB 的历史 Session 必须返回尾部最新消息。
- 修改 `packages/pi-web/lib/pi-web-core.cjs` 与 `pi-web-core.d.cts`：新增并声明 `selectActiveSessionBranch(records)`。
- 修改 `packages/pi-web/server/server.cjs`：历史 Session detail 使用已有 `readSessionDocumentTail`，再按 active branch 投影后标准化展示；compaction 仅作为上下文边界数据，不伪装成对话消息。

### Order of work
1. 增加 core/server 回归测试并运行 focused Node tests，确认 abandoned branch 与大文件尾记录用例失败。
2. 参考 pi session-manager 的 `buildSessionPath`：仅当所有记录均具备有效 `id` 和显式 `parentId` 时，从最后记录反向追溯；旧格式或混合格式原样线性返回。
3. server detail 改用 tail reader，并在 `normalizeSessionChatHistory` 前选择 active branch。
4. 重跑 `node --test tests/pi-web-core.test.mjs tests/pi-web-server.test.mjs` 与 `git diff --check`。

### Risks
- 尾部窗口可能缺少较早祖先；应保留从最后 leaf 到窗口内可追溯的链，而不能回退并混入 abandoned branch。
- 旧 Session 没有 `parentId`；严格树选择会误删历史，因此必须整体线性兼容。
- compaction summary 是模型上下文检查点，不是用户/assistant 原始对话；展示层继续只接受真实 message 与显式可展示 custom_message。
- 不复制 pi runtime 的 compaction 上下文消息转换，以免把 summary 伪装为聊天内容。

### Proof
- `node --test tests/pi-web-core.test.mjs tests/pi-web-server.test.mjs`
- `git diff --check`

## Proposed cleanup — Sessions conversation-only workspace（2026-09-12）

Status: implemented（2026-09-12）。

### Files that change
- `packages/pi-web/src/pages/SessionsPage.tsx`
- `packages/pi-web/src/pages/SessionsPage.module.less`
- `packages/pi-web/src/pages/CorePages.test.tsx`
- `packages/pi-web/public/`（由 Vite 重建）

### Order of work
1. 先更新测试，断言 Sessions 内容区不存在 PageHeader/Search sessions，右侧对话不存在 View technical details。
2. 删除内容区重复的 Sessions/cwd PageHeader、query/submittedQuery、搜索表单及 `/api/sessions?q=` 请求分支；始终使用全量 Session catalog 按 Project 过滤。
3. 删除技术详情 disclosure 及其 Statistics/Diagnostics UI，保留 Chat、Session 详情标题、bounded/truncated 状态和服务端契约。
4. 删除失效样式和仅服务搜索竞态的测试，保留 rename/delete、路由同步、详情 retry 与 mutation 并发保护。
5. 运行 pi-web 测试、typecheck、build、public drift 和完整 `npm test`。

### Risks
- mutation 完成后仍需刷新全量 catalog，不能因删除搜索状态而破坏 rename/delete 后列表更新。
- 不改 Session detail API，避免影响其他调用方或未来诊断用途。
- 删除顶部 actions 后需保持 PageHeader 和工作区间距正常。

### Proof
- 页面内容区不存在重复的 `Sessions`/cwd PageHeader、`Search sessions` 输入框和 Search 按钮；AppShell 全局路由标题仍保留。
- 页面中不存在 `View technical details`、Statistics 和 Diagnostics disclosure。
- Project 过滤、Session Chat、rename/delete、route canonicalization 与 retry 测试通过。
- `npm test`、`npm run pi-web:typecheck`、`npm run pi-web:build`、`npm run pi-web:verify-public`、`git diff --check` 全部通过。

## Approved polish — Narrower Project session list（2026-09-12）

Status: implemented。

### Files that change
- `packages/pi-web/src/pages/SessionsPage.module.less`
- `packages/pi-web/public/`（由 Vite 重建）

### Change
- 桌面端 Session 列表栏从 `minmax(280px, 36%)` 收窄为固定 `260px`，右侧 Chat 使用剩余宽度。
- `max-width: 800px` 的移动端仍保持单列全宽。

### Proof
- pi-web tests、typecheck、build、public drift 与 `git diff --check` 通过。

## Proposed polish — Remove Chat horizontal scrolling（2026-09-12）

Status: implemented（2026-09-12）。

### Files that change
- `packages/pi-web/src/chat/ConversationFlow.module.less`
- `packages/pi-web/src/chat/ConversationFlow.test.tsx` 或对应样式回归测试
- `packages/pi-web/src/chat/ChatPage.module.less`
- `packages/pi-web/src/pages/SessionsPage.module.less`
- `packages/pi-web/public/`（由 Vite 重建）

### Order of work
1. 增加回归断言，锁定 Chat 外层不产生横向滚动，宽 table/code 内容必须在消息宽度内换行。
2. 为 live Chat、共享 ConversationFlow 和历史 Session detail 补齐 `min-width: 0` 与 `overflow-x: hidden`。
3. Markdown table 改为容器内固定布局，th/td 允许长内容换行；code block 改为 `pre-wrap` 和任意长 token 换行，取消内部横向滚动。
4. 保留纵向滚动、代码复制、Tool 折叠及移动端布局。
5. 运行 pi-web tests、typecheck、build、public drift、完整 `npm test` 与 `git diff --check`。

### Risks
- 代码行会折行，视觉上不再保持原始单行宽度，但这是彻底移除横向滚动条的必要取舍。
- 表格列宽在窄屏下会压缩；通过固定布局和单元格换行避免页面撑宽。
- 不能用全局 `overflow: hidden` 误伤纵向滚动，因此仅隐藏 x 轴。

### Proof
- Chat 与历史 Session Chat 不出现横向滚动条。
- 长 URL、长代码、宽表格和 Tool 数据不会撑宽 Chat。
- 纵向滚动、代码复制、Tool 展开和移动端测试继续通过。
- `npm test`、`npm run pi-web:typecheck`、`npm run pi-web:build`、`npm run pi-web:verify-public`、`git diff --check` 全部通过。

## Proposed enhancement — Show Pi reasoning in Chat（2026-09-12）

Status: superseded by raw local Chat content request（2026-09-12）。

### Files that change
- `packages/pi-web/lib/pi-web-core.cjs` 与声明（历史 Session 安全归一化）
- `packages/pi-web/lib/chat-core.cjs`（reasoning SSE allowlist）
- `packages/pi-web/extensions/pi-web.ts`（实时 thinking events）
- `packages/pi-web/src/chat/types.ts`
- `packages/pi-web/src/chat/reducer.ts` 与测试
- `packages/pi-web/src/chat/ConversationFlow.tsx`、样式与测试
- `tests/pi-web-core.test.mjs`
- `tests/pi-web-chat-core.test.mjs`
- `tests/pi-web-extension.test.mjs` / server contract tests
- `packages/pi-web/public/`（由 Vite 重建）

### Order of work
1. 先写失败测试：历史 Assistant `thinking` block 被安全保留；实时 `thinking_start/delta/end` 形成独立 reasoning message；ConversationFlow 展示可折叠“思考过程”。
2. 历史归一化把 `{type:"thinking", thinking:string}` 转成 `{type:"thinking", text:string}`，保留原始文本并继续执行长度、数量和结构限制。
3. 扩展监听 pi 的 `thinking_start`、`thinking_delta`、`thinking_end`，按 contentIndex 发布独立 reasoning message；事件类型仍使用固定字段 allowlist，但允许字段中的内容保持原文。
4. reducer/history converter 将 reasoning 保持为独立消息，不混入 Assistant 最终答案或复制文本。
5. ConversationFlow 增加 ChatKit 风格“思考过程”折叠块：运行中默认展开，完成后默认收起，内容用共享 Markdown 渲染。
6. 运行安全/协议/前端测试、typecheck、build、public drift、完整 `npm test`、audit 与 `git diff --check`。

### Risks
- Reasoning 可能包含路径或凭据；本地原文模式明确允许这些内容进入 REST/SSE/DOM。
- 不尝试解码 provider 未提供为文本的加密 payload；provider 已提供的 thinking 文本按原文显示。
- thinking 与 text 使用同一 Assistant message id 时可能互相覆盖；实时协议需使用稳定的独立 reasoning id。
- 流式 reasoning 完成后折叠状态切换不能因 React remount 丢失用户手动展开状态。

### Proof
- 历史和实时 Chat 均展示“思考过程”；当前运行时立即显示“思考中”，正文在最终安全判定后显示。
- 完成后的 reasoning 默认收起，用户可展开查看 Markdown；Reasoning 不进入 Assistant 正文复制。
- reasoning、Assistant 文本和 Tool 内容中的路径、凭据及其他允许字段按原文进入 REST/SSE/DOM，并继续受结构和大小限制。
- 现有 Tool、Markdown、Chat scroll、follow-up、历史只读行为不回退。
- `npm test`、`npm run pi-web:typecheck`、`npm run pi-web:build`、`npm run pi-web:verify-public`、`npm audit`、`git diff --check` 全部通过。

## Approved change — Raw local Chat content（2026-09-12）

Status: implemented。

### Scope
- 移除 Chat 历史、实时文本、reasoning、Tool arguments/results 的内容脱敏和敏感字段过滤。
- `redacted: true` 的 thinking 如果包含文本，也按原文展示；不尝试解码不存在的加密文本。
- 保留数据类型 allowlist、长度/深度/条数限制、循环对象截断、loopback、Host/Origin、CSP、SSE 客户端与 replay 上限。
- 同步修改 spec 中 Chat 内容脱敏与隐藏 reasoning 的约束。

### Proof
- REST history、SSE 与 DOM 保留原始路径、凭据字符串和 Tool 字段。
- reasoning 仍保持 contentIndex 顺序、折叠行为与当前/历史共享渲染。
- `npm test`、typecheck、build、public drift 与 `git diff --check` 通过。

## Approved polish — Minimal Chat message chrome（2026-09-12）

Status: implemented。

### Files that change
- `packages/pi-web/src/chat/ConversationFlow.tsx`
- `packages/pi-web/src/chat/ConversationFlow.module.less`
- `packages/pi-web/src/chat/ConversationFlow.test.tsx`
- `packages/pi-web/public/`（由 Vite 重建）

### Order of work
1. 更新组件测试，锁定普通消息不显示 `Pi` / `You` 标签和消息级 Copy 按钮；代码块 Copy 保持不变。
2. 移除普通消息角色标签、clipboard 状态和消息级 Copy 逻辑。
3. 将时间戳和 queued 状态移到卡片底部元信息区；默认隐藏，仅在消息 hover 或 focus-within 时显示。
4. 保持正文、Markdown、错误、reasoning、Tool 及触屏无 hover 时默认隐藏行为不变。
5. 运行前端测试、typecheck、生产 build、完整测试和 public drift check。

### Risks
- 移除角色文字后需要继续依赖气泡位置和样式区分 user/assistant；现有左右布局保留。
- 时间戳默认隐藏不能破坏语义 DOM，仍保留 `<time>`，通过 CSS 控制可见性。
- 不应误删 fenced code 自身的 Copy 功能。

### Proof
- 普通消息中无 `Pi`、`You` 和 `Copy message`。
- 时间戳位于正文后的底部元信息区，默认不可见，hover/focus-within 可见。
- queued 状态仍可在底部元信息中展示。
- reasoning、Tool、Markdown、代码复制和历史只读行为测试继续通过。

## Approved polish — Unified reasoning and tool expansion width（2026-09-12）

Status: implemented。

### Files that change
- `packages/pi-web/src/chat/ConversationFlow.module.less`
- `packages/pi-web/src/chat/ConversationFlow.test.tsx`
- `packages/pi-web/public/`（由 Vite 重建）

### Change
- 思考过程和执行过程折叠时统一为 `min(560px, 100%)`。
- 两者展开时统一为 `min(var(--chat-thread-width, 960px), 100%)`。
- 两者使用相同的宽度过渡；reduced-motion 下统一禁用过渡。
- 保持现有自动展开/折叠和手动切换行为。

### Proof
- 样式测试锁定 reasoning/tool 的折叠宽度、展开宽度和过渡行为。
- ConversationFlow 交互测试、完整 Pi Web 测试、typecheck、build 和 public drift 全部通过。

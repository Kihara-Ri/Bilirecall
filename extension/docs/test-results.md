# BiliRecall 测试结果

## 审查整改验收 — 2026-09-20

针对「逻辑 / 流程 / 错误处理 / 安全 / 商店发布标准」的审查整改：每项都先复现、再修、再验证。

| 项 | 复现证据 | 修复后证据 |
| --- | --- | --- |
| 笔记栏打不出空格 | 旧构建下 `ui-audit` 新增的 popup/note-draft 检查 FAIL：`draft="不要被刷新冲掉的草稿"`（空格被吞） | 同一条检查 PASS：`draft="不要 被刷新 冲掉的 草稿"`、`draftWithSpace="不要 被刷新 冲掉的 草稿 尾"`；`tests/notes.test.ts` 7 项 |
| 外部请求无超时（AI / Notion / 封面 / Webhook / 字幕 CDN） | 代码审查：只有 bili、relation 带 `AbortSignal.timeout` | `tests/timeouts.test.ts` 5 项：把 `AbortSignal.timeout` 换成 10ms 真实触发中止，断言各自上限与可读错误，并断言每个上限 < `SYNC_TIMEOUT_MS` |
| Webhook 占着记录锁 + 静默失败 | 代码审查：`postWebhook` 在 `withRecord` 内 await，失败只写 `console.log` | 锁外发送 + 检查状态码；`options/webhook` 浏览器用例：申请 `https://hooks.example.com/*`，界面提示「Webhook 已收到测试消息（HTTP 200）」 |
| 本地模型（`http://127.0.0.1`）无法授权 | `optional_host_permissions` 只有 `https://*/*`，`request()` 对未声明的 origin 静默返回 false | manifest 补 `http://localhost/*`、`http://127.0.0.1/*`；`tests/manifest.test.ts` 断言声明与设置页可请求的模式一致 |
| 页面桥接可被同源脚本伪造 | 代码审查：`postMessage` 只校验 `source` 字段 | `content/heartbeat` 浏览器用例：伪造的无 BV 号快照、字符串 aid 的 page-video 均未进入后台；`tests/bridge.test.ts` 11 项（伪造 bvid 不得匹配记录、非 bilibili.com 域名的动作端点被拒） |
| 心跳每 10 秒写库，暂停也不停 | 代码审查 + `records-revision` 每次写入都变 | 浏览器用例断言 `contentWatch=[10,30]`（暂停的重复心跳不产生第二条消息）；`tests/watch.test.ts` 心跳去重 2 项 |
| `stats` 每 1.5 秒重读整份归档 | 代码审查：`repo.list()` 无缓存 | `tests/stats.test.ts`：同一版本号下 3 次调用只读 1 次，版本号变化后重读 |

已运行通过（`extension/` 内）：

- `npm run verify`：26 个测试文件、219 项测试，类型检查与生产构建通过。
- `npm run e2e`：真实加载 MV3 扩展，61 项断言通过（含并发、去重、异常场景）。
- `npm run ui-audit`：弹窗 / 阅读页 / 工作区布局与对比度审计通过；新增 `content/heartbeat`、`options/webhook` 用例；工作区 31 项交互通过。
- 发布标准（`tests/manifest.test.ts`）：权限逐项对应到实际 Chrome API 调用、无 `cookies`、无 `<all_urls>`、图标四尺寸真实像素校验、描述长度、无 `eval` / 无远端代码。

## 独立审查补充验收

- 跨记录并发插入/删除共享索引与旧记录收录边界两条集成回归均先失败后通过。真实MV3进一步验证20条记录并发保存/删除后索引完整，以及旧历史补全点赞后仍不进入知识库或 `sync-all`。
- `npm run verify`：21个测试文件、183项测试全部通过，类型检查与生产构建通过。
- `npm run e2e`：当前主流程55项及新增6项并发/异常场景通过（61项）；新增脚本为 `scripts/concurrency-test.mjs`。
- `npm run ui-audit`：工作区检查及笔记占位交互通过。提示与输入在同一首行，点击提示获得焦点，输入/清空/切换分类及自动保存正常。
- Notion延迟回包期间保存笔记、删除记录：修复前浏览器测试同时复现覆盖与复活，修复后通过。
- 正在执行AI流水线时删除：等待记录锁释放后完成删除，后台不能复活记录。
- 删除后历史任务恢复及再次刷新：新增单元回归修复前失败，持久删除标记修复后通过。
- 互动接口错误响应携带零值，以及投币字段为null/空串/false：不得保存为可靠否定；六条空值回归先失败后通过。
- 浏览器只使用受控协议夹具，不访问真实账号。最终补充结果以本节为准，下文保留此前验收记录。

## 1.1.0 工作区重设计验收 — 2026-09-13

环境：macOS arm64 / Node22.22 / Vitest5 / Playwright Chromium。

| 验收项 | 已验证证据 |
| --- | --- |
| 三入口、默认历史、无全局统计 | 工作区浏览器脚本 + 真实扩展E2E |
| 日期分组、真实时间、分P续播、未知互动 | history.test.ts + history-sync.test.ts + E2E |
| 超过40条自动导入、持久游标续传、来源合并 | history-sync.test.ts：60条、多次实例恢复、并发启动 |
| 旧历史/笔记保留、不自动入处理队列 | history-sync.test.ts + 新导入library.saved=false契约 |
| 点赞/投币/收藏筛选、本地移除与知识隔离 | 工作区31项交互检查 |
| 保存成功才提示、失败重试、关闭保留配置 | 工作区浏览器故障注入 |
| 窄屏、大量记录、更新不跳滚动位置 | 390/768/1280px + 85条浏览器夹具 |
| 原字幕、AI、Notion及分享状态无回归 | E2E51项；同步修复过期对象写回竞态 |
| 配置与版本 | package/lock/manifest/dist均1.1.0；Chrome120+，未新增权限；4个新/调整消息契约匹配 |

已运行通过：

- `npm run verify`：21个测试文件、174项测试，类型检查与生产构建通过。
- `npm run ui-audit`：原弹窗/阅读页与新工作区对比度和布局审计通过；工作区31项交互通过。
- `npm run e2e`：真实加载MV3扩展，55项断言通过。
- `npm run dev -- --smoke`：浏览器提供的bundle哈希由 `c41120cf37e1` 变为 `a92799af4462`，无需手动重载；自检后恢复生产构建。
- `git diff --check`：通过。

### 历史页「筛选点几次就卡住」排查与修复 — 2026-09-13

现象：历史记录页在「全部 / 点赞过 / 投币过 / 收藏过」之间点几次后，卡在一个选项上再也点不动。

| 环节 | 结论与证据 |
| --- | --- |
| 复现条件 | 用真实扩展 + 真实归档（从其 Chrome「Profile 1」复制 `Local Extension Settings` 到临时 profile，只读）反复点击24次、快速连点12次、滚动、开行菜单、模拟同步进行中（状态running + 每2秒推进归档版本）均未卡住；hit-test 显示筛选按钮没有被任何元素遮挡 |
| 已证实的冻结机制 | 渲染期抛一次异常，Preact 没有错误边界 → 整棵视图停止更新，DOM 停在最后一次成功渲染的状态，后续点击全部失效。构造 `history.watchedAt = 1e300` 即可复现：`new Date(x).toISOString()` 抛 `RangeError: Invalid time value`，历史页渲染出 0 个筛选按钮 |
| 同类风险点 | 历史页原本直接读 `steps.notion.pageId`、`userNotes.highlights.length`、`archive.origins.includes(...)`：早期版本写下的记录少这些字段时同样是「一抛就冻」 |
| 修复 | ① `src/lib/time.ts`：所有时间戳过 `safeTime`，坏值当未知（`—`），排序分组同步加固；② `HistoryView` 每行包 `RowGuard` 错误边界，坏记录只跳过自己那一行，筛选栏与其余记录继续可用；③ `normalizeRecord` 补齐缺失的 `steps`（notion 是后加的）并清洗时间戳；④ `inLibrary` / `historyGroups` 不再假设嵌套字段存在 |
| 顺带修掉的真数据 bug | 单项接口失败（如风控 `code=-412`）时 `data` 是默认的 `0 / false`，原来会被当成「确认没点过」写进归档；现在只信 `code=0`，否则抛「未能确认」。relation.test.ts 的 3 项失败断言即为该契约 |
| 轮询开销 | 旧轮询每2秒搬整份归档：实测其真实归档 `list-records` 单次约 1.2 秒（191条 / 5.7MB）。改为 `history-poll`（状态 + 归档版本号，1–4毫秒），归档没变就不重读记录；手动「更新历史」后立即重读一次 |

浏览器实测（1280×900，真实归档 191 条）：`history-poll` 1–4ms；模拟同步进行中连续点击12次筛选，最大 57ms、无遗漏、无长任务。

浏览器测试使用协议夹具，未使用真实账号凭据；不将其声称为真实登录账号在线联调。完整设计与数据契约见 [history-workspace.md](history-workspace.md)。

---

以下为旧版验收记录，保留历史参考。

日期：2026-09-12 ｜ 环境：macOS arm64 / Node 22.22 / TypeScript 7 / Vitest 5 / Chromium (Playwright)

## 1. 静态检查与构建

```text
$ npm run typecheck      # tsc --noEmit        → 无错误
$ npm run build          # esbuild             → dist/ (background 40KB, popup 19KB, options 27KB, content, inject, icons)
```

## 2. 单元 / 集成测试：84 passed

```text
 ✓ tests/watch.test.ts     (5)
 ✓ tests/pipeline.test.ts  (7)
 ✓ tests/events.test.ts    (9)
 ✓ tests/relation.test.ts  (7)
 ✓ tests/hash.test.ts      (4)
 ✓ tests/store.test.ts     (7)
 ✓ tests/export.test.ts    (4)
 ✓ tests/subtitle.test.ts  (16)
 ✓ tests/notion.test.ts    (5)
 ✓ tests/bili.test.ts      (10)
 ✓ tests/protobuf.test.ts  (4)
 ✓ tests/wbi.test.ts       (4)
 Test Files  12 passed (12)
      Tests  84 passed (84)
```

覆盖的关键断言：

- **字幕一致性（核心修复）**：同一 BV/CID 仅调换轨道顺序，旧 `subtitles[0]` 取到不同语言；新算法两次都返回同一 `track id`。
- **一致读取**：两次独立读取不同则抛 `UnstableSubtitle`；服务器每次返回不同正文时连续重试到上限后放弃，不返回正文。
- **身份校验**：播放器返回的 `bvid/aid/cid` 与请求不一致 → `IdentityMismatch`（防止拿到别的视频）。
- **登录语义**：`need_login_subtitle` → `LoginRequired`；`nav` 返回 `-101` 时仍能取到 WBI 密钥。
- **签名 URL 过期**：403 时刷新**同一条轨道**并成功下载，`player` 只被调用一次。
- **protobuf 回退**：播放器无轨道时解析 `/x/v2/subtitle/web/view`。
- **可疑 URL**：匿名 protobuf 返回的 `//subtitle.bilibili.com/%01%1B%5C=...` 被拒绝。
- **时长裁剪**：越界 AI 字幕被裁剪并产生警告。
- **WBI**：mixin key 与真实 `nav` 一致（`ea1db124af3c7062474693fa704f4ff8`）；固定时间戳的 `w_rid` 与独立实现（node:crypto MD5）逐字节相同。
- **Notion**：data source 标题属性自动发现、只写存在的属性、超过 90 block 自动分批。
- **导出**：YAML frontmatter、JSONL、bundle 文件清单；导出里**不再出现任何分数**。
- **B站 操作状态**：`relation` 一次读回三态；字段变化时退到三项单项接口并带警告；-101 报「未登录」而不是编一个状态；每个接口都不可用时明确失败。
- **数据迁移**：schema 1/2 的 `value: {like, coins, favorite, share, score, reasons}` 迁移成 `actions`，分数被丢弃、投币数裁剪到 0–2，迁移后存储里不再有 `score`。

## 3. 真实网络探针（无 Cookie）：`node scripts/live-probe.mjs`

```json
{
  "nav": { "isLogin": false, "hasWbiKeys": true },
  "playerWbiV2": { "endpoint": "/x/player/wbi/v2", "identityEchoMatches": true, "needLoginSubtitle": true, "tracks": [] },
  "legacyPlayerV2": { "code": 0, "aid": 117104095268420, "cid": 40960721402, "needLoginSubtitle": true, "subtitleCount": 0 },
  "subtitleProto": { "trackCount": 1, "tracks": [{ "language": "ai-zh", "label": "中文" }] },
  "resolveSubtitle": { "errorName": "LoginRequired", "message": "B站要求登录后才能读取该视频的字幕（need_login_subtitle）" }
}
```

结论：WBI 签名被真实服务端接受，身份回显一致；匿名情况下扩展正确地报“需要登录”，而不是“没有字幕”。带登录态的完整字幕下载只能在用户浏览器内验证——这正是把实现放进扩展的原因。

## 4. 处理流程、操作状态与阅读页（`npm run e2e`，35 项）

真实 Chromium 加载扩展（含 `--load-extension`），六个场景 + 界面冒烟全部通过：

| 场景 | 断言 |
| --- | --- |
| 字幕稳定 | 真实标题/UP主 被捕获；两读一致；正文精确；队列清空 |
| 字幕每次不同（Bug 复现） | 拒绝采信；错误报在「字幕」这一步；后续步骤不执行；重试超过单次读取 |
| **操作状态来自 B站** | 页面只做了点赞 + 分享；记录里 `coin=2`、`favorite=true` **只可能来自 API 读取**；`relation.source === "api"`；分享保持本地观察 |
| **B站 状态读取不可用（-101）** | 保留本地回显，`relation.source === "local"` 且写明「未登录」，不假装已同步 |
| AI 步骤失败（HTTP 500） | 字幕成功保留；错误报在「AI 摘要」这一步；Notion 步骤不动；没有创建页面 |
| 字幕 → AI → Notion 全流程 | 三步依次成功；摘要落库；Notion 拿到页面 URL；只创建 1 个页面 |
| **阅读页** | 2 段字幕全部渲染；摘要与提纲/关键点渲染；搜索「第二」把列表过滤到 1 条；点「下载 SRT」真的下载到 `BV1xx411c7mD.srt`，内容是 `00:00:00,000 --> 00:00:01,000` 的真实时间轴 |
| **设置页自检** | 「测试 B站 状态读取」回显命中的接口与 `点赞=true 投币=2` |

### 本轮修掉的另一个真问题

**同一视频的并发写入会互相覆盖**：点赞与分享在同一 tick 到达时各自「读 → 改 → 写」，后写的把先写的字段覆盖回去（E2E 里表现为「分享」丢失）。现在按记录 key 串行化读改写（`withRecord`），并把这条断言留在 E2E 里。

### 上一轮修复的三个问题

1. **标题/UP主 显示为编号或未知**：读取 `__INITIAL_STATE__` + 挂钩 `wbi/view`，后台改用 **WBI 签名**请求 `/x/web-interface/wbi/view`（未签名会被风控返回错误页）。E2E 曾观察到测试泄漏到真实 API 并取回真实标题，随后把 E2E 改成默认拒绝外部请求。
2. **观看进度跨视频串号**：B站 是 SPA，`maxSeconds` 之前从不重置；现在按视频归零，统一用 `computeProgress`，**≥90% 才算看完**。
3. **一步失败拖垮全部**：现在 `steps.subtitle / steps.analysis / steps.notion` 三个独立状态，失败停在该步并显示原因。

## 5. 这次的四项改动

| 要求 | 实现 | 证据 |
| --- | --- | --- |
| 字幕预览 + 全部字幕页面 + 下载 | 弹窗内嵌 2 行预览 + 「查看全部 N 段字幕」；`viewer.html` 渲染全文幕（可搜索、超长分批）、AI 摘要、笔记；下载 SRT / TXT / Markdown / JSON | E2E「阅读页」4 项 + UI 审计 `cues=3` |
| AI 摘要可见 | 弹窗 2 行摘要预览 + 「查看完整摘要 · N 个关键点」；阅读页展示完整摘要 + 提纲 + 关键点，摘要过期会标注 | UI 审计 `previews=2`；E2E 摘要断言 |
| 与 B站 一致的操作图标 + 状态来自 API | 复刻形状的 SVG 图标（点亮=填充+配色，未点亮=描边）；状态由 `/x/web-interface/archive/relation` 读回，失败自动退到三项单项接口 | E2E 两项（API 为源 / 不可用时报明）；UI 审计 `actionsLit=4`、`signalsNote=0`，断网分支 `actionsLit=2`、`signalsNote=1` |
| 去掉「价值信号」 | 删除 `score` / `reasons` / `isValuable` / `autoSyncMinScore` / 价值分属性 / 进度条；触发条件改为「发生过任一操作或写了笔记」 | 单元测试断言导出与 Notion 里不再含分数；UI 无 meter |
## 6. 界面验收（`npm run ui-audit`，16 个视图）

真实 Chromium 渲染每个视图后测量，而不是靠肉眼：

```text
PASS  popup [light]              height=596  actionsLit=4  signalsNote=0  previews=2  steps=3
PASS  popup/local-state [light]  height=555  actionsLit=2  signalsNote=1  steps=3
PASS  options/records·notion·ai·capture·export [light]  worstContrast=4.83
PASS  viewer [light]             cues=3
PASS  popup + 6 tabs + viewer [dark]  worstContrast=5.36
all UI checks passed
```

| 检查 | 结果 |
| --- | --- |
| 渐变 | 0 处（background-image 不含 gradient） |
| 对比度 | 全部 ≥ 4.5:1（亮色最低 4.55，暗色最低 4.89） |
| 横向溢出 / 元素裁剪 | 无 |
| 兄弟元素重叠 | 无 |
| 弹窗高度 | **596px**（Chrome 上限 600）：视频卡 + 三步流程（含字幕与摘要预览）+ 随手记一屏可见，无需滚动 |
| 操作图标 | 正常态 4 个点亮、无「状态来自本机」提示；退化为本地状态时 2 个点亮且提示出现 |
| 预览渲染 | 字幕预览 + 摘要预览都存在 |
| 阅读页 | 时间轴条目渲染、对比度与溢出正常 |
| 样式表加载 | 亮/暗均确认设计 token 生效 |

**上一轮审计抓到的真实 bug**：`build.mjs` 只拷贝了 `public/`，没有把 `src/styles.css` 放进 `dist/`，因此扩展此前是**完全无样式**渲染的（旧的 E2E 只断言元素存在）。已修复，并在 E2E 里加了回归检查 `ui: stylesheet applied (not unstyled)`。

## 7. 尚未验证 / 边界

| 项目 | 状态 |
| --- | --- |
| **带登录态的 `relation` 字段名** | 无 Cookie 时真实接口返回 `-101 账号未登录`（已实测），登录后的字段按文档与容错解析实现（`coin` / `multiply` 都接受）。E2E 用 mock 覆盖了成功与退化两条路径；**最终确认请在设置页「抓取规则 → 测试 B站 状态读取」点一次**，它会显示命中的接口与读回的值 |
| 分享状态 | B站 服务端不保存「我分享过」，只能记本地观察，UI 已如实标注 |
| 真实 Notion 写入 | E2E 用 mock 校验请求体；真实 token / 属性名需要用户自己的数据库 |
| 真实 AI 端点 | 同上，`pingAi` 需要用户先授权该域名 |
| 超大视频 | 阅读页一次渲染 300 段时间轴，其余按需加载；未做虚拟滚动 |
| 其他页面类型 | 番剧 / 课程 / 合集页的 content script 匹配已声明，只做过普通视频页的端到端验证 |

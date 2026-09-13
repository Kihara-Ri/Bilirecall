# BiliVault 测试结果

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

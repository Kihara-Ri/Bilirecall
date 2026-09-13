# BiliVault · B站 → Notion 知识库（Chrome 扩展）

把你在 B站**点赞 / 投币 / 收藏 / 分享**过的视频，自动沉淀成可检索的知识：

1. 用你浏览器里的登录态读取视频信息与字幕（**修好了“同一 BV/CID 拿到不同字幕”**）；
2. 抓取时做**多次一致读取校验**，不确定就标记待复核，绝不把可疑正文写进 Notion；
3. 可选调用任意 OpenAI 兼容模型生成摘要 / 提纲 / 关键点；
4. 通过 Integration Token 写入 Notion（支持 data source 数据库或页面）：标题 / 视频ID / UP主 / 日期 / Summary / 我的记录分列写入，带上封面，字幕正文按段落合并（补标点、去时间轴）。Notion 是**可选**的：关掉自动同步后流程里不出现该步骤，摘要整理好点「复制给 AI 管理」交给 Agent；
5. 记录你自己的想法（印象深刻、值得进一步思考、自由笔记）；
6. 导出对人和 AI Agent 都友好的 Markdown / JSONL / JSON，便于检索与 RAG。

## 为什么是 TypeScript

需求本质是“一个在浏览器里跑的扩展”：

- MV3 的 service worker、content script、popup/options 页面**本来就是 JS/TS**，用 TypeScript 可以一套语言 + 一套类型贯穿全链路（`chrome.*` 官方类型、消息协议类型）。
- 最关键的那步——“抓页面播放器自己的响应”——**只能在浏览器里做**：只有扩展能拿到 `/x/player/wbi/v2` 的原始响应和登录态。用 Python 只能退化成“再发一次请求”，那正是随机字幕的来源。
- Notion / AI / 存储 / 导出都有成熟的一手 JS 生态，构建与测试（esbuild + Vitest + Playwright）也最省事。

因此主实现选 **TypeScript（esbuild 打包 + Preact UI + Vitest + Playwright）**；旧 Python v2 作为历史实现保留在仓库里。

## 安装（开发者加载）

```sh
cd extension
npm install
npm run build        # 产物在 extension/dist
```

Chrome → `chrome://extensions` → 打开「开发者模式」→「加载已解压的扩展程序」→ 选择 `extension/dist`。

> 代码里固定用 **Chromium 系**（Chrome / Edge / Brave 等）加载；Chrome 137+ 出于安全已忽略命令行的 `--load-extension`，手动加载不受影响。

## 使用

1. 打开任意 B站视频，点一下**点赞 / 投币 / 收藏 / 分享**（任一动作都会自动记录这条视频）。
2. 面板右上角的账号状态兼作「同步 B站 记录」按钮（第一次打开就会显示真实登录状态，不再停在「检测中」）。
3. 点扩展图标查看当前视频：和 B站 一样的操作图标（读取自 B站 API）、字幕预览、AI 摘要预览、同步状态；「我的记录」就在 AI 摘要下面，**编辑器直接在这行里**（印象深刻 / 待思考 / 随笔三个标签），没有单独的一张卡片，也没有保存按钮——编辑框**自动保存**（停笔约 2 秒、失焦或关闭面板都会写入），面板 1.5 秒一次的进度轮询不会覆盖你正在写的内容。
4. 想细看时点「查看全部字幕」/「查看完整摘要」打开阅读页，可以搜索字幕、下载 SRT / TXT / Markdown / JSON。
5. 「执行未完成步骤」会按顺序补齐字幕 → 摘要 → Notion；「处理流程」右上角的 **⟳** 会向 Notion 查询这条视频**是否还在库里**——在库里就刷新页面链接，已经被删掉就把第 3 步标回「待同步」，可以重新写一次。
   **重复推送会被拒绝**：重新执行第 3 步时先按「视频ID」查库，命中就不再建页，直接把记录指向已有页面并说明原因（同一条视频不会出现两个页面）。
   流程每行的标签后面紧跟一个对应的小徽标：**字幕** 后面是 SRT 下载徽标，**AI 摘要** 后面是当前 API 提供商的官方 logo + 名称（悬停可看端点与模型；DeepSeek / OpenAI / Moonshot / 智谱 / 通义千问 / SiliconFlow / Groq / Anthropic / OpenRouter 都有各自的 mark，认不出的端点用通用 CPU 图标），**我的记录** 行是笔记图标，**Notion** 行用 Notion 自己的 logo；Notion 的写入详情（在库状态 / 自动补的列 / 没匹配到的列）收在这一行的小 **ⓘ** 里，点开才显示。
6. 设置页：
   - **Notion**：「启用自动同步到 Notion」是总开关（关闭时流程里不出现 Notion，改为复制给 Agent）。填 Integration Token、父级类型与 Data Source ID / Page ID，点「测试连接」——它先验 Token，再取目标 Data Source 的 schema，逐列报出「匹配到哪一列 / 类型不对 / 没有匹配到」。下方的「自动补齐缺失的列」默认开启：写入前把缺的列按正确类型加进数据库（**只新增，不改动已有列**）。
   - **AI 摘要**：任意 OpenAI 兼容 `baseUrl` + key + model（OpenAI / DeepSeek / Moonshot / 本地 Ollama 均可）。
   - **抓取规则**：字幕语言偏好、一致读取次数、最大尝试次数、是否记录浏览历史、Webhook，以及「测试 B站 状态读取」自检。
   - **导出 / 检索**：导出 `index.md` / `knowledge.jsonl` / `records.json`，或把全部记录复制给 AI。

### Notion 准备

1. 建一个数据库。列名可以自取，但**标题列（title）必须有**，其余按需要准备：

   | 列名（别名） | 类型 | 写入内容 |
   | --- | --- | --- |
   | 任意名 | title | 视频标题 |
   | `视频ID`（`BV号`、`bvid`） | rich text | 视频 BV 号，也是「是否已在库」查询用的键 |
   | `URL`（`链接`） | url（或 rich text） | 视频链接 |
   | `UP主`（`UP主名称`、`作者`、`上传者`、`博主`） | rich text（或 select） | UP主名称 |
   | `日期`（`发布日期`、`视频日期`） | date（或 rich text） | 视频发布日期 |
   | `摘要`（`Summary`、`总结`、`概要`） | rich text | AI 生成的 Summary |
   | `我的记录`（`我的笔记`、`笔记`） | rich text | 你的「印象深刻 / 待思考 / 随笔」（有该列才写） |
   | `标签`（`Tags`） | multi select | AI 标签 |
   | `分区`（`分类`）、`字幕语言` | select | 分区、字幕轨道语言 |
   | `加入时间`（`记录时间`）、`发布时间` | date | 记录时间 / 发布时间 |

   列名不必和上表完全一致：先精确匹配、再匹配别名、最后按包含关系匹配，且一列只会被写一次（`UP主名称`、`Summary`、`发布日期` 都能认出来）。没有匹配到列的项会在弹窗第 3 步下方列出来；开着「自动补齐缺失的列」时它们会在写入前被自动创建（`视频ID` / `UP主` / `日期` / `摘要` / `我的记录`…）。Notion 的 API 不允许改已有列的类型，类型不对的列会在「测试连接」里报出来，需要手动改名或改类型。

2. 创建 integration 并把它连接到该数据库（页面右上 `•••` → `Connections` → `Add connections`）。
3. Data Source ID **不是** Database ID：用 `GET /v1/databases/<database_id>` 返回的 `data_sources[0].id`，或在数据库 `•••` → `Manage data sources` → `Copy data source ID`。
4. 封面写进 Notion 页面的 cover：扩展把封面**上传到 Notion**（`POST /v1/file_uploads` 单段上传，再按 id 引用），上传失败才回退成外链。必须上传的原因是 B站 CDN 对带外部 Referer 的请求返回 403，直接给外部链接时 Notion 抓不到图。**插件面板不显示封面**（阅读页仍显示）。

扩展只会写数据库里**已存在且类型匹配**的属性，缺列也能导入（内容都会进正文）。设置页「测试连接」会先验 Token，再取该 Data Source 的 schema 逐列报告，不会出现"测试通过但写入失败"。

### 本地归档（B站 的历史会过期）

B站 只保留最近一段观看历史，所以扩展自己维护一份**持久归档**（存在 chrome.storage.local，manifest 里已申请 unlimitedStorage）：

- 点面板右上角的账号状态（「B站已登录 ⟳」）即可把 B站 的**观看历史 / 点赞 / 收藏**并进本地归档；设置页「记录」标签里也有「同步 B站 记录」。
- 合并**只做加法**：已有的字幕、摘要、你的笔记、流程状态、Notion 回执都不会被覆盖；新条目会补上来源标记（B站历史 / B站点赞 / B站收藏）与历史播放进度。
- **投币没有列表接口**：B站 不提供「投币记录」，所以每次同步会限量（默认最多 20 条，优先新导入的）逐条读 /x/web-interface/archive/relation 得到点赞 / 投币 / 收藏状态；打开某个视频时也会顺带刷新。
- 从 B站 历史里消失的视频**不会被删除**，只会标记「B站已清理 · 本地保留」，依旧可以搜索、筛选、写入 Notion。判断依据是本次拉到的最早一条历史时间：只有比它还旧、这次又没出现的记录才会被标记。
- 设置页「记录」标签可以按 **我点过赞的 / 我投过币的 / 我收藏过的 / 我分享过的 / B站历史已清理（本地保留）** 筛选；顶部统计给出本地归档、点赞、投币、收藏、B站已清理的数量。
## 工作原理

```text
B站视频页
 ├─ inject.js  (MAIN world, document_start)
 │    挂钩 fetch / XHR，捕获播放器自己的 /x/player/wbi/v2 响应、
 │    /x/web-interface/(wbi/)view 元数据，以及点赞/投币/收藏/分享请求
 │    并读取 __INITIAL_STATE__（B站 把标题/UP主 服务端渲染进页面）
 │    → window.postMessage
 ├─ content.js (ISOLATED world)
 │    转发给 service worker；上报播放进度
 └─ background.js (service worker)
      ├─ 本地记录（chrome.storage，带索引）
      ├─ 同步队列（chrome.alarms 定时重试，单个失败不阻塞队列）
      ├─ 字幕解析：选轨 → 一致读取 → 时长裁剪
      ├─ AI 摘要（可选）
      ├─ Notion 分批写入（幂等：已同步的不重复建页）
      └─ Webhook（可选）
```

核心模块：

| 文件 | 职责 |
| --- | --- |
| `src/lib/wbi.ts` | WBI 签名（含 MD5 实现，Web Crypto 没有 MD5） |
| `src/lib/bili.ts` | 视频信息、WBI 播放器接口、protobuf 兜底、一致读取、B站 列表（历史 / 点赞 / 收藏） |
| `src/lib/subtitle.ts` | 选轨、正文校验、SHA-256 摘要、时长裁剪、SRT、段落合并（补标点、去时间轴） |
| `src/lib/protobuf.ts` | `/x/v2/subtitle/web/view` 二进制解析 |
| `src/lib/notion.ts` | Blocks 构建、分批、列匹配（`matchColumns`）、自动补列（`ensureColumns`）、列自检（`reviewSchema`）、封面上传、在库查询（`checkLibrary`） |
| `src/lib/outline.ts` | 分段提纲的时间段：优先用模型写的时间标记，缺失时按字幕定位 |
| `src/lib/media.ts` | 封面地址规范化（`http` / `//` → `https`，只接受 B站 CDN） |
| `src/lib/ai.ts` | OpenAI 兼容摘要、按 baseUrl 识别提供商（`providerLabel`，即面板上那枚徽标） |
| `src/lib/store.ts` | 存储抽象 + 仓库（记录 / 队列 / 搜索） |
| `src/lib/archive.ts` | 本地归档：来源标记、只做加法的合并、B站 已清理但仍保留的标记 |
| `src/lib/events.ts` | B站 操作请求识别、操作状态合并、观看统计 |
| `src/lib/relation.ts` | 用 B站 API 读取点赞 / 投币 / 收藏（不是猜浏览器行为） |
| `src/lib/icons.tsx` | 点赞 / 投币 / 收藏 / 分享 = **B站 视频页工具栏的原始 SVG 路径**（状态沿用 B站 的 `.on` 类模型）；设置 / 刷新 / 写记录 / 详情 / 兜底 = **Bootstrap Icons v1.11.3**（MIT）；Notion 行 = **Simple Icons 的 notion logo**；SRT 用扩展名徽标。全部为复制来的官方路径，不自己画 |
| `src/lib/brand-icons.ts` | AI 提供商的官方 mark（**LobeHub Icons**，MIT，24×24，用 `currentColor` 上色）：DeepSeek / OpenAI / Moonshot / 智谱 / 通义千问 / SiliconFlow / Groq / Anthropic / OpenRouter |
| `src/lib/watch.ts` | 观看进度与「看完」判定（≥90% 才算看完） |
| `src/lib/pipeline.ts` | 三步流程的规划与新鲜度判定（字幕 → 摘要 → Notion） |
| `src/lib/export.ts` | Markdown / JSONL / Agent 简报导出 |
| `src/viewer/Viewer.tsx` | 阅读页：全文幕（可搜索）+ AI 摘要 + 笔记 + 下载 |

## 界面

**弹窗（396×≤600，不滚动）**：

```text
BiliVault · 3 条 · 1 已同步 · 1 需处理      ● B站已登录   ⚙
┌───────────────────────────────────────────────┐
│ Pi 大道至简：超越 Codex 和 Claude Code…        │
│ AI 产品观察 · 科技 · 30:32        👍  🪙2  ⭐  ↗  │  ← 和 B站 一样的操作图标
└───────────────────────────────────────────────┘
处理流程                                已看完
  1. 字幕     中文（自动生成） · 2 次读取一致   ↻
     0:00 今天我们来聊一个极简的 agent 架构。
     0:04 核心观点是：工具不是越多越好。
     [查看全部 128 段字幕]  [下载 SRT]
  2. AI 摘要  已生成                            ↻
     演讲者认为 Agent 的能力上限由上下文管理决定，而非工具数量；他给出一个…
     [查看完整摘要 · 7 个关键点]
  3. Notion   已写入                            ↻
  [ 执行未完成步骤 ] [ 打开 Notion ] [ 复制给 AI ]
┌───────────────────────────────────────────────┐
│ [印象深刻 2] [待思考 2] [随笔 1]        保存  │
│ [ 一行一条，随手写点什么…                    ] │
└───────────────────────────────────────────────┘
```

弹窗在 600px 内放得下视频卡 + 三步流程（含字幕与摘要预览）+ 随手记，不需要滚动。

### 处理流程是一步一步的

字幕 → AI 摘要 → Notion，**按顺序执行，失败停在该步并在该步显示原因**：

- 每一步单独显示状态（未开始 / 进行中 / 已完成 / 失败 / 已过期）；失败的那一步下面直接写出错误原文（例如「B站要求登录后才能读取该视频的字幕」）。
- 每一步右侧的 `↻` 只重跑这一步，不影响其他步骤的成果。
- 主按钮只执行**未完成**的步骤；全部完成时按钮变为「全部已完成」并禁用，不会重复建 Notion 页面。
- 字幕重新抓取后正文变化时，AI 摘要与 Notion 页会被标记为「已过期」，主按钮会重新排队这两步。
- 弹窗每 1.5 秒刷新一次，所以能实时看到「抓取中… → 生成中… → 写入中…」。

### 读书一样的阅读页

弹窗只放预览；要看全文点「查看全部字幕」或「查看完整摘要」，会打开扩展内的阅读页（`viewer.html`）：

- **字幕**：时间轴 + 正文，支持**在字幕中搜索**（长字幕只渲染前 300 段，可继续加载），并显示轨道 / 独立一致读取次数 / SHA-256 / 抓取时间。
- **AI 摘要**：完整摘要 + 分段提纲（每条带 `[00:12–02:30]` 时间段，说明这部分内容出现在哪一段）+ 关键点，字幕更新导致摘要过期时会明确标注。
- **我的笔记**：印象深刻 / 待思考 / 随记。
- **下载**：SRT（带真实时间轴）、纯文本 TXT、含 frontmatter 的 Markdown（字幕按段落合并、不留时间轴）、给 agent 用的 JSON；AI 摘要可单独下载 Markdown。
- 没有字幕时，阅读页里可以直接点「抓取字幕」。

### 操作状态来自 B站，不是猜的

弹窗上的四个图标（点赞 / 投币 / 收藏 / 分享）复刻 B站 的样式：**未操作是描边，操作后填充并变亮**（形状与颜色同时变化，不只靠颜色区分）。

关键是状态的来源：

- 打开弹窗时，扩展会用你的登录态调用 B站 自己的 `/x/web-interface/archive/relation`，**一次请求**读回点赞 / 投币 / 收藏状态并缓存到记录里。
- 所以**多端天然一致**：手机上点的赞，回到电脑弹窗里就是亮的 —— 不需要监听浏览器操作、也不需要自己写同步逻辑。
- B站 没有「分享状态」接口（分享不落库），所以分享图标只能标本地观察到的操作，弹窗会在这种情况下说明。
- 页面里的操作请求只作为**触发信号**：先本地回显一下，随后以 B站 API 的返回为准（API 说没赞就是没赞）。
- 读不到时（未登录 / 风控 / 接口变更）不会瞎猜：图标退回本地记录，并在卡片下方写明原因。接口形状若有变化，会自动退到 B站 文档里的三个单项接口（`has/like`、`coins`、`fav/video/favoured`）并标注警告。
- 设置页「抓取规则」里有 **测试 B站 状态读取**，会显示实际命中的接口与读回的值，方便你在自己的登录态下确认。

### 顺手记

「随手记」是一个小框 + 三个分类（印象深刻 / 待思考 / 随笔），不需要跳转页面；输入一行一条。

**设置页（≤960px）** — 顶部 5 个统计块 + 5 个标签页：记录 / Notion / AI 摘要 / 抓取规则 / 导出。

- 记录页：搜索 + 状态筛选（全部状态 / 已写入 / 待同步 / 待复核·失败），每条显示 B站 操作、状态徽标与「字幕 / 摘要」入口，**失败原因标明是哪一步失败**并写在卡片里。
- 设置项改动**即时保存**，顶部出现「设置已保存」提示；表单按「这是什么 / 填什么 / 为什么」分组。
- Notion / AI 的提示文字说明去哪里拿 ID、需要哪些列、缺列会怎样。

### 设计规则

- **纯色，不用渐变**：全部背景为实色；层次靠 1px 边框与三级表面色（surface / surface-2 / surface-3）。
- 强调色取自 B站 官方配色：粉 `#fb7299`（点赞 / 投币 / 主按钮）、金 `#f0a020`（收藏）、蓝 `#00aeec`（分享），只用于激活态与主操作。
- 状态用语义色：成功绿 / 待处理琥珀 / 失败红 / 中性灰。
- 亮色与暗色主题跟随系统，两套都满足 WCAG AA（正文对比度 ≥ 4.5:1，实测最低 4.83）。
- 字体使用系统 UI 栈（含 PingFang SC / 微软雅黑），不加载 webfont，弹窗即时渲染。

界面不会靠感觉验收：`npm run ui-audit` 会用真实 Chromium 渲染每个页面与标签页，检查**渐变、对比度、横向溢出、元素重叠、样式表是否加载**。

## 数据模型与检索

每条记录是一个 `VideoRecord`（`src/lib/types.ts`）：视频身份与元信息、B站 操作状态（含 `relation` 说明读数来自 API 还是本地）、观看统计、字幕（含 `digest` / `observations`）、AI 分析、你的笔记、三步流程状态与 Notion 回执。

导出给 agent 时：

- `index.md`：按时间倒序的索引，带 👍🪙⭐🔗 操作标记；
- `knowledge.jsonl`：一行一条记录，含字幕全文，可直接做 embedding / RAG；
- `videos/*.md`：带 YAML frontmatter 的完整 Markdown（`bvid`/`cid`/`subtitle_sha256`/`actions`/`notion_url`/`tags`…）；
- 弹窗/设置页的「复制给 AI Agent」：一段精简上下文。

未来的人或 agent 可以用 `bvid`、`actions`、`tags`、`subtitle_sha256` 精确检索，也能全文搜索标题 / UP主 / 字幕 / 摘要 / 笔记。

## 开发与验证

```sh
npm run typecheck   # tsc --noEmit
npm run test        # Vitest：61 项（字幕一致性、WBI 向量、Notion 分批、导出…）
npm run build       # esbuild → dist/
npm run e2e         # 真实 Chromium 加载扩展跑两个场景（需已 build）
npm run verify      # typecheck + test + build
node scripts/live-probe.mjs  # 对真实 B站 API 的非登录探针
```

### E2E 覆盖

| 场景 | 期望 |
| --- | --- |
| CDN 稳定 | 两次独立读取一致 → 记录落库，`observations: 2`，正文精确匹配 |
| CDN 每次返回不同正文（B站 的 bug） | 拒绝采信、`needs_review`、重试超过单次读取、Notion 不写入 |

字幕问题的完整调查、其他开发者的解法与实测证据见 [`docs/subtitle-instability.md`](docs/subtitle-instability.md)。

## 权限与隐私

- `storage` / `unlimitedStorage`：本地存记录与字幕。
- `alarms`：同步队列重试。
- `cookies`：仅用于汇报“B站 是否已登录”（SESSDATA 是否存在），**不读取、不上传 Cookie 值**。
- `tabs` / `notifications`：识别当前视频、同步完成通知。
- 主机权限：`*.bilibili.com`、`*.hdslb.com`、`api.notion.com`；调用自建 AI / Webhook 时按需请求该域名权限。
- 所有凭据只存在本机 `chrome.storage.local`，不经过任何第三方服务，只发给你自己配置的端点。

## 数据来源：标题与 UP主

标题/UP主 有四个来源，按可靠性依次兜底，所以不会再出现「显示 BV 号、UP主未知」：

1. `window.__INITIAL_STATE__.videoData`（B站 服务端渲染，最可靠，含标题、UP主、封面、分区、时长、简介）；
2. 页面自己发出的 `/x/web-interface/wbi/view`（或 `/x/web-interface/view`、`/x/web-interface/view/detail`）响应；
3. 后台用 **WBI 签名** 请求 `/x/web-interface/wbi/view`（未签名容易被风控返回错误页，这正是旧版「未知UP主」的原因）；
4. 页面 DOM（`h1.video-title` / `.up-name`）兜底。

抓取失败时错误会显示在弹窗视频卡下方，而不是静默显示 BV 号。

## 观看状态

只有播放进度**达到视频时长的 90%** 才标记为「已看完」，否则显示实际百分比。进度按视频分别累计：B站 是单页应用，切视频不会重载脚本，因此换视频时进度会归零（早期版本会把这支视频的进度带到下一支，导致误判已看完）。

## 已知限制

- 一致读取只能证明“多次观察一致”，不能证明字幕语义上一定属于该视频；AI 字幕本身也有错字与断句问题。
- 无字幕的视频只能拿到标题/简介（可让 AI 基于此谨慎概述）。
- 未登录时 B站 不返回字幕；扩展会明确提示“需要登录”，而不是“没有字幕”。
- Notion 单页内容很长时请求较多（每批最多 90 个 block / 280KB），会自动分批。

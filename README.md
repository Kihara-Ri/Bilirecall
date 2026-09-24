# BiliRecall · 把 B站 看过的视频沉淀成知识库

你在 B站 **点赞 / 投币 / 收藏 / 分享** 过的视频，会自动变成本地可检索的知识：**字幕**（修好了「同一 BV/CID 每次抓到不同字幕」）、可选 **AI 摘要**、你自己的 **笔记**，以及一份人和 AI Agent 都能用的 **导出**。主实现是 Chrome 扩展（Manifest V3 + TypeScript + Preact），Notion 只是可选出口。

- 安装、使用与界面说明：[`extension/README.md`](extension/README.md)
- 字幕「同一 BV/CID 结果不一样」的完整根因调查、其他开发者的解法与实测证据：[`extension/docs/subtitle-instability.md`](extension/docs/subtitle-instability.md)
- 隐私与数据外发范围：扩展不申请 `cookies` 权限、不向开发者回传任何数据 — [`extension/docs/privacy.md`](extension/docs/privacy.md)

## 功能一览

### 自动收集：一次操作，长期归档

- 你在视频页**点赞 / 投币 / 收藏 / 分享**（任一动作）就记录这条视频，并自动补齐字幕 → 摘要 → 知识库。没有别的开关要记。
- 用你浏览器里的登录态读取 B站 自己的**观看历史 / 点赞 / 收藏**列表。**B站 的历史会过期，本地这份不会**：按服务端游标分批，任务游标持久化，service worker 休眠后通过 `chrome.alarms` 续传；**自动更新开启时闹钟常驻**——浏览器启动即拉一轮新历史，之后每 5 分钟自动对齐，失败按同一窗口退避重试，不需要打开插件页面。
- 互动状态只信 `code=0` 的响应：没确认的状态显示为「未知」，绝不写成「没有点赞」。多端也天然一致——手机上点的赞，回到电脑弹窗里就是亮的。

### 字幕：确定性选轨 + 一致读取

见下文[「字幕一致性」](#字幕一致性为什么不会每次抓到不同的字幕)。这一块是项目的起点，也是唯一被反复修过的地方。

### 可选 AI 摘要

- 任意 OpenAI 兼容端点：OpenAI / DeepSeek / Moonshot / 智谱 / 通义千问 / SiliconFlow / Groq / Anthropic / OpenRouter，或本地模型（`http://127.0.0.1`）。按 baseUrl 识别提供商并显示官方 logo；调用哪个域名由你授权。
- 输出结构化结果：一段摘要 + 分段提纲 + 关键点。提纲**每条都带 `[00:12–02:30]` 时间段**，说明这部分内容出现在视频的哪一段（模型写了时间标记就用它，没写就按字幕内容定位）。
- 字幕正文变化后摘要会自动标成「已过期」，重跑那一步即可，不需要手动清理。

### 可选写入 Notion

- 支持 **data source 数据库**或**页面**作为父级；列名可以自取（精确 → 别名 → 包含三级匹配），缺列可自动补齐，类型不对会在「测试连接」里逐列报出来。
- 标题 / 视频ID / UP主 / 日期 / 摘要 / 我的记录分列写入，正文按段落合并（补标点、去时间轴），封面走 Notion 的文件上传接口（B站 CDN 对带外部 Referer 的请求返回 403，直接给外链 Notion 抓不到图）。
- **幂等**：写入前先按「视频ID」查库，命中就拒绝重复推送，并把记录指向已有页面——同一条视频不会出现两个页面。
- 也可以完全不用 Notion：关掉自动同步后流程里不出现这一列，摘要整理好点「复制给 AI」交给任意 Agent。

### 你自己的笔记

- 弹窗里直接写：印象深刻 / 待思考 / 随笔三个分类，一行一条，**停笔约 2 秒、失焦或关闭面板都会自动保存**。
- 1.5 秒一次的进度轮询不会覆盖你正在写的内容。
- 写笔记等于说「这条我要留着」：即使没点赞，也会进入处理流程。

### 导出给人和 AI Agent

- `index.md`：按时间倒序的索引，带 👍🪙⭐🔗 操作标记。
- `knowledge.jsonl`：一行一条记录，含字幕全文，可直接做 embedding / RAG。
- `videos/*.md`：带 YAML frontmatter 的完整 Markdown（`bvid` / `cid` / `subtitle_sha256` / `actions` / `notion_url` / `tags` …）。
- 弹窗里的「复制给 AI」：一段精简上下文，直接粘进 Agent 对话。

### 界面

- **弹窗**（396×≤600，不滚动）：视频卡 + 三步流程（字幕 / AI 摘要 / Notion）+ 我的记录；操作图标与 B站 一致，状态来自 B站 API 而不是猜浏览器行为。
- **阅读页**：全文幕（可在字幕中搜索）+ 完整摘要 + 笔记 + 下载 SRT / TXT / Markdown / JSON。
- **管理页**：历史记录（按真实观看日期分组、继续播放、互动筛选）/ 知识库 / 设置三个入口。
- 更新不闪：轮询只搬「状态 + 归档版本号」，归档真的变了才重读记录；列表按稳定 ID 复用节点，后台刷新不清空列表、不跳回顶部。

## 字幕一致性：为什么不会「每次抓到不同的字幕」

> 完整调查（含 yt-dlp、bilibili-api 等项目的解法与实测证据）：[`extension/docs/subtitle-instability.md`](extension/docs/subtitle-instability.md)

### 三个根因

社区里长期有「BV 号和 CID 都没变，抓到的字幕却不一样」的报告（本仓库 issue #7 与 bilibili-api #841）。调查下来是三类原因叠加：

| 根因 | 说明 |
| --- | --- |
| **A. 取 `subtitles[0]`** | 同一个分 P 可以有多条轨道（`zh-Hans` / `ai-zh` / `zh-Hant` / `en`），数组顺序不保证稳定 → 每次可能选到不同语言、不同正文 |
| **B. 接口迁移** | `/x/player/v2` 已迁移为需要 **WBI 签名**的 `/x/player/wbi/v2`；未签名或参数不全时可能命中共享缓存或降级响应，返回**别的视频**的字幕 |
| **C. 把签名 URL 当成内容变化** | 字幕 CDN 的签名 URL 每次都不同，旧代码据此判断「内容变了」；同时把空轨道列表一律当成「这个视频没有字幕」 |

### 八条防线

**1. 权威来源前置。** 扩展用 MAIN world 的页面钩子在 `document_start` 挂钩 `fetch` / XHR，直接截获**页面自己播放器**发出的 `/x/player/wbi/v2` 响应——那是当前视频**实际在用**的 `aid` / `cid` / `bvid` 与轨道列表。连「再发一次请求可能拿到别的视频」这个窗口都被关掉，比事后重新请求可靠得多。

**2. 自己请求时用 WBI 签名。** 需要补充请求时走 `/x/player/wbi/v2`，参数带 `bvid` + `aid` + `cid` + `isGaiaAvoided=false` + `web_location=1315873`；签名密钥缓存在内存里，命中风控码（-352 / -403 / -400）就丢弃密钥重新签名重试。JSON 里没有轨道时再兜底到二进制接口 `/x/v2/subtitle/web/view`（`lib/protobuf.ts` 手写解析）。

**3. 确定性选轨，绝不取第一条。** 按 `(语言优先级, language, track id)` 三元组排序，同一个请求永远选出同一个轨道；指定了语言或轨道 id 却不存在时**直接报错**，不静默换成另一种语言。

**4. 一致读取（consensus）。** 同一条轨道**独立读取至少 2 次**，把每次的正文与时间轴规范化后算 SHA-256：只有两次摘要**完全相同**才采信并落库；不一致就重新获取签名 URL 再读，超过上限就抛 `UnstableSubtitle`，标记待复核，**不把可疑正文写进 Notion**。

**5. 身份核对。** 每次播放器响应都校验返回的 `bvid` / `aid` / `cid` 与请求是否一致，不一致直接判失败（`IdentityMismatch`）——这是防「拿到别的视频字幕」最直接的一道闸。

**6. 签名过期只刷新同一条轨道。** 正文请求遇到 401 / 403 时，重新解析的仍然是**同一个 track id**，绝不因为 URL 失效就换一种语言。

**7. URL 与占位符安全。** 字幕地址只接受 B站 域名（`*.hdslb.com` / `*.bilibili.com` / `*.biliapi.net`）下的 HTTPS URL；匿名 protobuf 响应里那种带百分号编码控制字节的混淆占位地址一律拒绝。

**8. 时间轴与登录语义。** AI 字幕的时间戳经常远超视频时长（社区实测 35 倍），越界的时间会被裁剪并记一条警告；`need_login_subtitle` 与 `-101` 分别报「需要登录」「登录态已失效」，不再和「这个视频没有字幕」混为一谈。

### 怎么验证

- **单元测试**：`tests/wbi.test.ts` 用固定向量校验签名；`tests/subtitle.test.ts` 只调换轨道顺序，旧算法会选到不同语言，新算法始终返回同一个 track id；`tests/bili.test.ts` 覆盖身份不一致、一致读取失败、过期 URL 等分支。
- **真实浏览器 E2E**（`npm run e2e`，真实加载 MV3 扩展 + 受控协议夹具）：CDN 稳定时两次读取一致 → 记录带 `observations: 2` 落库；CDN 每次返回不同正文时（B站 的真实 bug）→ 拒绝采信、标记待复核、Notion 不写入。

## 快速开始

**方式一：直接下载安装（无需构建）**

1. 从 [Releases](https://github.com/Kihara-Ri/Bilirecall/releases/latest) 下载最新的 `BiliRecall-v*.zip` 并解压；
2. Chrome 打开 `chrome://extensions`，开启右上角「开发者模式」；
3. 点「加载已解压的扩展程序」，选择解压出来的 `bilirecall-x.y.z` 文件夹。

> 为什么是 zip 而不是"双击安装"的单文件？Chrome 自 2014 年起禁止安装非商店来源的 `.crx`，「解压 + 加载已解压」是未上架扩展在 Chrome 上的唯一官方安装方式。

**方式二：从源码构建**

```sh
cd extension
npm install
npm run build        # 产物在 extension/dist
```

Chrome → `chrome://extensions` → 打开「开发者模式」→「加载已解压的扩展程序」→ 选择 `extension/dist`。之后打开任意 B站 视频点个赞，扩展就会开始工作；点扩展图标可以看到这条视频的字幕、摘要与笔记。详细步骤、Notion 准备与设置项见 [`extension/README.md`](extension/README.md)。

## 文档导航

| 文档 | 内容 |
| --- | --- |
| [`extension/README.md`](extension/README.md) | 安装、使用、界面、工作原理、权限 |
| [`extension/docs/subtitle-instability.md`](extension/docs/subtitle-instability.md) | 字幕不一致的根因调查与各项目解法对照 |
| [`extension/docs/history-workspace.md`](extension/docs/history-workspace.md) | 历史记录 / 知识库的归属与时间口径 |
| [`extension/docs/privacy.md`](extension/docs/privacy.md) | 访问什么、发到哪里、怎么删除 |
| [`extension/docs/test-results.md`](extension/docs/test-results.md) | 逐轮验收记录与证据 |
| [`extension/开发日志.md`](extension/开发日志.md) | 逐版本改动记录 |

## 开发与验证

```sh
cd extension
npm install
npm run verify     # typecheck + vitest + build
npm run e2e        # 真实浏览器加载 MV3 扩展的端到端测试
```

发版：`npm run release -- --bump 1.2.0`（校验 → 打包 zip → 校验和 → 从开发日志生成说明 → 打 tag → 发布 GitHub Release，`--dry` 可预演）。

CI（GitHub Actions）在 Node 22 上运行 `npm run verify`。

## 历史版本

本项目的前身是两代 Python 命令行实现（v1 脚本版、v2 可安装包 `bili-notion`），功能已被本 Chrome 扩展完整取代，代码已从仓库移除。需要查阅时可在本仓库的 git 历史，或旧仓库 [`Kihara-Ri/bili-video-info_TO_Notion`](https://github.com/Kihara-Ri/bili-video-info_TO_Notion) 中找到。

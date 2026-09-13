# 同一个 BV/CID，两次拿到不同字幕：根因与其他开发者的解法

> 调查日期：2026-09-11 ｜ 关联 Issue：
> [Kihara-Ri/bili-video-info_TO_Notion #7](https://github.com/Kihara-Ri/bili-video-info_TO_Notion/issues/7)（2026-03-16，用户 zxy1029：“多次调用 bv 号和 cid 一致，但是查询到的字幕结果不一样”）
> · [Nemo2011/bilibili-api #841](https://github.com/Nemo2011/bilibili-api/issues/841)（2024-10-31 起：**“获取到的字幕内容是随机的……大概率是其他视频的字幕，偶尔也能获取到正确的字幕”**）

## 1. 结论先行

这不是“网络抖动”，而是三类可解释的原因叠加。旧项目把其中一个当成正常现象，另外两个是代码缺陷：

| # | 原因 | 归属 |
| --- | --- | --- |
| A | 旧代码用 `subtitles[0]` 取字幕。同一分P可以有多条轨道（`zh-Hans` / `ai-zh` / `zh-Hant` / `en`），数组顺序不保证稳定 → 每次选到不同语言/不同正文 | **代码缺陷** |
| B | `/x/player/v2` 已迁移为需要 WBI 签名的 `/x/player/wbi/v2`。未签名/参数不全时可能命中共享缓存或降级响应，返回别的视频的字幕 | **接口迁移 + 服务端** |
| C | 字幕 CDN 的**签名 URL** 每次不同，旧代码把它当成“内容变化”；同时把空列表一律当成“没有字幕” | **代码缺陷** |

A 与 C 可以在本地用合成数据 100% 复现（见 `tests/subtitle.test.ts`）。B 是社区广泛记录的真实故障，无法用固定样本证明唯一根因，但它的修复方式明确且可验证。

## 2. 其他开发者是怎么解决的

| 来源 | 关键做法 |
| --- | --- |
| [yt-dlp bilibili extractor](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/bilibili.py) | 用 WBI 签名请求 `/x/player/wbi/v2`，同时带 `bvid`+`cid`；用 `need_login_subtitle` 单独提示登录；按 `lan` 保留全部轨道而不是取第一条 |
| [bilibili-api #841](https://github.com/Nemo2011/bilibili-api/issues/841) | 社区实测结论：把接口从 `/x/player/v2` 换成 `/x/player/wbi/v2`（浏览器里还带 `isGaiaAvoided=false&web_location=1315873`） |
| [JoeyTeng/bilibili-helper PR #4](https://github.com/JoeyTeng/bilibili-helper/pull/4)（2026-06-03 合并） | 新增二进制 `/x/v2/subtitle/web/view` 字幕元数据支持，处理 `ArrayBuffer` 响应 |
| [vruses/bili-api-interceptor #5](https://github.com/vruses/bili-api-interceptor/issues/5) | 记录 2026.01 起字幕元数据迁移到 protobuf（`/x/v2/dm/web/view`、`/x/v2/subtitle/web/view`），并对字幕 URI 做混淆 |
| [j4rviscmd/bilibili-downloader-gui #369](https://github.com/j4rviscmd/bilibili-downloader-gui/pull/369) | 下载失败时外层重试并**重新获取新的签名 URL**（“increasing the chance of hitting a different CDN node”），而不是重试同一个 URL |
| [j4rviscmd/bilibili-downloader-gui #515](https://github.com/j4rviscmd/bilibili-downloader-gui/pull/515) | AI 字幕会携带远超视频时长的 `to` 时间戳（实测 35×），需要裁剪并告警 |
| [xiaoyaya191/bilibili_learning_bot](https://github.com/xiaoyaya191/bilibili_learning_bot/blob/55820cb5/api/subtitles.py) | WBI 签名 + 连接复用 + 对候选轨道做**语义校验**，不匹配就换下一轨 |

共同点：**不要相信“一次请求 + 第一条轨道”**；要固定轨道身份、使用 WBI 签名、并对结果做校验/重试。

## 3. 本仓库的修复

### 3.1 Python v2（旧入口，保留兼容）

- WBI 签名 `/x/player/wbi/v2`，空列表时回退二进制 `/x/v2/subtitle/web/view`。
- 明确选轨（语言 + track id），失败直接报错，不静默换语言。
- 校验返回的 `bvid/aid/cid` 与请求一致。
- `verify` 反复抓取并比较正文 SHA-256；`export` 默认两次独立读取一致才写文件。
- 区分「未登录 / 登录过期 / 无字幕 / 风控 / 网络 / 格式错误」。

### 3.2 Chrome 扩展（本次大翻新，主实现）

1. **权威来源前置**：MAIN-world hook 抓取页面**自己播放器**发出的 `/x/player/wbi/v2` 响应，直接拿到当前视频实际使用的 `aid/cid/bvid` 和轨道列表。这样连“另一次独立请求可能拿到别的视频”这个窗口都被关掉。
2. **WBI 签名**：自己发请求时使用 `/x/player/wbi/v2`，参数含 `bvid`+`aid`+`cid`+`isGaiaAvoided=false`+`web_location=1315873`，并刷新 WBI 密钥重试。
3. **确定性选轨**：按 (语言优先级, language, id) 排序，**绝不取 `[0]`**；指定语言/轨道缺失时报错。
4. **一致读取（consensus）**：同一轨道独立读取 N 次（默认 2），SHA-256 完全相同才采信；不一致就重新获取签名 URL 重试；超过上限 → `needs_review`，**不把可疑正文写进 Notion**。
5. **URL 安全**：只接受 B站域名下的 HTTPS 地址；拒绝匿名 protobuf 响应里那种带控制字节的混淆占位 URL。
6. **时长裁剪**：越界的 AI 字幕时间戳裁剪并写入警告。
7. **过期签名 URL**：401/403 时刷新**同一条轨道**，绝不换成另一种语言。
8. **登录态语义**：`need_login_subtitle` / `-101` 分别报“需要登录”“登录过期”，不再与“没有字幕”混为一谈。

## 4. 验证证据

### 4.1 自动化（`npm test` → 61 passed）

关键用例：

- `tests/subtitle.test.ts`：同一 BV/CID 仅调换轨道顺序 → 旧 `subtitles[0]` 取到不同语言，新算法始终返回同一 `track id`。
- `tests/bili.test.ts`：两次读取一致才返回；服务器每次给不同正文时抛 `UnstableSubtitle` 并放弃写入；返回 `cid` 不匹配时抛 `IdentityMismatch`；`need_login_subtitle` 抛 `LoginRequired`；403 时刷新同一轨道；protobuf 回退可用。
- `tests/wbi.test.ts`：mixin key 与真实 `nav` 返回的密钥推导一致（`ea1db124af3c7062474693fa704f4ff8`），`w_rid` 与独立实现（node:crypto MD5）逐字节相同。

### 4.2 真实浏览器端到端（`npm run e2e` → all checks passed）

真实 Chromium 加载扩展 + 夹具视频页：

```text
stable   : reads=2  like=true  subtitle=ok  observations=2  text="第一句\n第二句"  notion=pending
unstable : reads=4  like=true  subtitle=none notion=needs_review
           error="连续 4 次读取未取得一致的字幕正文（摘要：…）。可能是 B站返回了其他视频的内容或 CDN 缓存错乱；本次不写入 Notion，稍后重试。"
```

即：正常时两读一致才落库；模拟 B站“同一 CID 返回不同正文”时，扩展拒绝采信并标记待复核。

### 4.3 真实网络探针（`node scripts/live-probe.mjs`，无 Cookie）

```json
{
  "nav": { "isLogin": false, "hasWbiKeys": true },
  "playerWbiV2": { "endpoint": "/x/player/wbi/v2", "identityEchoMatches": true, "needLoginSubtitle": true, "tracks": [] },
  "legacyPlayerV2": { "code": 0, "aid": 117104095268420, "cid": 40960721402, "needLoginSubtitle": true, "subtitleCount": 0 },
  "subtitleProto": { "trackCount": 1, "tracks": [{ "language": "ai-zh", "label": "中文" }] },
  "resolveSubtitle": { "errorName": "LoginRequired", "message": "B站要求登录后才能读取该视频的字幕（need_login_subtitle）" }
}
```

说明：

- WBI 签名被真实服务端接受（`code 0`），返回的 `aid/cid/bvid` 与请求完全一致。
- 匿名访问 protobuf 接口确实会返回**混淆过的字幕 URL**（形如 `//subtitle.bilibili.com/%01%1B%5C=...`），扩展的 `isUsableSubtitleUrl` 会拒绝它。
- 此时扩展报 `LoginRequired` 而不是“没有字幕”——这正是旧代码最危险的误判。

## 5. 边界

- 一致读取只能证明“这几次观察一致”，不能证明字幕在语义上一定属于该视频。扩展里的时长裁剪与（可选）AI 摘要都是额外的粗糙校验。
- 真的拿到别的视频的字幕且时长恰好吻合时，只有人工或 AI 语义核对才能发现。因此扩展默认**保留待复核状态**，并提供手动编辑与 Notion 页面链接。
- protobuf 接口的可用性并不稳定（同一天不同时刻 trackCount 会在 0/1 之间变化），所以扩展把它当兜底，主来源始终是页面播放器自己的响应。

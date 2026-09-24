# 历史工作区架构（1.1.0）

## 展示与数据边界

`Options` 只负责导航、读取数据、保存反馈。`history-view.tsx` 管浏览与同步状态，`library-view.tsx` 管知识，`settings-view.tsx` 管配置。公共逻辑在 `lib/history.ts`，避免 UI 与后台各自猜收录条件。

- `history.watchedAt`：B站 `view_at` 或本机实际观看时间，毫秒。
- `history.position`：最近播放位置（秒），允许回看时回退；不是 `watched.secondsWatched` 的最大值。
- `history.finished`：B站 progress=-1 / is_finish 或本机最近位置达到90%。
- `history.hidden`：本地历史隐藏标记，后续导入保留；不删除知识数据。
- `library.saved`：新导入显式 false，主动收录 / 页面原有动作触发 / 保存笔记时 true。旧记录无此字段时兼容已存在的互动与知识内容。
- `interaction()` 返回 true / false / null；没有可靠 API 否定证据时不把默认 false 当作“没操作”。

历史页只用真实观看时间排序；旧归档若不能确定观看时间则留在无观看时间组，不使用入库时间顶到今天。普通“全部”不混入仅点赞收藏的条目，互动筛选可以查看它们。

## 消息契约

| 请求 | 回执 / 副作用 |
| --- | --- |
| `sync-bilibili {force?: boolean}` | 只启动任务，立即返回状态；false 尊重自动更新开关与5分钟新鲜度，true显式重试 |
| `history-status` | 获取持久任务状态、阶段、计数、最近完成时间、错误与警告 |
| `collect-record {key}` | 只标记收录，不立即发外部请求 |
| `hide-history {key}` | 只隐藏本地历史，保留知识和外部记录 |
| `save-settings {patch}` | 成功存储才返回成功；前端串行写入，旧响应不能覆盖新输入 |
| `list-records` | 返回本地数据，网络更新不阻塞它 |

`sendToBackground` 对缺失回执、拒绝与超时返回失败对象。普通消息15秒超时，手动流水线120秒。UI不会把排队回执称为历史完成。

## 持久化任务

`history-sync-job` 保存阶段、账号mid、服务端游标、点赞页号、收藏夹/页号、互动待查key与偏移。顺序：history → likes → favorites → relations → done。

- 历史 `max` 是服务端游标ID，`view_at` 是时间，必须分别沿用服务端响应，不能把时间同时填入两者。
- 一次 tick 处理一页或最多5个互动；每页写完才前移游标。SW中断可重放未完成页，逐条 upsert 幂等。
- 后台注册 `bilivault-history` alarm，30秒周期需要 Chrome120+。每次唤醒最多10批，批间1秒，互动逐条额外350ms；任务完成后清除 alarm。
- 每批验证登录和mid，进行中的任务切号会停下并要求切回。登录/历史请求失败停在原游标，显式重试；点赞收藏和单个互动失败保留警告，不回滚已获取历史。
- 初次遍历接口仍可获取的历史；后续遇到全部已知且早于上次完成时间的一页可以停止历史翻页，减少请求。
- 历史合并通过共享记录锁重新读取最新对象，保留字幕、摘要、笔记、流程状态与Notion回执。同步没有AI/Notion依赖，也不向知识处理队列入队。
- 不能凭本次未出现推断远端删除；旧标记保留兼容，但新任务不调用旧的删除推断函数。

## 并发写入与删除

- Repository 对共享索引、revision和处理队列执行全局串行读改写，避免不同记录各自持有记录锁时仍互相覆盖索引；锁只覆盖storage操作。
- 历史列表合并和互动补全均先把旧记录的 `inLibrary` 结果写入显式 `library.saved`，再改互动字段。已收录保留、未收录保持未收录，远端点赞不会扩大 `sync-all` 的处理范围。

- `check-notion` 的网络请求不阻塞笔记编辑；回包后在共享记录锁内重新读取，更新最新记录的 Notion 状态。期间已删除则返回失败，绝不重建记录。
- `delete-record` 与流水线共用记录锁，正在写入时排队，删除完成时同时移除队列任务。
- `removed:<key>` 持久标记本地删除；历史导入在锁内检查，不会因迟到分页或 SW 重启而复活。用户之后主动访问/收录可以新建记录。历史页的 `hide-history` 仍只隐藏，不删除笔记。
- 单项互动回退必须全部 `code === 0` 且字段可解析；风控/参数错误返回的默认 `0/false` 不作为否定证据。

## 验收

- `tests/history.test.ts`：观看日期、未知互动、续播位置、旧知识兼容。
- `tests/history-sync.test.ts`：超过40条导入、持久续传、来源合并、笔记保护、无处理队列副作用、登录失败、部分失败、并发启动、服务端游标。
- `scripts/workspace-test.mjs`：真实 Chromium 中31项交互检查，含40条分批渲染、筛选、搜索、登录提示、滚动位置、收录/移除、保存失败重试及390/768/1280布局。
- `scripts/concurrency-test.mjs`：真实MV3后台延迟外部回包，覆盖请求期间保存笔记、删除记录、处理流水线期间删除，以及错误接口携带默认零值不变成可靠否定。已纳入 `npm run e2e`。
- `scripts/e2e.mjs`：加载真实MV3扩展，页面→SW→存储→历史UI，以及原字幕/AI/Notion流程；B站与外部服务用路由夹具，不接触真实账号。`E2E_ARCHIVE_ONLY=1`可单跑历史。
- `npm run verify`、`npm run ui-audit`、`npm run e2e`、`npm run dev -- --smoke`。

真实 Chromium + 协议夹具验证不等于真实账号在线联调；B站接口可用范围和风控仍以账号实际返回为准。

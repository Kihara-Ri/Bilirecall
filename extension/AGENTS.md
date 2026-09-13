<!-- 自动生成，请勿手改。权威副本：../../AGENTS.md（重新生成：node tools/sync-agents.mjs） -->
# Chrome 扩展开发目录约定

本文件是本目录的**项目级上下文**，pi 会对本目录下所有子项目自动加载，因此这里的约束默认对每个扩展项目生效。

## 作用域

- 适用对象：本目录下所有 Chrome 扩展（Manifest V3）。
- `bilibili缓冲插件/`：仓库根即扩展根。
- `b站延拓/extension/`：仅扩展部分适用本文件；`b站延拓/` 根目录是 Python 项目，遵循它自己的约定。
- 提交发生在各子仓库内（本目录本身不是 git 仓库）。修改本文件后需 `/reload` 或重启 pi 才会重新加载。
- 本文件是**权威副本**：`node tools/sync-agents.mjs` 生成各仓库内的副本（带「勿手改」头部标记），`node tools/sync-agents.mjs --check` 校验是否漂移。改完本文件务必同步一次。

## 项目速查

| 项目 | 扩展根 | 构建 | 热重载 | 测试 | 提交前校验 |
| --- | --- | --- | --- | --- | --- |
| bilibili缓冲插件 | 仓库根 | `npm run build` | `npm run dev` | `npm test` | `npm run check` |
| b站延拓 | `extension/` | `npm run build`（在 `extension/` 内执行） | `npm run dev`（`-- --once` 单次、`-- --smoke` 自检） | `npm test` | `npm run verify` |

---

# 一、硬性约束

## 1. 提交粒度与可审查性

- **一个独立功能 = 一个提交**。不要把不相关的改动塞进同一个提交，也不要把一个功能拆成“先提交半成品再补”。
- 同一次功能实现的「源码 + 测试 + 文档 + 版本号」应放在**同一个提交**里，审查者一次就能看全。
- 提交信息格式：`<type>: <英文短描述>`，正文用中文写清 **改了什么 / 为什么 / 怎么验证**。
  - `type` 取 Conventional Commits：`feat` `fix` `refactor` `perf` `docs` `test` `chore` `build`。
  - 正文示例：`为什么: B 站切换分 P 后旧的预热点位失效` / `验证: npm run check && npm test`。
- 提交前必须跑通该项目上表中的校验命令，**不允许“先提交再修”**，每个提交都应处于可加载、可运行状态。
- 不提交构建产物与开发态残留：`node_modules/`、`dist/unpacked/`、`.tmp/`、dev profile、`_metadata/`、日志与覆盖率。发布用 zip 若按现有习惯入库，需与本项目的既有做法保持一致。
- 注意：`b站延拓/extension/` 目前仍未被版本控制跟踪（`git status` 显示 `?? extension/`）。涉及扩展的功能开发应在 `b站延拓` 仓库内纳入提交，不要让它继续游离在版本控制之外。

## 2. 可读性与中文注释

- **必要之处必须有中文注释**，至少覆盖：
  - 算法与边界条件（为什么这样分块 / 为什么这样合并）；
  - Chrome API 的坑与 MV3 Service Worker 生命周期（休眠、唤醒、消息通道失效）；
  - 与外部站点的私有协议、字段来源、抓取时机（如 playurl、DNR 规则、CDN 行为）；
  - 跨上下文通信的消息契约（content ↔ background ↔ offscreen）。
- 注释解释 **为什么**，不要写“把 a 赋值给 b”这种翻译式注释。标识符用英文，面向用户的文案可以用中文。
- 模块职责单一；可复用逻辑抽到独立模块（如 `lib/`）而不是复制粘贴；文件用 kebab-case 命名。
- 公共函数/导出用 JSDoc 或 TypeScript 标注参数与返回类型；TS 项目不得用 `any` 敷衍。

## 3. 热重载（必须）

- 每个扩展项目都必须提供 `npm run dev`：watch 源码 → 重新构建 → **自动重载已加载的扩展**，不需要手动点 `chrome://extensions` 的“重新加载”。
- 优先复用本目录已有的两套参考实现（去品牌化的通用版本见 `templates/hot-reload/`，含选型对照、接入清单与验收方式），不要另造轮子：
  - `bilibili缓冲插件/scripts/dev-reload-server.mjs` + `src/dev-reload.js`：本地 HTTP `/health` 暴露 `revision`，扩展侧轮询到变化后调用 `chrome.runtime.reload()`。
  - `b站延拓/extension/scripts/dev.mjs`：Playwright 专用 dev profile（`.tmp/dev-profile`）+ CDP，重建后从扩展页面触发 `chrome.runtime.reload()`，并用 bundle 哈希**校验重载真的生效**。
- 硬性要求：
  - **重载后必须验证生效**（哈希对比或等效证据）；静默失败视为未完成，不能只打印“已重载”。
  - **dev 代码必须与生产隔离**：热重载逻辑（如 `src/dev-reload.js`）不得进入生产 manifest 的注入列表；构建发布包时排除 dev 入口。
  - 需要自动化浏览器时用 Playwright 自带的 `channel: 'chromium'`：品牌版 Chrome 137+ 会忽略 `--load-extension`。
  - dev 产物（`.tmp/`、dev profile、`dev-browser.json`）必须写进 `.gitignore`。
  - 重载后重新注入内容脚本并刷新受测页面，否则“改了没生效”会被误判成 bug。

---

# 二、推荐实践

以下是我建议一并纳入的工程习惯，默认按此执行；如与某个项目的既有做法冲突，按后者并在此处说明。

## 4. 权限与安全

- 严格最小权限：只申请真正用到的 `permissions` / `host_permissions`，**新增权限必须在提交信息里说明用途**，并优先用 `optional_permissions`。
- 禁止把 cookie、token、账号信息、`.env`、抓包文件写入仓库或在日志里打印；调试输出走统一的 `DEBUG` 开关，发布包不留 `console.log` 噪声。
- 页面注入的脚本不要用内联 `<script>`（CSP 会拦），用外部文件 + 正确的 `world`（`MAIN` / `ISOLATED`）。
- 对外请求的域名必须写进 `host_permissions`，不要靠通配 `*://*/*` 兜底。

## 5. 版本与发布

- 版本号单一来源：`manifest.json` 与 `package.json` 保持一致，改版本要同步 README / 变更记录。
- 每次发布前更新变更记录（`开发日志.md` / `README.md` 中的对应章节），让别人知道这一版改了什么。
- 发布产物命名带版本号（沿用 `bili-buffer-extension-<version>.zip` 的做法），并保证 `dist/unpacked/` 与 zip 内容一致。
- Store 就绪清单：16/32/48/128 图标齐全、描述长度符合限制、`minimum_chrome_version` 合理、隐私说明与实际数据行为一致、无未使用的权限。

## 6. 测试分层

- 纯逻辑（解析、选择算法、合并流程）必须有不依赖浏览器的单元测试，并纳入 `npm test`。
- 跨上下文链路（content ↔ background ↔ offscreen ↔ popup）用集成测试覆盖，至少覆盖“消息契约 + 失败分支”。
- 需要真实浏览器的场景用 Playwright 脚本（现有 `scripts/e2e.mjs`、`scripts/shots.mjs`、`dev.mjs --smoke` 一类的自检）验证，而不是靠肉眼看。
- 修 bug 时**先补一个能复现的测试**，再改代码。

## 7. MV3 稳健性

- 不依赖 Service Worker 的全局变量保活：状态放 `chrome.storage` / IndexedDB，定时用 `chrome.alarms`。
- 需要 DOM 能力的后台任务走 offscreen document；注意它不会随 SW 休眠，别在里面堆需要回收的常驻内存状态。
- 消息通道要有超时与失败回退，`sendMessage` 的返回值统一判空，避免 SW 休眠导致的“偶发无响应”。

## 8. 文档习惯

- 每个项目至少保留：README（怎么装、怎么用、怎么开发）、技术文档（架构与关键流程）、开发日志（按版本的改动）。
- 功能提交里同步更新对应文档；接口/字段含义变化必须更新技术文档，不能只改代码。

## 9. 新增项目的骨架要求

新建扩展项目时，除功能代码外需同时具备：`manifest.json`（MV3）、`README.md`、`.gitignore`、`package.json` 的 `dev`/`build`/`test`/`check` 脚本，以及一套上述热重载机制。缺 `dev` 热重载的项目视为未完成。

# R10 网页版评估（R10-T002）

> 日期：2026-10-17 · 评估人：Claude · 结论：**现在不做网页版**；以后确有需要，走“纯静态网页、浏览器直连模型、Key 只留在这台设备的浏览器里”的方案，工作量约 2～3 天【估计】。

## 1. 结论

- 用户的重点是安卓 App，电脑上已经有 Windows 版（R10-T001 做了宽屏两栏布局）。在 Key 的安全、切到后台继续写、通知、存档可靠性这几件事上，App 都比网页好，网页版现在补不上新的场景。
- 网页版真正有用的场景，是在装不了 App 的设备上玩：iPhone、iPad，或者别人的电脑。到那时再做下面的方案 B，按第 6 节的清单来。
- 不建议做方案 C（服务器保管 Key、或者做账号系统）：要运维、要公开，还要替别人管 Key 和费用，和“个人使用”的定位不符。
- 方案 A（本机服务）已经以“浏览器开发台”的形式存在，只供开发；**不要把它开放到局域网**，那等于让同一网络里的任何设备都能用你的 Key。

## 2. 三种做法

| 做法 | 是什么 | Key 在哪 | 适合谁 |
| --- | --- | --- | --- |
| A. 本机服务 | 电脑上跑一个小服务，浏览器打开 `localhost`，服务保管 Key 并转发请求（现在的开发台就是这样） | 本机服务的文件里，页面拿不到 | 只适合本机开发；在电脑上玩不如直接用 Windows 版 |
| B. 纯静态网页 | 只有网页文件，没有后端；浏览器直接请求模型服务 | 这台设备的浏览器里 | 在装不了 App 的设备上玩 |
| C. 带后端的网站 | 服务器保管 Key 或让玩家登录 | 服务器上 | 面向很多人公开发布时才需要 |

## 3. 逐项检查

### 3.1 浏览器能不能直接请求模型服务（跨域）

网页直接请求另一个网站的接口，要对方允许“跨域”（CORS），否则浏览器会拦下。2026-10-17 实测（脚本只打印状态码和跨域相关的响应头，不打印服务地址和 Key）：

- 用户现在用的中转服务对预检请求返回 `Access-Control-Allow-Origin: *`、`Access-Control-Allow-Headers: *`，模型列表的正式响应也带这两个头。
- 在 Edge 155（Chromium 内核）的页面里，带 `Authorization` 头请求模型列表和流式对话，都到达了服务（故意用了假 Key，服务返回 401，说明浏览器没有拦截）。安卓上的 Chrome 和 WebView 都是 Chromium 内核，结果应当相同【待验证：手机浏览器实测】。
- 隐患：按规范，`Access-Control-Allow-Headers: *` **不包括** `Authorization`，必须单独列出（MDN）。Chromium 目前没有严格执行；Firefox 会给出警告【待验证：Firefox、Safari 现在是否拦截】。哪天浏览器严格执行，或者中转服务改了设置，网页版就连不上了。所以网页版的服务设置页要先检查一次跨域，连不上时说清楚原因。

### 3.2 Key 放在哪里

- App 里，Key 由 Rust 存进安卓 Keystore 或 Windows 的 DPAPI，发请求时由 Rust 加上，界面的 JS 从头到尾拿不到明文（D103）。
- 纯静态网页做不到这一点：要发请求，页面的 JS 就得拿着 Key。能读到它的有：恶意或被入侵的浏览器扩展、页面里的脚本注入（XSS）、共用这台电脑的人。
- 现在的界面把模型输出当纯文本显示，代码里没有 `innerHTML` 或 `dangerouslySetInnerHTML`（2026-10-17 检查），注入的风险较低，但扩展和共用电脑的风险网页无法消除。
- 做网页版时的办法：默认只在本次打开期间记住 Key（关掉就要重填）；可选“在这台设备上记住”，用玩家设的口令加密后再存；建议网页版单独用一个设了额度上限的 Key；页面加上内容安全策略，只允许连 `https` 地址。

### 3.3 存档放在哪里、会不会丢

- 开发台用 sql.js（WebAssembly 版 SQLite）整库放在内存里，每次写入后 1 秒把**整个数据库**存进 IndexedDB。千回合合成世界（40 个人物、30 张设定卡、每回合 600 字）的数据库是 **20.8 MB**，大部分是每回合一份的完整状态快照；在电脑上导出整库只要 4.6 毫秒，但每回合往 IndexedDB 写 20 MB，在手机上要多久没测【待验证】。
- 更合适的是 SQLite 官方 WebAssembly 版的 `opfs-sahpool` 存储方式：数据写进浏览器的私有文件系统（OPFS），只写改动的部分；不需要服务器设置特殊的响应头；代价是只能在一个标签页里打开，要放在后台线程（Worker）里运行（SQLite 官方文档）。
- 浏览器里的数据默认是“尽力保存”：空间紧张时浏览器可以不打招呼地清掉；调用 `navigator.storage.persist()` 申请持久保存后，只有用户自己清除才会删（MDN）。有资料说 Safari 对 7 天没访问的网站会清除脚本写入的数据【待验证】。所以网页版要把“导出世界”（R08-T001 已有，网页里就是下载和选择文件）放在显眼处，并定期提醒备份。
- 顺带发现并修好的问题：sql.js 导出数据库时会关掉再重开，外键检查随之失效，开发台因此一直在没有外键检查的状态下运行，掩盖了“删不掉用过记住这件事的世界”这个真实问题（提交 `35dee46`）。将来网页版如果沿用 sql.js，要用同一个 `exportDatabase()`。

### 3.4 切到后台还能不能接着写

- App 里，生成时由 Rust 把文字写进临时文件，安卓还有前台服务和“正在写下一段…”的通知（D103、D116）；切出去再回来，故事会补齐。
- 网页做不到：安卓上的 Chrome 会在页面进入后台约 5 分钟后把它冻结（Chromium 开发者邮件列表）；系统省电模式还可能更早断网。一回合通常十几秒写完（评测 A：首字 6.1 秒、全文 12.5 秒），短暂切走一般没事，但时间一长，这一回合和后台的设定集整理、章节摘要都可能中断，回来要重新生成；也没有通知可发。

### 3.5 其他

- 返回键：网页要用浏览器历史记录模拟返回（每打开一层就记一笔），电脑上已有 Esc 关闭最上层。
- 文件导入导出：开发台已经用下载和文件选择实现，可以直接沿用。
- 多开：`opfs-sahpool` 只能一个标签页使用，要在第二个标签页里提示“已在别处打开”。

## 4. 工作量

引擎是纯 TypeScript，只通过 `Platform` 接口访问存储、Key、模型请求和文件（D103），网页版只需要新写一个适配层 `src/platform/browser.ts`：

1. 存储：SQLite WebAssembly + `opfs-sahpool`，放进 Worker（或者先沿用 sql.js + IndexedDB，世界大了再换）。
2. Key：只在本次打开期间记住，可选口令加密保存。
3. 模型请求：浏览器直接 `fetch` 流式读取；开发台中转服务里的读取逻辑（`devserver/relay.ts`）可以搬进浏览器。
4. 文件：沿用开发台的下载和文件选择。
5. 系统：返回键用浏览器历史，没有通知。

再加上服务设置页的跨域检查、申请持久保存、备份提醒和测试，合计约 2～3 天【估计】。

## 5. 放在哪里

- 只在自己电脑上用：构建后在本机起一个静态文件服务即可，不涉及发布。
- 放到网上（哪怕是私人链接）：属于发布，按 AGENTS.md 要先经用户同意，并先完成 R10-T003 的许可证与公开检查。用公开仓库的 GitHub Pages 等于公开代码。

## 6. 以后要做时的清单

1. 用户确认要做，以及放在哪里（本机还是网上）。
2. 新增 `src/platform/browser.ts`（第 4 节），开发台的 `web.ts` 保持只供开发。
3. 服务设置页：保存前检查跨域，连不上时说明“这个服务不允许网页直接连接，请用 App”。
4. Key 默认不落盘；“在这台设备上记住”需要口令。
5. 启动时申请持久保存；首页显示上次备份时间，超过 7 天提醒导出。
6. 只允许一个标签页打开。
7. 手机浏览器实测：跨域、切到后台再回来、千回合世界的打开和保存速度。

## 来源（查阅日期 2026-10-17）

- MDN：[Access-Control-Allow-Headers](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Access-Control-Allow-Headers)（`*` 不包括 `Authorization`）。
- MDN：[Storage quotas and eviction criteria](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria)（尽力保存与持久保存）。
- SQLite：[Persistent Storage Options](https://sqlite.org/wasm/doc/trunk/persistence.md)（`opfs-sahpool` 不需要 COOP/COEP、不支持多标签页并发）。
- Chromium blink-dev：[Intent to Prototype: Conservative page freezing on desktop](https://groups.google.com/a/chromium.org/g/blink-dev/c/NOhYFW0rifw)（安卓上页面进入后台 5 分钟后冻结，自 M68 起）。
- Chrome for Developers：[Page Lifecycle API](https://developer.chrome.com/docs/web-platform/page-lifecycle-api)（冻结与丢弃）。
- GitHub：[buildonspark/spark #152](https://github.com/buildonspark/spark/issues/152)（Firefox 对 `*` 不含 `Authorization` 的警告）。
- Safari 7 天清除数据的说法来自第三方整理（[libredb #63](https://github.com/libredb/libredb-database/issues/63)），未核对 WebKit 原文【待验证】。

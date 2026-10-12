# M01 认证 POST 验证记录

关联任务：M01-T004 / T005；设计：[D023](../DECISIONS.md#d023-受控认证post固定一次尝试与安全诊断)。2026-10-13（Asia/Shanghai），00:48～00:59。

本轮在GET、密钥、文件和恢复探针之上增加完整认证POST链路。自动验收仅使用本机固定无效凭据；未使用保存凭据向外部服务发送请求。fixture通过不代表真实模型、Android或正式游戏通过。

## 实际交付

- [独立请求规格](../../crates/lishi-core/src/model_probe.rs)及[共享SSE](../../crates/lishi-core/src/stream.rs)：完整endpoint、model、单条user prompt、stream=true；include_usage只在请求时发送。fixture仅字面loopback HTTP，saved仅HTTPS；一次send、不重试、不redirect/no proxy，系统TLS验证保持。
- [原生服务](../../src-tauri/src/model_probe.rs)及[内部密钥读取](../../crates/lishi-core/src/secret_probe.rs)：先占用后入队，读取完成才释放；Key不作为IPC返回。取消/10秒期限不杀已开始worker，不提前释放。每次请求冻结凭据，下一次读取新配置。独立job RAII收尾，诊断仅状态/错误/次数/耗时/usage；丢弃时不推测次数。
- [面板](../../src/ModelProbe.tsx)、[IPC客户端](../../src/modelClient.ts)、国际化与手机样式；默认fixture不读取密钥状态，只有选择saved才查询bool。查询/历史不会再请求HTTP；最多十项同进程记录，退出清空。不写笔记、恢复库或正式世界。
- [POST fixture](../../scripts/model-fixture.mjs)有11个固定场景，仅监听loopback、拒绝非固定凭据、不记录请求体/认证头。源码和单次调用无原始上游错误日志。
- [统一入口](../../scripts/Verify-Dev.ps1)与[文档检查](../../scripts/check-docs.mjs)：顺序执行/失败停止，有界安全结果写入忽略.cache，不调用真实模型、不执行设备测试。

## 自动检查与修复

`./scripts/Verify-Dev.ps1 -BuildWindows -BuildAndroid -AndroidTests`全通过；JSON证据为忽略的`.cache/validation/verify-20261012T164847058Z.json`。74项Rust：20 shell、16 core unit、10新POST TCP、6pack、8recovery、4storage、10旧GET，零失败。强杀harness入口仍包含在8项recovery内，不能算作独立第六个边界。

新增21项包含10真实TCP、2凭据过滤、2内部读取及7原生任务测试；覆盖body/Authorization精确、可选usage、未知usage、非法URL/空Key零请求、401/429/redirect不重试、header/idle超时、取消与EOF（共享SSE旧测试另保留总期限检查）、上游错误正文不透出、跨JSON分片凭据回显不进event/result、worker超时/取消/drop保占用、有界历史和终态保护。部分单项内覆盖多个场景，不额外虚增测试数。

两项实际修复：usage限制为JS可精确整数，防止Rust接受而IPC客户端拒绝超大结果；默认fixture的密钥状态effect改为saved模式才触发，避免与独立SecretProbe抢同一存储占用。后一项仅修改UI，随后33模块前端、Windows与ARM64重建，并用最终exe复验。原GET行为与10项测试保留；fmt、workspace/all-targets Clippy -D warnings通过。

fixture自身9场景和非法凭据拒绝另有烟测，不计真实模型或74项Rust测试。文档检查最初11 Markdown/89链接/48任务/27决策通过，结束时再检查最终导航。

## Windows 真实链路

Playwright CLI连接实际WebView2，未伪造Tauri/HTTP DTO。

- 正常中文/emoji逐字一致：`认证 POST 已验证。\n中文分片与🙂保持完整。`。usage勾选返回10/5/15，不勾选及服务缺失均null，费用未知；每项attempts=1。
- 401/429/307均http_status且不显示错误正文中的固定凭据；redirect目标零请求。malformed usage→invalid_payload，截断→unexpected_eof，stall约10秒→idle_timeout。回显凭据跨两个文本事件→credential_echo，已显示安全前缀，凭据不进入草稿。
- 慢流编辑下一次endpoint后取消，本次仍访问冻结slow场景；查询/历史不重发，历史截断至10且只有operationId/status/errorCode/diagnostics。直接原生验证三个非法地址拒绝、保存槽missing→attempts0、重复→model_duplicate、并发→model_busy。
- 实际Channel大包Response只延后返回800ms，finally恢复真实window.fetch，fetchCount=1；4000字草稿最终仍failed/unexpected_eof，未被迟到事件改为运行或成功。未替换Response或模拟状态。
- 同进程页面重载只恢复同ID活动请求，随后取消，无HTTP重发。该步骤产生IPC fallback和旧callback警告：重载前控制台零；日志包括一次fallback及五个callback warning，重载后当前计数5。保留此上游限制，不记为零警告。
- 仅新effect修复后的最终exe冷启动历史为空；再次正常/缺usage通过；saved缺失槽禁用开始。360×780，无横溢出，三个主按钮277×44，local/sessionStorage=0，最终控制台0 errors/0 warnings。
- 主代理实际查看`output/playwright/M01-auth-mobile-form.png`、`...mobile-result.png`，标签、长endpoint、诊断换行正常。普通浏览器preview无原生，全部新操作与saved状态查询禁用；360px/storage检查通过，控制台0/0。
- 原笔记99B/修订5、恢复快照修订2及原operationId保持，存储密钥configured=false。认证探针没有更新这些数据。

以fixture烟测完成后的统计为基准，16次原生主动开始=16次HTTP且16 validated：normal4、slow2、no-usage2，余下8场景各1。三个非法地址/缺Key/去重/并发/查询/重载均未增加HTTP。所有active=0、pendingTimers=0、redirectedRequests=0；忽略证据`.cache/M01-auth-stats-before.json`及`...after.json`。这是受控传输，不是付费模型调用。

## 最终产物

最终UI修复后重新构建，两端退出0。应用APK v2签名、`zipalign -c -P16 4`及ELF四LOAD 0x4000通过；10项既有Android仪器测试编译成功，未执行。

| 产物 | 字节 | SHA256 |
| --- | ---: | --- |
| `target/debug/lishi-app.exe` | 24027136 | `5D6E99C43FF5AAB665FC0BE93FDD05AFCB65D704A4E19A9CD35EB783E40A7A07` |
| ARM64 `app-universal-debug.apk` | 211826621 | `884EF7DDD858B76321C2AB8E1EE09A14A05A581FC8EA37BDEF9917C88E04F911` |
| `app-universal-debug-androidTest.apk` | 667208 | `68FE7BAFA6E6DE0B739ACE961A8A8DD6DE32FF6A5AA59A780D5A3C0552D365A9` |

路径见[开发说明](../DEVELOPMENT.md)。最初全流程JSON记录的是第一次APK/hash；上表是随后UI修复的最终产物，二者不能混用。最终APK副本`.cache/artifacts/M01-auth-final-arm64.apk`忽略，旧基线也保留。debug体积含符号，不作为发布大小指标。

## 收尾与未执行项

自有两次Windows进程正常关闭，fixture与preview核对当前实际PID/路径后停止，自有浏览器关闭；未复用旧PID或更改用户进程。原报告SHA256保持`3326D3F7421820CD5A219682062AC4D19E8AC920A2AAACEC2E431BEAE92F38C7`，秘密、私有数据、包、QA缓存未入Git。

真实兼容服务/付费模型、Android安装/运行、HTTPS可信与错误证书、锁屏/JNI/Keystore等设备行为、release/R8均未执行。六项门槛见[设备清单](M01_DEVICE_CHECKLIST.md)；T004/T005保持待验收。生产Provider配置、游戏协议与正式回合仍待后续阶段；本探针进程退出后诊断清空。下一步及Git位置由[STATE](../STATE.md)维护。

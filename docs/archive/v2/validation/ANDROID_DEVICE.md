# Android 无线真机验收

日期：2026-10-13（Asia/Shanghai）。活动任务M01-T002～T008，附M02共用核心手机验证；唯一任务状态见[TASKS](../TASKS.md)。本记录按实际结果增补，未执行项不算通过。

## 设备与安装基线

- Xiaomi，型号代码24117RK2CC；Android16/API36，arm64-v8a；系统PAGE_SIZE=4096，不能据此宣称16KB设备运行通过。
- WebView：com.google.android.webview 153.0.8010.39；应用versionName0.0.1/minSdk24/targetSdk36。
- 首次安装APK的SHA256为`03e73f3f36087dddf731758edad46a2fc3554126affe834835bf5749cf27cf1e`（M02基线）。修复窗口后保留数据更新成功：当前APK229893065字节，SHA256 `0072e2531451a565766a72eead919bae8b0f8c463d154637b6c74f34b6b40c64`。AndroidTest APK667208字节，SHA256 `68fe7bafa6e6de0b739ace961a8a8dd6de32ff6a5aa59a780d5a3c0552d365a9`。不含M03功能；修复源码提交`c2f2d7f`（M02基线`d5373fb`），构建前后应用源码指纹一致。
- 无线二维码配对成功。配对密码仅在进程内存及用户要求的临时二维码中，图像位于忽略目录；不写明文配置或Git。连接信息仅存`.cache/device/connection.json`，下轮须用adb devices重新确认，不能硬用旧端口。
- 三次ADB保留数据安装均返回INSTALL_FAILED_USER_RESTRICTED；上传到Download后由用户本地安装成功，随后测试APK的ADB安装成功。未卸载、清数据、修改全局证书信任或上传存档。
- 使用本项目WebView实际CDP/Tauri IPC；自有转发tcp9223与reverse18741/18742，固定无效凭据的本机fixture。真实Windows Key没有复制到手机。

## 已执行证据

| 场景 | 实际结果 |
| --- | --- |
| 冷启动/核心/中文 | 应用实际启动；probe_info=android。UI发送中文/换行/emoji，回传一致，18 Unicode标量/54 UTF8字节；截图已查看 |
| SQLite | 实际UI保存66字节中文/emoji，修订1；65537字节请求note_too_large，已保存内容及修订不变；跨实际进程强杀/重开及APK更新原文、修订1保持 |
| Keystore仪器测试 | SecretStoreTest六项全部运行通过：nonce更新、删除、损坏/超限、丢失alias、跨slot复制、原子失败保旧值 |
| 文件桥仪器测试 | FileAccessBridgeTest四项全部运行通过：真实ContentResolver整文档/中文/emoji/fd关闭、截断写、非法URI/mode/丢失文件、无前端注解。不能代替SAF选择器/JNI整链路 |
| Keystore实际UI | 无效测试值保存，get_probe_secret_status仅configured=true，输入清空。实际重开/更新后仍配置；UI替换和删除通过，最终configured=false |
| Android包备份标志 | dumpsys package的flags/pkFlags没有ALLOW_BACKUP；只核对设备有效标志，不触发用户云备份 |
| GET中文流 | 实际UI请求经adb reverse访问电脑fixture；completed，3分片，中文/换行/emoji完整，未写入SQLite |
| 慢流取消 | 首个实际delta“慢速”后UI取消；cancelled/1分片，非伪造取消 |
| 认证POST | 实际UI固定fixture凭据+include_usage：completed，HTTP200，3分片，attempts1；usage10/5/15为固定夹具数据，不是付费模型统计 |
| TLS可信链 | example.com一次connect_timeout保留；Baidu的HTTPS请求达到HTTP成功后因HTML内容而invalid_content_type，证明可信链传输通过，未把它登记为SSE成功 |
| 错误证书 | 本机自签名SAN127.0.0.1，手机Rust返回network；受控服务器1连接/1 TLS错误ERR_SSL_TLSV1_ALERT_UNKNOWN_CA/0 HTTP，证书在握手阶段被拒绝；没有关闭校验或安装CA |
| 生成中强杀/重开 | 原生Channel实际观察pending/generating/首个delta后强制结束本项目应用；重开为interrupted/process_interrupted，正式恢复快照修订1/原文不变，无活动操作；SQLite修订1/66字节与Key配置true保持 |

10项仪器测试在手机执行返回`OK (10 tests)`，不是仅编译；原始结果`.cache/device/instrumentation-20261013.txt`。原生界面结果为`initial-qa-result.txt`与`network-ui-result.txt`，不含真实Key。

验收脚本修正：Playwright外层捕获浏览器对象异常会丢失code，改在page.evaluate内捕获；get_probe_stream(None)只返回活跃操作，不能用于读取完成记录，改用界面操作ID查询。两次是脚本判断错误，原生note_too_large和正常GET状态均正确，未因此改动软件或自动重发。

## 尚未执行或仍需补充

校验/事务暂停强杀；SAF损坏/超大包旧预览保持；锁屏/切后台/返回键；正式游戏完整重开逐字段对比。release/R8与16KB物理设备仍是独立待验收。源证据及结果补齐后再更新台账，不提前填M01总门槛完成。

## 真机窗口问题与修复验收

旧APK在Android16上键盘没有避让：原生截图显示IME挡住提交区，而CDP innerHeight仍853，点击被别的控件命中；状态栏也与正文重叠。修复前手机世界保持0回合，未因自动点击失败扣钱或创建回合。不能用forceclick绕过后声明手机输入通过。

MainActivity增加根容器systemBars/displayCutout/ime联合insets，保留初始padding、消费已处理边距，并使用adjustResize。APK重建、签名/ZIP16KiB/4个ELF LOAD0x4000与包内so一致性通过，源码指纹前后相同：`.cache/validation/m02-android-20261013T104052669Z.json`。保留数据安装新APK后实际普通点击十回合成功；关闭键盘viewport384×810、scrollWidth384。用户在手机输入中文并确认“输入、提交按钮和布局正常”。未用forceclick替代真实输入。较低Android版本仍需后续设备覆盖。

技术页面两处旧阶段文案修正；Windows同步构建成功（`.cache/device/windows-insets-build.txt`），exe25947136字节/SHA256 `2c0235da0bf0a325ef32b9391a9de75cb9bcec521426032d62c6c287a842e2ad`，不改M02协议或存档。

## M02 手机固定十回合与文件系统

手机世界`57cccc5a-fc4d-4328-8a4b-6681d4409690`（Android无线验收·中文十回合），秦/公元前221年/咸阳/李明。实际UI自由行动与两次继续累计10提交；现金110记账单位、elapsedSeconds46800、伤病已解决、主角存活。完整WorldView保存在忽略的`.cache/device/game-ten-baseline.json`；这次是固定演示，没有调用手机真实模型或复制生产Key。

SAF系统选择器通过JNI全链路导出43字节中文/换行/emoji，文件`历史穿越-技术探针.lishi-probe`235字节；实际再选择导入的预览逐字一致：`Android中文文件往返🔑`加换行`第二行🙂`。Android返回键取消选择器后保留先前预览和编辑内容。损坏/超大测试仍待补证；原始文件结果见`.cache/device/file-import-confirmed.txt`和`file-cancel-result.txt`。技术包只含测试文字，不是正式.timejump游戏导出。

## 来源

[Android ADB无线指南](https://developer.android.com/tools/adb#wireless)、[AOSP无线ADB架构](https://android.googlesource.com/platform/packages/modules/adb/+/HEAD/docs/dev/adb_wifi.md)、[AOSP二维码解析](https://android.googlesource.com/platform/packages/apps/Settings/+/refs/heads/main/src/com/android/settings/wifi/dpp/AdbQrCode.java)，查阅2026-10-13。二维码格式和mDNS服务由官方规格核对；实际配对结果按本机/手机记录。

窗口修复依据：[Android edge-to-edge/insets](https://developer.android.com/develop/ui/views/layout/edge-to-edge)、[软键盘布局](https://developer.android.com/develop/ui/views/layout/sw-keyboard)，查阅2026-10-13。实际结果限本机型与debug产物。

## 本轮收尾与可重复入口

最终本地128项Rust、fmt/Clippy、37模块前端、fixture语法和文档检查通过，记录`.cache/validation/verify-20261013T111940049Z.json`。原报告校验不变；194个Git候选文件的秘密模式检查无命中。二维码助手审查后限制输出/result在项目.cache，修正完整mDNS名称与过期result，Python编译及模拟场景通过；修订后未重复真实扫码。

手机切到其他应用后暂不抢占前台；已询问方便时保持本项目应用前台，未收到回复，因此后续边界保留未运行。损坏文件已在SAF选取，但未取得校验结果，不能算拒绝测试通过。下轮先重新导入好包恢复预览，再验证坏包/超限。两个带日期的lishi-qa测试包仍在Download，属本轮自有夹具；好的中文导出与手机固定世界保留，未清数据。

自有CLI/CDP已detach，forward9223与reverse18741/18742/18743移除，两个fixture进程停止，TLS helper已退出；临时配对二维码删除。配对信任、应用、中文笔记/世界不动。恢复测试需要先重新启动fixture、确认设备serial、开启本项目应用并重新附着当前PID。剩余具体操作见[STATE](../STATE.md)。

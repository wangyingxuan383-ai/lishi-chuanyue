# 当前工作现场

> 更新时间：2026-10-13T01:05:00+08:00｜里程碑：M01｜下一独立工作：Android release/R8 与 JNI 保留验证

用户暂缓真机；按D018继续可独立的M01工作，M01-T008门槛保持，M02玩法尚未开始。唯一任务状态见[TASKS](TASKS.md)。本轮T004受控认证POST源码、自动化、Windows和两端debug包证据已登记，实际模型/设备仍待验收。

## 最后确定成功的步骤

- 共用界面/独立Rust、SQLite、GET流式取消、平台密钥、文档包和持久恢复保持既有证据；本轮没有修改测试笔记99B/修订5、恢复快照修订2或保存密钥（槽missing）。原报告hash未变，无远程上传。
- 新认证POST使用显式endpoint/model/prompt及可选usage；fixture只用原生固定无效值与字面loopback，saved仅HTTPS并在原生读取SecretValue。一次send、无重试/redirect/fallback；同进程十项安全诊断和状态查询不重发HTTP。D023记录数据流和限制。
- 共享SSE拦截跨分片原样凭据回显；usage严格整数/总和/JS精度，未知价格保持未知。密钥读取先占用再入队，取消/超时/drop不提前释放running worker。RAII请求收尾，迟到事件不降低终态。
- workspace74项、fmt/Clippy -D warnings、33模块前端通过；Windows16主动开始=16有效HTTP，中文/用量/错误/超时/取消/去重/并发/非法地址/缺Key/800ms大Channel/重载通过。默认fixture多读密钥状态已修复，最终exe再次验收。
- 最终Windows/ARM64 debug重建与签名、ZIP/ELF16KiB检查通过；10项Android仪器测试只编译。最终原生及普通浏览器360px无横溢出，0 errors/0 warnings；重载测试另有旧callback与IPC fallback警告，保留事实。
- `Verify-Dev.ps1`顺序检查并留下安全JSON；`check-docs.mjs`检查UTF-8/导航/任务/决策/依赖。初次全流程记录与最终UI修复包hash不同，准确产物和场景见[认证记录](validation/M01_AUTH.md)，命令见[开发说明](DEVELOPMENT.md)。

## 下一步可执行动作

1. 认领M01-T002/T004/T005的release验证子范围：先读Android app/build.gradle.kts的release optimization、app/proguard及插件consumer规则，核对Tauri CLI选项和签名默认。使用本地未发布产物，不新建用户正式签名Key、不上传；记录是否unsigned/debug签名，不把包构建当设备验收。
2. 在全部writer冻结后运行受控ARM64 release构建；检查R8后Verifier/SecretStore/FileAccess JNI bridge及入口仍存在、ELF/ZIP16KiB兼容，记录源码/产物/hash/失败修复。若缺签名只保留unsigned技术产物与具体限制，不要求用户现在真机。
3. 实际兼容端点有用户配置后才做有限真实请求；不能从fixture推定模型能力。有设备后按[六项清单](validation/M01_DEVICE_CHECKLIST.md)做安装、可信HTTPS/错误证书、Keystore/SAF/强杀等真实记录。

## 限制与恢复安全

游戏Schema/开局/正式回合/长期记忆/分支/.timejump尚未实现。认证probe配置/诊断只在内存，不混入恢复库；进程重开历史为空。原GET草稿也仅内存；恢复库只让committed技术快照正式可见。平台worker永久停滞需重开；取消不承诺远端不收费，JS/Tauri/JVM所有秘密副本不能保证清零。

真实设备/模拟器、AndroidHTTPS/JNI/Keystore/SAF/生命周期与release/R8未验收。移动picker合并取消与错误，provider失败可能留部分外部文件。原样凭据过滤不涵盖变形编码。旧Channel重载warning不是请求重试，详情保留验证记录。

自有两次原生应用正常关闭，fixture/preview检查当次PID与路径后停止，自有浏览器关闭；1421/18742/9222/9223/18741无监听，无writer或构建。不要复用.cache旧PID。APK/测试包/截图/诊断/私有数据库全部忽略。

## Git现场

分支main；本轮起点56ca52c，认证源码/脚本/验证基线2bf2a2e。24个自有文件已提交，3300余行主要为完整请求链路和测试；本现场回填随后单独文档提交，最新位置以git log -1与git status核对。无遗留源码修改；原始报告未改，秘密/产物未入库。

恢复顺序：AGENTS → README → STATE → TASKS相关M01项 → PLAN/DECISIONS → 实际源码与验证。待验收不能推定手机或真实模型成功。

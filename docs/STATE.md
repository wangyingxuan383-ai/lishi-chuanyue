# 当前工作现场

> 更新时间：2026-10-12T13:24:31+08:00｜当前里程碑：M01｜下一任务：M01-T005

M00与M01-T001已完成。M01-T002/T003/T004已有源码、Windows实测与ARM64 APK，设备/真实模型部分待验收。用户“暂时不用真机”，按D018继续独立探针，保留M01-T008门槛。游戏尚未实现；唯一任务状态见 [TASKS](TASKS.md)。

## 最后确定完成的步骤

- 共用React界面、Tauri原生壳、独立Rust核心和Android工程已建立；文案使用src/i18n.ts的类型安全键。
- Windows真实IPC中文/换行/emoji/空文本通过；SQLite五项隔离测试、后台IPC、真实UI保存/超限拒绝、正常关闭后重开恢复通过。未将笔记重开记成完整强杀恢复。
- 流式HTTP/SSE、取消、草稿内存查询和操作注册已实现。18项核心测试、fmt/clippy/前端构建通过；Windows15次主动启动=15次HTTP，中文/断流/错误/超时/取消断连及同进程重载查询通过，未新增模型或数据库写入。
- 最终Windows debug exe与ARM64 APK构建成功；APK签名/ZIP及ELF16KiB对齐通过，未安装手机或验证16KiB设备运行。产物/hash与修复细节见 [M01验证](validation/M01.md)。
- Android TLS初始化、匹配Kotlin组件与发送前ready检查已接线，DEX含Verifier；D019记录JNI桥与信任链。编译/静态检查不代表手机HTTPS或错误证书拒绝已通过。
- 工具路径、环境脚本、测试和启动入口见 [DEVELOPMENT](DEVELOPMENT.md)。原报告hash保持不变；无真实模型请求、远程仓库或公开发布。

## 下一步可执行动作

1. 认领M01-T005；先读D004/D011和该任务验收，在纯核心定义SecretStore契约，平台实现Windows当前用户DPAPI与Android Keystore AES-GCM插件。
2. 做保存/存在/内部读取/删除、重开和错误路径验证；前端只查看状态，不读回明文，密文放应用私有目录且不进Git/存档/日志。先隔离测试假token，再补原生面板。
3. 接入完整原生壳并构建Windows/ARM64；手机实测继续暂缓，不能虚构Keystore运行或丢失密钥后的恢复结果。
4. 实际兼容模型端点在安全配置可用后验证；当前T004不支持认证POST，不把GET fixture当Provider。不进入M02玩法扩张。

## 已知限制与当前进程

SecretStore、文档URI和操作持久强杀恢复未实现。草稿/最近十项操作只在进程内存；重载查询不是进程恢复。Tauri重载存在旧callback警告，Windows查询/取消仍正常；详见验证记录。WHPX未启用，无设备/模拟器运行证据。

本轮QA应用已正常关闭、fixture已核对归属后停止，18741/9222无监听；无活动构建、Vite或代理写入。额外最终CDP重启组合命令被执行策略拒绝，未运行且未记成功。不要按旧PID停止进程，继续前重新核对现场。Schema/JNI链接、缓存、产物、诊断、笔记数据库和本机配置均被忽略。

## Git与恢复

分支main，前次HEAD dc63fb0；本轮流式/操作管理、Tauri/TLS桥、前端/fixture、Gradle与锁文件、计划/台账/证据均已验收相应边界，正在保存本地提交。提交前的未提交变化全部属于本轮，不删除；最终位置用git log -1与git status核实。无远程发布。

恢复顺序：AGENTS → README → 本文 → TASKS的M01-T005及依赖 → 相关PLAN/DECISIONS → 实际源码/验证记录。三项任务待验收表示有实物与部分证据，不能推定Android/真实模型已通过。

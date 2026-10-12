# 当前工作现场

> 更新时间：2026-10-12T18:53:17+08:00｜当前里程碑：M01｜下一任务：M01-T006

M00与M01-T001已完成。M01-T002～T005已有源码、Windows实测与ARM64 APK，设备/真实模型部分待验收。用户“暂时不用真机”，按D018继续独立探针，保留M01-T008门槛。游戏尚未实现；唯一任务状态见 [TASKS](TASKS.md)。

## 最后确定完成的步骤

- 共用React界面、Tauri原生壳、独立Rust核心和Android工程已建立；文案使用src/i18n.ts的类型安全键。
- Windows真实IPC中文/换行/emoji/空文本通过；SQLite五项隔离测试、后台IPC、真实UI保存/超限拒绝、正常关闭后重开恢复通过。未将笔记重开记成完整强杀恢复。
- 流式HTTP/SSE、取消、草稿内存查询和操作注册已实现。18项核心测试、fmt/clippy/前端构建通过；Windows15次主动启动=15次HTTP，中文/断流/错误/超时/取消断连及同进程重载查询通过，未新增模型或数据库写入。
- 最终Windows debug exe与ARM64 APK构建成功；APK签名/ZIP及ELF16KiB对齐通过，未安装手机或验证16KiB设备运行。产物/hash与修复细节见 [M01验证](validation/M01.md)。
- Android TLS初始化、匹配Kotlin组件与发送前ready检查已接线，DEX含Verifier；D019记录JNI桥与信任链。编译/静态检查不代表手机HTTPS或错误证书拒绝已通过。
- SecretStore契约、DPAPI、Keystore/JNI、密码框/仅bool状态及入队前owned占用已实现；workspace31项/Clippy/两端构建通过。Windows保存/替换/非法保护/正常重开/删除与最终IPC复核通过，fake槽已删除；6项Android测试APK已编译但未运行，D020与验证记录保存边界。
- 工具路径、环境脚本、测试和启动入口见 [DEVELOPMENT](DEVELOPMENT.md)。原报告hash保持不变；无真实模型请求、远程仓库或公开发布。

## 下一步可执行动作

1. 认领M01-T006，先读D002/D007与文件URI相关计划；核实Tauri Dialog/Android SAF返回URI及权限行为，定义窄FileAccess接口。
2. 在同一技术探针做选择/保存/取消、content URI→私有临时复制→验证与中文名称/损坏包路径；不用URI直接打开SQLite，不扩大成完整.timejump实现。
3. 核心/Windows检查与ARM64构建后记录实际证据；手机文件选择/权限/后台行为保持待验收，不擅自开启系统备份或导出秘密。
4. 实际兼容端点尚未配置，当前T004不是认证POST Provider；后续M02安全配置仍受完整M01门槛约束。

## 已知限制与当前进程

文档URI与操作持久强杀恢复未实现。草稿/最近十项操作/密钥操作占用只在内存；10秒等待未知不等于后台worker已取消，长期停滞需重开。JS/Tauri/JVM明文副本不能保证全部擦除。Tauri重载仍可能有旧callback警告；WHPX未启用，无设备/模拟器运行证据。

最终QA应用已正常关闭，fake测试槽已删除；9222/18741无监听，无活动构建/Vite/代理writer。不要按旧PID停止进程。Schema/JNI链接、缓存、两类APK、诊断、笔记数据库和机器配置均被忽略。产物/hash及仪器测试未运行事实见M01验证。

## Git与恢复

分支main，前次HEAD79bd63a。T005的core/shell依赖、secrets/service、平台适配/备份规则、前端、Android测试与台账/证据均在本轮范围，正在保存本地提交；实际最新位置用git log -1与git status核实。无真实Key/模型请求、远程发布；原报告hash不变。

恢复顺序：AGENTS → README → 本文 → TASKS的M01-T006及依赖 → 相关PLAN/DECISIONS → 实际源码/验证记录。四项任务待验收表示有实物与部分证据，不能推定Android/真实模型已通过。

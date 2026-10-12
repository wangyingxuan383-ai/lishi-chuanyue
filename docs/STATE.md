# 当前工作现场

> 更新时间：2026-10-13T00:21:28+08:00｜当前里程碑：M01｜下一独立工作：M01-T004受控认证POST

T006/T007本地实现与验证已登记，设备验收保留。用户“暂时不用真机”，按D018继续不依赖设备的M01工作；M01-T008门槛不变，M02游戏尚未开始。唯一任务状态见 [TASKS](TASKS.md)。

## 最后确定成功的步骤

- React/Tauri/独立Rust核心及Android工程已建立；中文、SQLite、流式取消、DPAPI与Keystore源码、TLS初始化均有既有证据。
- 新文件探针只打包显式文本。系统picker→私有stage→严格验证→预览；Windows中文/emoji路径导入、导出、取消、损坏、超限与前端权限拒绝通过，不覆盖原笔记或导出秘密。D021记录临时URI/worker/fd与provider限制。
- 新恢复库独立保存操作/候选/正式快照；owner先于壳的stage清理与笔记初始化。五个子进程握手边界强杀全部通过；Windows生成/校验/事务三处真实强杀重开保基线且无自动HTTP重发。第二实例明确Busy、首实例stage保留。
- 已修复大Channel晚到与旧查询降低持久终态；真实Response延迟800ms回归通过。正常二次提交/重开为修订2，原笔记99字节/修订5保持、密钥测试槽missing。D022区分技术快照与正式世界。
- workspace53项、fmt/Clippy与前端构建通过；最终Windows与ARM64应用包重建成功。应用/测试APK签名、应用ZIP/ELF16KiB、DEX桥与Manifest检查通过；10项Android仪器测试只编译、未执行。
- 产物/hash、Windows详细证据与失败修复见 [M01记录](validation/M01.md)；实际命令见 [DEVELOPMENT](DEVELOPMENT.md)。原报告hash保持不变，无真实模型请求或远程发布。

## 下一步可执行动作

1. 读取T004现有stream/fixture、T005 SecretStore和D010/D019/D020；先定义M01受控认证POST探针的最小请求、凭据读取与安全诊断边界，补入原任务范围后实现。仅用本地假凭据验证请求体/流式/错误/取消/单次请求；不用前端读密钥，不自动跨服务重试，不扩大成M02游戏配置。
2. 继续保留实际兼容端点、Android HTTPS可信链/错误证书与设备执行为未验证；有用户配置或设备条件后才执行相应有限测试。
3. 用户恢复手机测试时按 [六项清单](validation/M01_DEVICE_CHECKLIST.md) 核对设备与两包，再登记真实结果；不能以源码、Windows或测试APK编译替代M01-T008。

## 已知限制与进程

游戏Schema/开局/正式回合/长期记忆/分支/.timejump均未实现。原流式面板仍是内存结果；恢复面板的候选可暂存，但只有committed快照正式可见。SecretStore队列占用不是持久回合恢复。caller期限不杀已运行worker；原生I/O永久停滞需重开，Android后台持续生成不承诺。

移动picker把取消与选择器错误合并为未选中；provider写失败可能留部分外部文件。真实设备/模拟器、Keystore/JNI/SAF/锁屏/强杀、release/R8和物理断电均未验收。JS/Tauri/JVM所有秘密副本不能保证擦除。原流式面板重载曾有旧callback警告，未抹去历史。

最后owned应用已正常关闭，fixture核对归属后停止；9222/9223/18741无监听，无活动writer/构建。不要复用文档或.cache旧PID。截图、两类APK、测试包、隔离WebView缓存、日志与私有数据库均忽略；自有桌面包与stage marker已清理。

## Git与恢复

分支main；本轮源码/验证基线5c55ad2，起点08edb27。本现场回填随后单独文档提交，实际最新位置以git log -1与git status核对。源码、计划/台账、决策、验证与交接均保留本地历史；未上传或创建远程仓库。

恢复顺序：AGENTS → README → 本文 → TASKS的M01-T004及T005依赖 → 相关PLAN/DECISIONS → 实际源码与验证记录。待验收表示平台证据尚未齐备，不能推定手机或真实模型通过。

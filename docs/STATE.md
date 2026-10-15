# 当前工作现场

> 2026-10-15（Asia/Shanghai）｜M06主要工程已接入，设备与真实模型验收仍保留。

用户在M05交付后授权继续M06；手机“先开发，稍后测”有效。本轮无ADB/安装/清数据/生产Key读取，0真实模型/Brave请求，无远程仓库、发布或上传。分支main，前一基线8e06b65，本轮M06实现随本文件同次保存本地Git；恢复用git status/git log定位提交与后续变化，不覆盖新变化。阅读顺序按AGENTS，状态唯一来源[TASKS](TASKS.md)。

## 最后确定成功的步骤

- 七页持续挂载、忙碌返回/取消、每world/branch窗口草稿、输入快捷键、技术页懒加载保留Game。隔离UI141/141通过，四尺寸15图目检，零console错误/警告；操作见[使用说明](USER_GUIDE.md)。
- 正式timejump：有界容器、一致世界/注释快照、冻结研究和可读剧情、只读精确schema/领域证明、整目录发布，同ID不覆盖。独立证据库保持水位101→102及旧子线隔离。pack15/portable12/save8通过，含旧v1两回合原始指纹、恶意schema、重复及发布前后真实强杀。D039及[M06契约](contracts/M06.md)。
- 调用台账覆盖普通v1/v2、FF、AI回顾、连接测试，最多两次持久预留，实际0/1与中断未知分开；无Key/prompt/响应/endpoint、不进包。core7/native故障7/UI41通过；AI回顾最后接线七项顺序复测通过。D040；M06-T004已完成。
- 全workspace418通过/0失败/0忽略/0过滤，含66原生及300回合长局（原生396.39秒）；最后summary接线七项复测通过。fmt/strict全workspace Clippy、64模块前端和两端debug构建通过。证据见[M06验证](validation/M06.md)。
- Windows最终包关闭自有Vite1420后冷启动为tauri.localhost；七页、技术页返回、360px和调用记录按钮正常。七个既有world head/count逐一保持、Provider revision7保持、当前游戏模型台账0次。未对用户正式世界提交行动。

M03～M05已建立长期状态/300回合/十线隔离、分叉重写有限更正、分段快进/决策暂停、可选Brave/冻结来源，参见[M03](validation/M03.md)、[M04/M05](validation/M04_M05.md)。不要重复实现已验收核心。

## 产物与现场

- Windows：target/debug/lishi-app.exe，35026432B，SHA d4a158b03006b9c68f0c070e3a39904f702a604f25c437c39707080eab5eab43。pnpm tauri build --debug --no-bundle已内置界面，可直接运行；普通cargo/tauri dev可能仍依赖Vite，见[开发说明](DEVELOPMENT.md)。
- Android ARM64 debug：src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk，527311837B，SHA 352b5685de6f6acb9614d6d17a9cc965a2738b3047b410992870c9dc44aa5e86。签名v2、ZIP16KiB、四段ELF0x4000、包内外so一致；未安装。手机仍旧M03包，新布局/正式包迁移未真机验收。
- 代理writer全部结束，root整合；自有4177/UI浏览器、1420和最终9224 QA进程均已关闭，缓存PID只作历史证据，操作前须核实实际exe路径。恢复不自动操作手机/生产API。
- 本轮实现与文档统一本地提交；秘密、真实DB、诊断和构建物排除Git。证据.cache/m06-*可供本机复查，永久结论已写验证文档。原报告SHA3326D3F7421820CD5A219682062AC4D19E8AC920A2AAACEC2E431BEAE92F38C7不变。

## 未完成与下一步

1. M06-T001/T002/T003待验收：工程已接入，剩新包手机IME/旋转/后台、系统选择器好/坏/大/取消及Android↔Windows正式包迁移。M01-T006设备门槛仍未结束；仅在用户恢复手机测试后用短清单验收，不重复催测。
2. M06-T005进行中：固定回归与离线证据齐全，待上述前置实际验收后完成综合结论。下一轮先选择明确缺口；无新变化/失败时不重跑已过300回合、全量构建或真实请求。
3. M06-T006尚未开始真实评测：新v4/FF/AI回顾及真实Brave未验收，此前新协议请求503。先确认服务和有限样本预算，再执行明确一次评测，不自动轮询/跨服务重试，不以mock当真实质量。
4. M06-T007正式交付尚未开始：debug可用，release/R8、版本/签名/应用名策略及保数据升级后续独立验收；无许可证选择或发布授权。
5. 已知范围：更正仅姓名/本人可知cash；未实现完整史历、分支合并、同ID覆盖恢复、压缩/更大包、单价估算和游戏stage启动回收。强杀stage不可见、正常失败会清理；SAF失败可留外部部分文件。物理断电无实测。

可安全重做node scripts/check-docs.mjs，定向cargo测试见契约。正常Windows启动不带CDP参数，无需Vite。

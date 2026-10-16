# 私人构建与交付

> 2026-10-16，Asia/Shanghai。当前在完成M06验收，不是公开发行声明。任务状态见[TASKS](TASKS.md)，手机按用户选择稍后测试。

## 已有本地产物

当前产物含Prompt8、输出诊断和M06-T008本机单价/费用估算；对应本轮最终源码，不需要旧debug或Vite。

| 产物 | 位置 | 已验证范围 |
|---|---|---|
| Windows优化程序 | target/release/lishi-app.exe | 25979392B；含Prompt8/输出诊断/费用；无Vite正常冷启动，五视图/快进/43条调用及配置重读一致 |
| Android私人优化预览 | .cache/deliverables/lishi-optimized-preview-20261016-v8-cost.apk | 32955795B；含同一核心；优化Rust/R8、签名v2、与现有debug证书一致、ZIP/ELF16KiB、关键JNI入口与Verifier保留 |
| Android未签名优化包 | src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release-unsigned.apk | 32892164B；仅作构建中间件，未签名不能安装 |

Windows SHA256：658d7c761605f90a3538b5944bbeda14e33cac8c764da3e9bc321b957c7c7084。

私人预览APK SHA256：0a5df96e5922cb2b9f92d8d0dab25a93e4d0b358fa291c86122c0d3b78ee5f16。未签名包SHA256：9b4e520b87e63fe35fd18f02d7d20ea95f760c9fa6bb857b1ddbfd4305ceb989。包内native为31170672B、SHA256 9bceb5a1f885e45b257731035e4082df8814d351569e4eed8fbc5c6cc463da98，与本轮编译原件完全一致。

原debug APK为527311837B；当前优化预览约33.0MB。实际应用仍为io.timejump.lishi/版本0.0.1（versionCode1），手机名称仍Lishi Probe；文件名v8指Prompt版本，不是应用版本。旧v5/v7/v8无费用预览保留，不能当本次最终包。功能/真实模型/设备未验收前不虚改为已完成v0.1。Windows为单exe，没有制作安装器或公开签名。

验收前不要删除原世界、卸载应用或清数据；本轮没有自动安装任何包。预览签名一致说明具备覆盖升级的签名前提，不证明手机实际保留数据升级已通过。

## 可复现构建与检查

先按[开发说明](DEVELOPMENT.md)配置已锁定的Rust、Node、JDK、SDK36和NDK28.2。在项目根目录执行：

```powershell
. ./scripts/Enter-Dev.ps1
pnpm tauri build --no-bundle
pnpm tauri android build --target aarch64 --apk --ci

# 不安装、不调用模型；未签名检查需明确允许，仍检查R8及实际包内ELF。
./scripts/Verify-AndroidPackage.ps1 `
  -ApkPath src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release-unsigned.apk `
  -Profile release -AllowUnsigned -RequireR8
```

构建顺序可串行，避免重复竞争Cargo输出；不要在相同test exe尚运行时重新链接该exe。Windows不打安装器的优化程序内置界面；正常启动无需Vite、CDP或调试环境变量。首次优化编译耗时与增量编译不同，不据一次耗时承诺固定构建速度。

Verify-AndroidPackage.ps1调用仓库内Python标准库验证器，不读取设备、游戏存档或API凭据。它检查应用ID、实际debuggable标志、v2签名/参考证书、ZIP条目唯一和对齐、实际打包ARM64 ELF LOAD、编译原件或明确strip后的SHA一致；解析DEX class_data确认RustSecretStoreBridge、RustFileAccessBridge、SecretStorePlugin、DocumentPickerPlugin四类及七个实际方法定义，不仅检查引用字符串，还核对Rustls verifier。RequireR8核对实际mapping。静态保留不能替代手机上真实HTTPS、Keystore、选择器及生命周期测试。

最终构建/签名日志为本机.cache/m06-windows-release-build-r6.txt、m06-android-release-build-r6.txt、m06-preview-sign-r6.txt；APK旁checks.json保存独立结果。四段ELF LOAD均0x4000，release实际debuggable=false。验证器六项拒绝负例、签名成功/失败但无有效产物的两项故障注入均未发布坏包，最终真实签名路径通过。费用版新增10核心/3原生/271UI及实际原生保存、重启与清除通过，五视图/快进/43条调用/Provider配置重启一致见.cache/m06-cost-restart-check.json与[费用验证](validation/M06_COSTS.md)。

此前无费用v8 Windows为25771520B、SHA256 f7356d331007e653724d6d688c17027f4eb2f9c9442c04ce415acbd861b6f797，实际完成最后一次模型样本（默认8192内输入8095B）和重启；费用版没有追加模型请求。Windows文件选择器测试在更早优化v5执行，数据又在最终费用版重启核对；不宣称最终版重复打开了全部对话框。

## 私人预览的签名连续性

按[D041](DECISIONS.md#d041-私人优化包与签名连续性)，私人优化包沿用本机已安装测试系列的签名；参考debug APK的公开证书SHA256为6c4ba426a636d55ccf5feda905f13e851d30ac96e34bd09aca315cdca65fe91e。校验必须匹配参考证书，不会通过更改applicationId或卸载应用规避冲突。

Sign-AndroidPreview.ps1需要显式输入未签名包、参考APK、现有keystore位置和新输出名。密码通过本进程环境LISHI_SIGNING_STORE_PASSWORD（密钥密码不同时另用LISHI_SIGNING_KEY_PASSWORD），不要写进命令参数、文档、日志或Git。脚本仅允许在本项目.cache/.private输出新APK，拒绝覆盖已有文件；签后自动执行完整检查和参考证书比对，不包含ADB/安装功能。

```powershell
# 先在当前进程安全设置签名环境变量；此处不提供任何真实签名密码。
./scripts/Sign-AndroidPreview.ps1 `
  -UnsignedApk src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release-unsigned.apk `
  -ReferenceApk src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk `
  -KeystorePath $yourExistingKeystore `
  -OutputPath .cache/deliverables/your-new-private-preview.apk
```

保留并自行安全备份现有签名材料，不能随意重建。测试签名仅用于私人验收；首次公开/商店发行前建立长期签名和备份，设计旧测试安装的存档导出迁移，不把测试签名当公开发行方案。项目当前没有创建远程仓库、上传或选择公开许可证。

## 安装与恢复门槛

手机可测时先记录当前世界/head/笔记、导出可用备份，再安装匹配签名的预览；按短清单验证原世界、API配置状态、中文键盘、后台/锁屏/进程终止、世界线与快进，以及系统选择器好/坏/取消/大包和跨端迁移。不要通过删除用户存档换取“通过”。有问题时保留原备份和失败记录，退回已知可用构建前核对版本与迁移兼容，不能强装降级后假定数据库可读。

真实模型验收方法见[评测协议](validation/M06_EVAL_PROTOCOL.md)。当前真实输出、费用、历史不确定性与手机体验要分别给结论；三十回合未完成或关键错误未解决时不得把整个M06标完成。

2026-10-15核对的技术依据：[Android应用签名](https://developer.android.com/studio/publish/app-signing)、[R8保留规则](https://developer.android.com/topic/performance/app-optimization/keep-rules-overview)、[16KB页面](https://developer.android.com/guide/practices/page-sizes)。实际检查记录保存在本机.cache/m06-*及APK旁checks.json，永久结论登记[M06验证](validation/M06.md)。

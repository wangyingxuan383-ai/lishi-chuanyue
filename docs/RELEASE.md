# 私人发行包（R08-T005）

> 2026-10-17 · 只给用户自己用。0.8.0 起放在用户 GitHub 账户下的私有仓库（https://github.com/wangyingxuan383-ai/lishi-chuanyue）的 Releases 里，不公开（D126）。任务状态见[任务台账](TASKS.md)。

## 版本号

- 版本号写成“主.次.修订”，三处保持一致：`src-tauri/tauri.conf.json`、`package.json`、根目录 `Cargo.toml` 的 `[workspace.package]`。
- 次版本跟着阶段走：0.1 = R02，0.2 = R03，0.3 = R04，0.4 = R05～R07，**0.5 = R08（私人稳定版）**，0.8 = R09，1.0 = R10。阶段验收没通过时版本号照样可以用，它说明包里有什么，不代表验收结果。
- 每次给用户新包，修订号加一（0.5.0、0.5.1……）。
- 安卓的内部版本号由 Tauri 自动算（主 × 1000000 + 次 × 1000 + 修订），只增不减，新包才能覆盖安装旧包。

## 构建与签名

```powershell
. ./scripts/Enter-Dev.ps1
pnpm tauri android build --target aarch64 --apk --ci
# 用本机调试证书签名并检查（密码是安卓调试证书的默认值，只放在本次进程的环境变量里）
$env:LISHI_SIGNING_STORE_PASSWORD = 'android'
./scripts/Sign-AndroidPreview.ps1 `
  -UnsignedApk src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release-unsigned.apk `
  -ReferenceApk src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk `
  -KeystorePath $HOME/.android/debug.keystore `
  -OutputPath .cache/release/chuanyue-0.5.0.apk
```

- **为什么用调试证书签名**：安卓只允许同一个证书签名的新包覆盖旧包。私人版一直用本机的调试证书，调试包和发行包就能互相覆盖安装、保留存档；换证书就只能卸载重装，存档会丢。将来公开发行再换正式证书（届时要提醒用户先导出世界）。
- **检查内容**（`Verify-AndroidPackage.ps1`，不连手机、不读 Key）：应用 ID、不是可调试包、v2 签名且证书与参考包一致、ZIP 与 16 KB 对齐、包里的 ARM64 原生库与编译原件一致、关键的 Rust 桥接类都在。
- v3 的发行包暂时不做 R8 精简（Tauri 默认），包会大一些；精简要等在手机上测过再开。

Windows 版（单个程序，不做安装包）：

```powershell
pnpm tauri build --no-bundle    # 产物 target/release/lishi-app.exe
Compress-Archive -Path target/release/lishi-app.exe -DestinationPath .cache/release/chuanyue-<版本>-windows-x64.zip
```

## 发布到 GitHub

- **每次推送和发布都要先得到用户同意**（AGENTS.md；D126 只覆盖 0.8.0 这一次）。仓库是私有的，改成公开之前要先定许可证（[公开前检查](validation/R10_PUBLIC.md)）。
- 推送前：暂存后跑 `node .cache/v3-edit/scan.mjs`，推送前跑全历史扫描 `node .cache/v3-edit/scan-history.mjs`（两个脚本在本机、不入 Git，只输出计数）。
- 发布：给发布用的提交打标签 `v<版本>`，`gh release create v<版本> --prerelease --title "历史穿越 <版本>" --notes-file <说明> <apk> <zip>`；还没在手机上验证过的版本标为预发布。

## 给用户安装

两种方式，**都不要先卸载**（卸载会删掉所有世界）：

1. 手机和电脑无线配对后，由电脑执行 `adb -s <设备> install -r <apk>`（`-r` 表示覆盖安装、保留数据）。
2. 把 apk 文件发到手机，在文件管理里点开安装；提示“更新”就对了，如果提示“签名不一致”就停下，不要卸载。
3. 在手机浏览器里登录 GitHub，打开仓库的 Releases 下载 apk 再安装（私有仓库要先登录）；同样提示“更新”才继续。

装好后检查：首页的世界都在、能继续游玩；设置里的 AI 服务还在（Key 存在系统的加密存储里，升级不会丢）；版本号显示为新的。

## 注意

- 用户的 AI 服务是 HTTP 地址。发行包的安卓配置不允许网页里的明文 HTTP，但模型请求由 Rust 直接发出，不经过网页，应当不受影响【待验证：发行包在手机上实际连一次】。
- 旧版 v2 应用（Lishi Probe，`io.timejump.lishi`）和 v3（`io.timejump.chuanyue`）是两个不同的应用，可以同时在手机上，互不影响（D110）。

## 产物记录

| 版本 | 文件 | 大小 | SHA-256 | 检查 | 手机验证 |
| --- | --- | --- | --- | --- | --- |
| 0.8.0（内部版本号 8000） | `.cache/release/chuanyue-0.8.0.apk`（不入 Git；[GitHub 发布](https://github.com/wangyingxuan383-ai/lishi-chuanyue/releases/tag/v0.8.0)） | 22,855,395 字节 | `bd4d2754739168f6ffb4d68b301cb24578467dc593173dd8d65f859aa587fa53` | 通过：`io.timejump.chuanyue`、应用名“历史穿越”、不可调试、v2 签名且证书与本机调试包一致、ZIP 与原生库 16 KB 对齐、原生库与编译原件一致、6 个桥接类 14 个方法都在；自适应图标纸色背景 `#EFE5CF`；未做 R8 | 未装（暂时无法用手机） |
| 0.8.0 Windows | `.cache/release/chuanyue-0.8.0-windows-x64.zip`（内含 `lishi-app.exe`，SHA-256 `96195e35e4a56fd5d41d1425eebcb19e5658d49e709785b833282846f9f77335`） | 6,423,532 字节 | `22d8ef869cb182715ce20e62e2ad2774c7ef0c5214aa70da8f9650df795f23f8` | 本机启动检查：窗口标题“历史穿越”，能正常关闭 | — |
| 0.5.0（内部版本号 5000） | `.cache/release/chuanyue-0.5.0.apk`（不入 Git） | 22,830,483 字节 | `085350e33b9f9684443afa3c999ad7b90f8689b4b4d121a1afd2b01e6e0666ed` | 通过：`io.timejump.chuanyue`、不可调试、v2 签名且证书与本机调试包一致、ZIP 与原生库 16 KB 对齐、原生库与编译原件一致、6 个桥接类 14 个方法都在；未做 R8 | 未装（无线 ADB 未连） |

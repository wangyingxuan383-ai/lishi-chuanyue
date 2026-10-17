# R10 公开前检查（R10-T003）

> 2026-10-17 · 检查人：Claude · **未经用户同意不创建远程仓库、不上传**（AGENTS.md）。这里只做本机能做的检查，并列出需要用户拍板的事。

## 1. 需要用户决定

| 事项 | 选项 | 建议 |
| --- | --- | --- |
| 代码许可证 | MIT（最宽松，别人可以拿去闭源）/ Apache-2.0（同样宽松，多一条专利授权）/ GPL-3.0（改了再发布必须开源）/ 暂不公开 | 想让别人随便用：MIT；想让改版也保持开源：GPL-3.0。依赖都是宽松许可证，选哪个都兼容（见第 3 节） |
| 内容许可证（唐卡组、开局模板、提示词） | 跟代码一样 / CC BY 4.0（署名即可）/ CC BY-SA 4.0（署名且同样方式共享） | CC BY 4.0，方便别人做自己的卡组 |
| 公开哪些文档 | 全部公开 / 只公开代码和 README / 开发文档（计划、台账、评测记录、调研）另放 | 开发文档对接手的人很有用，可以公开；第一版报告 `deep-research-report.md` 由用户决定 |
| 应用正式名称与图标 | R09-T003 一起定 | — |
| 放在哪里 | GitHub / Gitee / 只在本机 | 由用户决定，**我不会自行上传** |

## 2. 秘密与私人信息（已检查）

| 检查 | 结果 |
| --- | --- |
| 开发台里保存的 Key 与服务地址是否出现在 Git 历史（80 个提交的全部文件和提交说明） | 没有（`.cache/v3-edit/scan-history.mjs`，只输出计数） |
| `.cache/`（Key、评测记录、存档）、`.env.local`、`dist/`、`target/`、`node_modules/` 是否被忽略 | 都已忽略 |
| `output/`（v2 时期 Playwright 的空目录）是否被忽略 | **没有**，里面现在没有文件；公开前加进 `.gitignore` |
| 提交作者 | 只有 Claude、Codex，没有用户的姓名或邮箱 |
| 局域网地址、手机序列号 | 没有出现在受版本管理的文件里 |
| 本机路径 | `docs/DEVELOPMENT.md` 和三个手机脚本里写着 `C:\Users\Windows11\...`（Windows 账户名，不是个人信息）；公开前改成从环境变量 `ANDROID_HOME` 读取 |
| 日常提交前扫描 | 每次提交前用 `node .cache/v3-edit/scan.mjs` 扫描暂存文件，至今全部干净 |

## 3. 依赖的许可证（已检查）

- 前端运行时依赖：React、React DOM、scheduler、sql.js 为 MIT；`@tauri-apps/api` 为 Apache-2.0 或 MIT。
- Rust 依赖（`cargo metadata`，共约 470 个）：绝大多数是 MIT、Apache-2.0、BSD、ISC、Zlib、Unicode-3.0；`cssparser`、`selectors` 等 5 个是 MPL-2.0（只要求这些库自己的文件开源，原样使用没有额外义务）；`webpki-root-certs` 是 CDLA-Permissive-2.0。**没有 GPL、AGPL 依赖。**
- 本项目自己的 Rust 包 `lishi-app` 还没写 `license` 字段，定了许可证后补上（`Cargo.toml`、`package.json`）。

## 4. 内容与素材

- 唐卡组（`src/content/eras/tang-748.ts`）：条目是自己写的概括，出处列在卡组的 `sources` 里，逐条核对记录见 [时代包抽查](R03_ERAS.md)；没有整段照抄受版权保护的文字。
- 调研文档（`docs/research/`）：是摘要和链接，引用的原话都很短。
- 应用图标 `assets/app-icon.svg` 是 v2 时期的占位图，R09-T003 会换掉。
- 视觉方向效果图里的字体（思源宋体、思源黑体、霞鹜文楷）只在截图时用网页字体加载，没有放进项目；以后如果打包进 App，它们都是 SIL OFL 许可证，要把许可证文件一起带上。

## 5. 公开前还要做（用户决定之后）

1. 写 `LICENSE`（以及内容许可证说明），给 `Cargo.toml`、`package.json` 补 `license` 字段。
2. `.gitignore` 加上 `output/`；把脚本里的本机路径改成读环境变量。
3. 写面向公众的 README：项目是什么、截图、怎样配置自己的 AI 服务、隐私说明（Key 只存在本机系统加密存储里）。
4. 再跑一次全历史秘密扫描，并人工看一遍将要公开的文档。
5. 用户确认后才创建远程仓库并上传。

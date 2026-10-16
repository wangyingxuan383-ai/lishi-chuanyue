# M06 Windows系统选择器实测

> 2026-10-16，Asia/Shanghai；M06-T002/T003/T005增量证据。使用Windows优化版原生应用与实际系统对话框，不以浏览器mock替代。手机仍按用户选择稍后。

## 合成世界与保护范围

独立生成world m06-picker-import-20261016-01，标题“中文存档选择器验收·长安支线”，schema3。主线和m06-picker-child子线各1回合，head=m06-picker-demo-turn-001、cash110、elapsed7200，含cash固定提醒1、书签1，空冻结研究bundle。没有复制用户私人世界、读取Key或发送模型/搜索请求。

所有夹具在本机.cache/m06-picker-fixtures，合法包177467B，SHA256 d8b0c126e2ad13bef3f57ef0638ae2094e4c1ff2f958026a0d8c10c9a226898c。大包为1073741825B稀疏文件，确认无实际1GiB内容分配，不作为应用导出包。夹具由core公开API生成并经过全分支portable证明，不仅是手写模拟JSON。

## 实际操作与结果

| 操作 | 实际结果 | 状态影响 |
|---|---|---|
| 系统选择器打开合法中文名包 | imported | 原生重新读取确认两分支、head、cash110、7200秒一致 |
| 57B损坏文本包 | timejump_invalid_header | 不发布任何新世界 |
| 大于1GiB文件 | save_too_large | 读取大内容之前拒绝 |
| 再次选择相同合法包 | save_duplicate | 不覆盖已有同ID世界 |
| 取消导入对话框 | cancelled | 正常释放操作占用，可继续导出 |
| 导出已导入世界 | exported | 新文件“历史穿越.timejump”，保留来源世界 |
| 第二次导出取消 | cancelled | 保留第一次文件 |

第一次导出实际文件177996B，SHA256 1bd576e6b0a23773521c93b22f737ee9a01616453db02c33e0de8161133ed4df。离线重新验证两包的manifest/hash、schema白名单、所有branch领域重放及annotations/research作用域。

原包与实际导出包的完整WorldView、正式回合/分支路径、BranchCard和水位、pins/bookmarks、research bundle、来源全部严格相等。容器时间和可读剧情格式不同属于预期；world.sqlite物理字节不同但正式重放完全一致，不能要求备份文件物理字节相同。annotations.sqlite、research.json和sources.json字节相同。

## 自动化限制与未验收项

UI自动化set_value在导出对话框中仅成功改变目录，实际采用默认中文文件名；随后尝试普通焦点定位，辅助工具的focused_element始终报告搜索框，因此没有继续键入。第二次对话框已取消。不能据此判应用自定义文件名失败，也不能宣称改名已验收。原生对话框按钮一次点击返回geometry unavailable，重新观察后使用实际系统Return正常确认。

Android系统document URI、手机好/坏/大/取消、Android↔Windows正式包迁移、现存手机保数据升级均未执行。本记录只证明Windows实际选择器和该合成世界往返；底层测试及APK静态结果不能替代手机门槛。

实际记录为.cache/m06-picker-import-*-result.txt、m06-picker-export-*-result.txt；离线比较为.cache/m06-picker-fixtures/actual-export-verification.json及helper源码。当前任务状态以[台账](../TASKS.md)为准。

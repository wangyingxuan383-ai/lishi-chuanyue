# M06 本地单价与费用估算验证

> 2026-10-16（Asia/Shanghai），M06-T008。固定计算、隔离UI和Windows实际原生命令分别记录；本功能没有模型请求或手机操作。契约见[费用协议](../contracts/M06_COSTS.md)，状态以[任务台账](../TASKS.md)为准。

## 交付与固定检查

新增game_cost核心模块、独立model-prices.sqlite和四个原生命令；调用记录详情接入本机单价编辑及按当前价格估算。价格库懒加载，独立CAS修订，坏库只影响价格功能。无新依赖，世界、Provider、密钥和原调用记录不改；单价不进入.timejump，不发送给模型。

核心10项通过（.cache/m06-cost-core-tests-final.txt）：严格十进制、范围/精度/非法值、合计分子后只舍入一次、真实零/极小值/未知、最大安全Token、错误usage、失败但有用量、模型/预留绑定与币种、并发CAS、持久重开、128条上限、损坏/空/未来/改schema与零修订非空拒绝且不改写。具体例：两项各0.3个最小金额不能分别舍为0，合计0.6后得到0.000001；最大值9007199254740991.000000保持十进制字符串，不经JS浮点。

原生3项通过（.cache/m06-cost-native-tests-final.txt）：NoSecrets全部方法panic以证明价格命令不读写Key；世界、Provider和原ledger保持；损坏价格库不妨碍服务启动/世界读取；105条固定记录只返回最近100条并保持完整身份；保存/冲突/重开/清除修订正确。原生测试属于固定本地数据，不发HTTP。fmt和两crate all-targets strict Clippy通过。

首轮core编译出现MutexGuard借用类型错误，修正后定向通过；一次Clippy命令重复--lib未执行成功，最终正确命令通过。旧日志保留，不把失败或0项检查冒充通过。

## 隔离真实组件UI

271/271通过：137项DTO、25项输入规范化、109项操作/绑定/恢复检查；读取/保存/清除同tick双击一次、处理中禁用、StrictMode/卸载迟到、原生{code}白名单错误、缺usage即使伪造金额仍未知、五字段任一不符不能串账、保存/清除及错误使旧估算失效。价格失败保留原调用记录，调用失败与价格失败可分别恢复。

采用实际组件和实际游戏CSS包裹，360px无横溢，截图目检；errors0/warnings0/未预期IPC0/外部请求0。60条IPC全部为夹具模拟，模型0、手机0。结果与源文件SHA在.cache/m06-cost-ui-qa，测试浏览器及自有4179服务已清理。前端最终69模块构建通过，主包456.73kB。

## Windows实际命令与重启

最终优化版通过真实Tauri IPC验证，使用唯一合成模型m06-cost-fixture-only：初始价格revision0/空；指数单价1e3拒绝且配置不变；保存CNY每百万输入1.25/输出2.5，规范为六位小数并升revision1；过期revision0清除被game_price_stale拒绝。实际服务价格始终未填写，43条真实记录的金额全为未知，没有把合成价套给gemini模型。

正常关闭后重开，revision1和合成价原样保留；随后只清除合成模型，revision2/空。没有回退修订或覆盖任何用户价格。前后43条调用、完整Provider视图及五份世界视图/快进作业相等，没有增加HTTP，Provider仍revision10和原预算。原生实际展开价格页读取成功，360px无横溢，接口设置始终折叠；截图仅价格区，不含端点/Key。

证据：.cache/m06-eval-qa/cost-native-live.json、cost-native-cleanup.json、cost-before-restart.json、cost-after-restart.json，以及.cache/m06-cost-restart-check.json和m06-cost-native-ui-proof.json。最终双端优化产物/签名和哈希见[交付说明](../RELEASE.md)。

## 结论与限制

本任务的核心、Windows交互/持久化、隔离UI和双端构建门槛通过；Android真机费用页面随M06-T001/T007新包验收，未把编译当真机通过。当前所有真实调用未配置服务单价，费用仍未知。此功能只按读取时当前model单价重算，不验证服务账单、历史价格、同名跨服务商、税费/缓存/推理特别计价或币种换算。

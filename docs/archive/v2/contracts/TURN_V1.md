# 正式回合协议 v1

本契约对应 `crates/lishi-core/src/game_protocol.rs`。它定义 M02 共用核心中的确定性世界事实与模型输出；验收证据和任务状态由台账维护，本文不表示 Android 运行或真实模型已通过。

## 1. 权威边界

模型输出是待验证输入。只有完整 JSON 通过结构、版本和状态规则，并由持久层重新核对分支节点后原子提交，才成为正式剧情与事实。协议不包含 SQL、文件、网络或工具执行操作。叙事与事实的复杂语义一致性、历史因果正确性仍需模型评测和人工检查。

纯函数 `apply_output` 使用快照的私有副本；任何一步失败都不修改调用者的快照。数据库提交、操作去重、过期节点拒绝、取消和中断恢复由存储层与服务层负责。

## 2. 公共函数

| 函数 | 行为 |
|---|---|
| `validate_setup(&WorldSetup)` | 检查开局配置，返回 `GameResult<()>` |
| `initial_state(&WorldSetup)` | 生成确定性的初始事实，返回 `GameResult<WorldState>` |
| `validate_state(&WorldState)` | 检查完整正式快照 |
| `parse_output(&str)` | 解析一个完整输出对象并检查输出边界 |
| `apply_output(&WorldState, &TurnOutput)` | 验证并生成下一份完整快照 |

所有 DTO 使用 `camelCase` 字段名，禁止未知字段。`StateChange.type` 使用 `snake_case`。所有字段必须提供；可空字段也须显式提供 `null`，不能靠缺失字段获得默认值。

## 3. 开局与时间

`WorldSetup` 必须提供 `worldId`、`title`、`country`、`eraYear`、`locationName`、`protagonistName`、`narrativeStyle`。

初始实体为 `player`（人物，存活）、`start-place`（地点）和 `travel-bag`（物品，行囊）。玩家初始资源为 `cash`，金额 100，单位为“记账单位”。这是明确的游戏初始设置，没有宣称所有国家和时代均使用同一种历史货币。物品的自由文本属性暂不构成完整所有权系统。

时间结构为 `{ eraYear, precision, elapsedSeconds }`。`eraYear` 是历史起点，取 -999999 至 999999 的整数且不允许零年；负值表示公元前。`precision` 为必填枚举，目前仅支持 `year`，明确历史开局的日期只精确到年。`elapsedSeconds` 从零单调增加，最大为 9007199254740991。首版不自动推导新的纪年、历法或生日；界面须显示起始纪年和已过时间，避免伪造历法换算。增加其他精度时需要另行补充来源区间和历法规则。

## 4. 正式状态

`WorldState` 字段全部必填：

- `protocolVersion: 1`、`time`、`locationId`、`protagonistId`。
- `entities`：`{ id, kind, name, alive, attributes }`；`kind` 为 `person`、`place`、`organization` 或 `item`。人物的 `alive` 为布尔值，其余类别为 `null`。
- `resources`：`{ ownerId, key, unit, amount }`，金额为非负整数，最大 9007199254740991；同一所有者与资源键只有一项。
- `relationships`：`{ fromId, toId, kind, strength }`，双方必须存在且不同，强度 -100 至 100；方向、双方和类别共同标识一项关系。
- `conditions`：`{ id, entityId, description, active }`，持续状态关联既有实体。
- `knownFacts`：`{ actorId, factId }`，知情者必须是人物，事实须引用已记录事件。
- `events`：`{ id, description, entityIds }`，实体引用必须存在且不重复。

地点 ID 必须指向地点，主角 ID 必须指向人物。实体、事件、持续状态各自在自己的 ID 域中唯一。实体及其他 ID 为 1～64 字节 ASCII 字母、数字、连字符或下划线；世界配置 ID 为同一字符集的 8～128 字节。

## 5. 模型输出

下列例子为一个完整输出对象：

```json
{
  "protocolVersion": 1,
  "narrative": "你付了路费，继续沿石阶前进。",
  "choices": [{"id": "ask-way", "text": "向路人问路"}],
  "timeAdvance": {"elapsedSeconds": 60},
  "stateChanges": [{
    "type": "change_resource",
    "ownerId": "player",
    "key": "cash",
    "unit": "记账单位",
    "delta": -10,
    "expectedAmount": 100
  }],
  "events": [{"id": "paid-fare", "description": "主角支付了路费。", "entityIds": ["player"]}],
  "sourceReferences": [],
  "uncertainties": ["此开局尚未经过独立史料研究。"]
}
```

解析器只接受一个完整 JSON 对象，或整个响应恰好被一层完整的 `json` 代码围栏包围。说明文字、多个对象、截断对象、任意子串提取、未知操作或额外字段均拒绝。空正文拒绝；选项可为空。M02 尚无已核实研究来源注册表，`sourceReferences` 必须为空，模型不能自行编造来源 ID。

## 6. 状态操作

| `type` | 必填参数与语义 |
|---|---|
| `create_entity` | `entity`：创建新 ID 的合法实体 |
| `set_attribute` | `entityId/key/value/expectedValue`：修改自由文本属性；`expectedValue` 为非空字符串时必须匹配旧值，`null` 表示无此预条件 |
| `set_life_status` | `entityId/alive`：仅修改人物存活状态，死亡人物不能恢复存活 |
| `move` | `locationId`：移动到已存在的地点 |
| `change_resource` | `ownerId/key/unit/delta/expectedAmount`：按整数增减资源；`expectedAmount` 非空时须匹配旧金额，新资源旧金额视为零；不得负数、溢出或改变既有单位 |
| `change_relationship` | `fromId/toId/kind/strength`：创建或替换关系强度 |
| `add_condition` | `condition`：新持续状态须处于活跃状态 |
| `resolve_condition` | `conditionId`：已有活跃状态变为已解决 |
| `record_knowledge` | `actorId/factId`：记录人物知情，不得重复记录或引用未知事件 |

新事件先加入候选快照，再依次应用状态操作，最后统一检查引用。因此新事件可引用本回合新建实体，知情操作可引用本回合新事件。创建实体与移动的操作顺序仍有意义：必须先创建再移动。

`set_attribute` 禁止改写 `id/kind/name/alive/location/locationId/protagonistId/time/eraYear/elapsedSeconds/protocolVersion` 等保留键，大小写不敏感。名称更改、删实体、人物复活、修正过去事实和分支行为未包含在 v1 操作中。

## 7. 大小和数值边界

所有文本边界均按 UTF-8 字节计算。普通单行字段不得包含控制字符，正文和长文本允许换行、回车和制表符。字符串不得仅含空白。

| 内容 | 上限 |
|---|---|
| 原始回合响应 / 序列化输出 | 256 KiB |
| 正文 | 64 KiB |
| 选项 | 6 项，每项文本 2048 字节 |
| 本回合状态操作 / 新事件 / 不确定性 | 128 / 32 / 16 项 |
| 实体 / 资源 / 关系 / 持续状态 | 各 512 项 |
| 事件 / 知情记录 | 各 4096 项 |
| 每实体属性 | 64 项，键 64 字节、值 2048 字节 |
| 实体名 / 主角开局名 | 256 / 128 字节 |
| 事件及持续状态描述 | 2048 字节 |
| 单事件实体引用 | 64 项 |
| 资源金额 / 增减绝对值 / 时间 | 9007199254740991，避免 JavaScript 数值精度丢失 |

这些是首版安全与上下文边界；达到上限时明确拒绝，不静默截断或删除事实。长期规模扩展须另行调整协议或持久模型。

## 8. 安全错误

`GameError::code()` 与 `Display` 只提供以下固定代码，不包含模型正文、输入、路径或秘密：`game_invalid_setup`、`game_invalid_protocol`、`game_invalid_output`、`game_invalid_entity`、`game_invalid_resource`、`game_invalid_time`、`game_dead_cannot_revive`、`game_invalid_relationship`、`game_invalid_condition`、`game_invalid_knowledge`、`game_invalid_event`、`game_invalid_reference`、`game_conflict`、`game_too_large`。

无效输出须保存玩家行动和安全错误，并允许显式重试；不得把未提交正文塞进下一次模型上下文，也不得因 JSON 有效就宣称历史或叙事语义正确。

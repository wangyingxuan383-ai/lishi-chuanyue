# Android 兼容性与“通知不出现”诊断

- 日期：2026-10-17（Asia/Shanghai）。所有外部链接查阅日期均为 2026-10-17。
- 范围：Tauri 2.12.3 / wry 0.57.0 / tao 0.37.1，targetSdk 与 compileSdk 36，minSdk 24；用户机型为小米手机、Android 16（HyperOS），以 debug 签名的 release APK 侧载。
- 方法：只读代码与官方文档，没有接手机、没有运行 adb。凡是需要真机确认的结论都标了【待验证】。
- 读过的代码：`src-tauri/gen/android/app/src/main/AndroidManifest.xml`、`GenerationService.kt`、`NotificationsPlugin.kt`、`MainActivity.kt`、`DocumentPickerPlugin.kt`、`generated/WryActivity.kt`、`generated/TauriActivity.kt`、Tauri 自带的 `AppPlugin.kt` 和 `PluginHandle.kt`（cargo 缓存中的 tauri-2.12.3）、`src-tauri/src/keep_alive.rs`、`notifications.rs`、`stream.rs`、`tauri.conf.json`、`build.gradle.kts`、`res/values*/themes.xml`、`src/platform/tauri.ts`、`src/ui/screens/Play.tsx`、`src/ui/components/useLongPress.ts`、`src/ui/app/context.tsx`、`src/ui/App.tsx`，以及台账中的 R01-T005、R01-T007、R02-T010、R08-T002。

## 已经处理的项目（2026-10-17 更新）

下面几项已在代码里改好，并通过 Rust/前端测试和 Android 发行包构建；凡是要看手机上实际效果的，都还是【待验证】。

| 项目（见第二部分） | 怎么改的 | 还要在手机上看什么 |
|---|---|---|
| 系统栏颜色跟随应用主题（2.2、2.4） | 在 notifications 插件里新增原生命令 `set_system_bars(background, dark)`（`SystemBars.kt` + `NotificationsPlugin.kt`）。边到边保持开启、两条栏保持透明；`MainActivity` 给 `android.R.id.content` 加了系统栏内边距，栏下面露出来的正是这块内边距，所以命令把 content 视图和窗口背景都刷成当前主题的 `--bg`（纸 `#efe5cf`、日 `#faf7f0`、夜 `#131518`），并用 `WindowInsetsControllerCompat` 切换图标深浅；同时关掉系统给三键导航栏加的半透明遮罩（`isNavigationBarContrastEnforced = false`）。`App.tsx` 的 `applyReading` 每次换主题都调用它。颜色存进 `SharedPreferences`，下次启动时 `MainActivity` 在页面加载前就先刷上 | 三种主题 × 系统深/浅色 × 手势/三键导航，状态栏和导航栏是否和页面连成一片、图标是否看得清【待验证】；启动画面本身仍取 `windowBackground`（跟系统走），只有 Activity 创建后才换成应用主题 |
| 长按振动（2.5） | 在 notifications 插件里新增原生命令 `haptic`，调用 `performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)`，不需要 VIBRATE 权限，遵守系统“触感反馈”开关。前端是 `platform.system.haptic()`；Android 上走原生，其他平台仍用 `navigator.vibrate` | 长按段落、首页世界卡片时有没有轻微震动；关掉系统触感反馈后是否不再震动【待验证】 |
| 导出世界的文件类型（2.6） | `DocumentPickerPlugin.kt` 按建议文件名选择 MIME：以 `.json` 结尾用 `application/json`，其余仍是 `text/plain` | 小米“文件管理”和系统 DocumentsUI 保存出来是否是 `xxx.lishi.json`【待验证】 |
| 主题图标（2.7） | 自适应图标加了 `<monochrome>` 图层，复用通知小图标的印章剪影（`drawable/ic_launcher_monochrome.xml`） | HyperOS / 原生桌面打开“主题图标”后的样子【待验证】 |
| 电视（leanback）（2.7） | 删掉了清单里的 `LEANBACK_LAUNCHER` 分类和 `android.software.leanback` 声明 | — |

---

## 第一部分：通知为什么不出现

### 1.0 现状：代码实际做了什么

1. **只有一条通知**，就是前台服务通知“正在写下一段…”（`GenerationService.kt`）。渠道 `generation`（“生成进度”）的重要程度是 `IMPORTANCE_LOW`：不响铃、不振动、没有角标；通知设成 `setOngoing(true)`，类别为 `CATEGORY_PROGRESS`，小图标用的是系统自带的 `android.R.drawable.stat_notify_sync`。
2. 这条通知**只在模型流活动期间存在**。Rust 里的租约计数（`keep_alive.rs`）从 0 变到 1 时启动服务，从 1 回到 0 时停止服务，停止时用 `STOP_FOREGROUND_REMOVE` 把通知删掉。一回合正文的中位时长约 12 秒（R01-T004 的数据），所以这条通知最多只存在十几秒。
3. **没有“写好了”的完成通知**。查遍代码，只有 `GenerationService` 一处构造了通知，没有第二个渠道，也没有 `notify()` 调用。结论确认：生成在后台完成时，玩家得不到任何提醒。
4. **申请权限的流程**（`Play.tsx` 第 219–228 行）：
   - 在 Android 上，第一次在游玩页发送、重说或续写时，如果 `notifAsked` 为假，先弹出应用自己的弹层“允许通知吗？”。
   - 不论玩家点“允许”、点“不用了”，还是直接关掉弹层（`onClose` 也走 `answerNotifications(false)`），都会**立刻把 `notifAsked` 写成 true，以后再也不问**。
   - 只有点了“允许”，才会调用系统权限弹窗（`NotificationsPlugin.request_notification_permission`）。返回的 `granted` 结果被 `.catch(() => false)` 吞掉，界面上没有任何反馈。
   - 开局生成（`NewGame.tsx` 里的 `game.createWorld`）不经过 `beforeGenerating`，所以第一次生成时既不问权限，也不会显示通知。
   - **整个应用里没有一个地方显示通知权限的状态，也没有能跳到系统设置的入口**（`Settings.tsx` 里搜不到“通知”）。
5. **Tauri 插件层的处理**（`PluginHandle.kt`）：用户拒绝后，插件把状态缓存在 `SharedPreferences("PluginPermStates")` 里，标为 `DENIED` 或 `PROMPT_WITH_RATIONALE`。我们的插件只判断是否等于 `GRANTED`，其余情况都重新请求。按照 Android 的规则，同一权限被拒两次后系统不再弹窗，请求会立刻返回 false。
6. 台账里的旁证：R01-T007 记着“通知未显示，因为尚未申请通知权限”；R02-T010 记着“手机上 POST_NOTIFICATIONS 当前为未授予”，状态仍为“待验收”。

### 1.1 最可能的原因（按可能性从高到低）

| 序 | 原因 | 判断依据 |
|---|---|---|
| A | **通知权限没有授予，而且应用没有办法再次申请** | 在 Android 13 及以上，新装应用的通知默认关闭（官方文档）。我们只问一次：玩家只要在弹层上点了“不用了”、按了返回键，或者在系统弹窗上点了“不允许”，`notifAsked` 就永久为 true。没有授权时，前台服务照样运行，但它的通知**不会出现在通知栏**，只会出现在系统的“任务管理器”里（官方原文：“they still see notices related to foreground services in the Task Manager but don't see them in the notification drawer”）。另外，覆盖安装会保留旧数据和旧的 `notifAsked`。如果用户在以前的版本里看过这个弹层，新版本也不会再问。 |
| B | **用户期待的“提醒”其实是完成提醒，而这个提醒根本不存在** | 用户说的是“提醒”。玩家切到别的应用后，真正需要的是“写好了，回来看”。现在唯一的进度通知又低调又短暂，生成一结束就被删掉。即使权限已经授予，玩家回头拉下通知栏时，通知多半也已经消失了。 |
| C | **`IMPORTANCE_LOW` 加上 HyperOS 的整理，让通知几乎看不见** | 低重要程度的通知不会弹出横幅、不响铃，在 AOSP 上会被归进通知栏下方的“静默”区。不少系统默认在状态栏隐藏静默通知的图标【待验证：HyperOS 的默认值】。HyperOS 还有自己的“通知过滤 / 不重要通知”和“悬浮通知智能收起”，会根据点击率把通知收进二级页面（小米开发者文档：新装应用前 3 条通知默认算重要，之后按历史点击率判断）。在国内版 HyperOS 上，第三方应用的“悬浮通知”“锁屏通知”默认可能是关闭的【待验证】。 |
| D | **通知在后台“断档”，紧接着的辅助调用没能拉起前台服务** | 一回合可能包含多次请求：先是主流；没有拿到 `<record>` 时，还要用辅助模型做一次“补记”抽取（`game.ts` 的 `extract`）。租约是按每条流分别计数的：主流结束时计数回到 0，服务和通知随即停止；下一次请求又要启动服务，而这时应用已经在后台。Android 12 以上禁止在后台启动前台服务（官方列出的例外包括“刚离开可见状态”“用户关闭了电池优化”等，文档没有给出具体的宽限时长）。`start()` 抛出的 `ForegroundServiceStartNotAllowedException` 会被捕获，只记一行日志，所以第二段请求既没有通知，也没有前台服务。更要紧的是，R01-T007 实测发现应用进后台约 5 秒后网络会被切断，所以这第二段请求很可能失败。另外，这段 JS 逻辑本身在后台的 WebView 里也可能被冻结、等回到前台才执行【待验证】。 |
| E | **Android 14 起，用户可以划掉前台服务通知** | 官方变更：`setOngoing(true)` 的通知在 Android 14 上可以被划掉，只有锁屏时或点“全部清除”时例外。被划掉一次以后，这一轮生成里通知就不会再出现。 |
| F | **小米的后台限制** | 省电策略、自启动、“MIUI 优化”可能让服务被提前杀掉，或者在后台根本起不来。dontkillmyapp 给小米的评价是“最差之一”，并且指出小米没有公开 API 和文档。这一条主要影响“后台能不能写完”，对“通知出没出现”的影响相对小。 |
| G | **release 包里的初始化路径和 debug 包不同** | R01-T007 的验证用的是 debug 包。release 包开启了 R8，而 `proguard-rules.pro` 已经保留了 `GenerationService` 和它的 Companion，`@TauriPlugin` 也有 Tauri 自带的保留规则，所以从代码看没有问题。如果 `keep_alive::initialize` 里的 JNI 失败，logcat 的 `GenerationService` 标签下会出现 “JNI bridge unavailable”。可能性低，但值得用一条 logcat 排除【待验证】。 |

### 1.2 怎样在手机上逐条确认

**不接电脑，在手机上看（HyperOS 的菜单名称可能随版本略有不同，都标为【待验证】）：**

1. 设置 → 应用设置 → 应用管理 → 历史穿越 → 通知管理：看“允许通知”开关；点进“生成进度”类别，看“悬浮通知”“锁屏通知”是否打开。也可以长按桌面图标 → 应用信息进入同一页面。
2. 设置 → 通知与控制中心 → 通知管理 / 状态栏：看“通知图标”“悬浮通知智能收起”“不重要通知”这几项的状态。
3. 生成期间，下拉通知栏，翻到最底部的“不重要通知”或静默区，看通知是不是被收在那里。
4. 应用信息页 → 省电策略（应设为“无限制”）；应用信息页 → 自启动；最近任务里把卡片下拉加锁。
5. 在应用里先把 `notifAsked` 复位（目前只能清除应用数据，或者等后面加了设置入口），再从游玩页发送一次，看系统权限弹窗会不会出现。

**以后接上电脑时可以运行的 adb 命令**（包名 `io.timejump.chuanyue`）：

```sh
# 权限是否授予，是否被标为 USER_SET / USER_FIXED（被拒两次后会带上 USER_FIXED）
adb shell dumpsys package io.timejump.chuanyue | grep -A2 POST_NOTIFICATIONS
# 通知总开关与渠道重要程度（importance=2 即 LOW）
adb shell dumpsys notification --noredact | grep -A30 "io.timejump.chuanyue"
# 生成期间前台服务是否在运行、类型是否为 dataSync
adb shell dumpsys activity services io.timejump.chuanyue
# 服务启动/提升失败的日志（只有类名，不含敏感信息）
adb logcat -s GenerationService
# 待机分组、电池优化白名单、后台网络状态
adb shell am get-standby-bucket io.timejump.chuanyue
adb shell dumpsys deviceidle whitelist | grep chuanyue
adb shell dumpsys netpolicy | grep -A3 "$(adb shell pm list packages -U io.timejump.chuanyue | sed 's/.*uid://')"
# 快速排除原因 A：直接授予，然后再试一次生成
adb shell pm grant io.timejump.chuanyue android.permission.POST_NOTIFICATIONS
# 模拟全新安装（复位 USER_SET / USER_FIXED 标记）
adb shell pm revoke io.timejump.chuanyue android.permission.POST_NOTIFICATIONS
adb shell pm clear-permission-flags io.timejump.chuanyue android.permission.POST_NOTIFICATIONS user-set user-fixed
```

### 1.3 修复建议（代码层面）

按优先级排列。F1 到 F4 合起来，可以作为一个任务进入台账的候选池。

**F1. 权限状态可查、可再次申请、可直达系统设置（最高优先级）**

- 在 `NotificationsPlugin.kt` 里新增命令 `notification_status`，返回：
  - `enabled`：`NotificationManagerCompat.from(ctx).areNotificationsEnabled()`；
  - `channelBlocked`：`getNotificationChannel("generation").importance == IMPORTANCE_NONE`；
  - `canAsk`：SDK 小于 33 时为 false；否则在“没授权并且（从没问过，或者 `shouldShowRequestPermissionRationale` 为 true）”时为 true。
- 新增命令 `open_notification_settings`，打开 `Settings.ACTION_APP_NOTIFICATION_SETTINGS`，带上 `Settings.EXTRA_APP_PACKAGE`（API 26 及以上）。如果要直接定位到某个渠道，就用 `ACTION_CHANNEL_NOTIFICATION_SETTINGS` 加 `EXTRA_CHANNEL_ID`。打不开时依次回退到 `ACTION_APPLICATION_DETAILS_SETTINGS`（`package:` URI），全部用 try/catch 包住。
- 修改 `request_notification_permission`：如果系统已经不会再弹窗（拒绝过两次，并且 rationale 为 false），就直接返回 `{granted:false, needsSettings:true}`。
- 前端改动：
  - 在 `src/ui/screens/Settings.tsx` 加一行“后台写作提醒”，用玩家语言显示“已开启 / 已关闭 / 被系统收起”，配一个按钮“去开启”（能弹窗就弹窗，否则跳系统设置）。
  - 从系统设置回来时（`visibilitychange`）刷新状态。
  - 把 `Play.tsx` 改成：关掉弹层不算拒绝；点了“允许”但没有授予时，用一句话提示“可以在设置里随时打开”；`notifAsked` 只用来决定要不要“主动弹出”，不再封死申请的路。
  - 开局生成之前也走一次同样的询问（`NewGame.tsx`），或者把询问移到第一次真正切到后台时再提示【可选】。

**F2. 新增“写好了”完成通知（用户真正想要的提醒）**

- 新建一个渠道 `turn_done`（名称“写好了提醒”），重要程度 `IMPORTANCE_DEFAULT`，允许声音和振动；声音可以设成系统默认的短提示音。不要用 HIGH，否则每次都弹横幅会打扰玩家。
- 在 Kotlin 一侧发这条通知。理由：后台的 WebView 里的 JS 可能被冻结，等它发通知就晚了。具体做法：
  - 在 `GenerationService.stop()` 里，或者由 Rust 在流正常结束（`Done`，不是取消）时，经 JNI 调用新的 `TurnNotifier.notifyDone(context, title)`；
  - 只在**应用不在前台**时发：用 `ProcessLifecycleOwner.get().lifecycle.currentState.isAtLeast(STARTED)` 判断，依赖 `lifecycle-process` 已经在用；
  - 通知文字示例：“历史穿越：下一段写好了”，可以附上世界名；点击时用和现在相同的 `PendingIntent` 回到应用，并设 `setAutoCancel(true)`；
  - 用固定的通知 ID，新的覆盖旧的；
  - 回到前台时（`onResume`）用 `NotificationManager.cancel(id)` 自动清掉。
- 失败或被中断时，可以发“这段没写完，回来续写”，用同一个渠道。
- 这条通知必须有通知权限才能显示，所以 F1 是前提。

**F3. 进度通知更容易被看见，也更可靠**

- 进度渠道保持 `IMPORTANCE_LOW` 是合理的：写作期间不该出声。但建议：
  - 文案加上世界名或回合信息；
  - 用 `setProgress(0,0,true)` 显示不确定进度条；
  - 用 `setShowWhen(true)` 显示开始时间。
- 改渠道重要程度只对**新建的渠道**生效：渠道一旦建好，应用就不能再降低或提高它的重要程度，只有用户能改。如果要改重要程度，得换一个新的渠道 ID，并用 `deleteNotificationChannel("generation")` 删掉旧渠道。
- 把小图标换成自己的单色矢量图（白色剪影，例如一枚印章），放在 `res/drawable/ic_stat_write.xml`。系统的 `stat_notify_sync` 是两个箭头组成的“同步”图标，玩家看不出是哪个应用的通知。HyperOS 在状态栏可能显示应用图标，但通知栏里仍然用这个小图标【待验证】。
- **弥合“断档”（原因 D）**：在 `GenerationService` 里让停止延迟一会儿。计数回到 0 时，先 `postDelayed` 约 8 秒再停；这期间如果又有 `start()`，就取消这次停止。这样主流、补记、整理这几段请求可以共用一个前台服务，后台网络也不会在它们之间被切断。另一种做法是让 JS 在整个回合期间持有一个租约（新增命令 `turn_lease_acquire/release`），但 JS 在后台可能被冻结，不如在原生一侧延迟停止可靠。如果用户把电池优化设成“无限制”，这本身也是一条可以在后台启动前台服务的例外（官方第 13 条）。

**F4. 小米后台引导页（一次性，可以从设置里重新打开）**

- 在设置页加一行“后台写作不断线（小米）”，只在 `Build.MANUFACTURER` 为 Xiaomi、Redmi 或 POCO 时显示。页面上列三步，每一步配一个“去设置”按钮：
  1. **通知**：`ACTION_APP_NOTIFICATION_SETTINGS`。
  2. **省电策略设为“无限制”**：先查 `PowerManager.isIgnoringBatteryOptimizations(pkg)`。还没加入白名单时，可以用 `Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`（`package:` URI，需要在清单里声明 `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`；Play 商店对这项权限有政策限制，但我们是侧载，不受影响）。也可以只打开列表页 `ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS`，不需要声明权限。小米的省电策略页面（下面列出的组件）和 Android 自己的电池优化可能是两套开关【待验证】。
  3. **自启动 / 锁定最近任务**：用文字说明“在最近任务里把卡片下拉加锁”。
- 小米专用的跳转入口（社区整理得到，HyperOS 上全部【待验证】，必须 try/catch，失败时回退到 `ACTION_APPLICATION_DETAILS_SETTINGS`）：
  - 应用权限页：`Intent("miui.intent.action.APP_PERM_EDITOR")`，`setClassName("com.miui.securitycenter", "com.miui.permcenter.permissions.PermissionsEditorActivity")`，`putExtra("extra_pkgname", pkg)`；
  - 自启动管理：`ComponentName("com.miui.securitycenter", "com.miui.permcenter.autostart.AutoStartManagementActivity")`；
  - 省电策略：`ComponentName("com.miui.powerkeeper", "com.miui.powerkeeper.ui.HiddenAppsConfigActivity")`，带上 `package_name` 和 `package_label`。
- 成熟应用（例如即时通讯、跑步、下载类应用）通常的做法是：首次遇到后台失败时，再引导用户去开启；引导页带截图和直达按钮，并显示每一项“已开启 / 未开启”的状态。只有通知、电池优化这两项能用官方 API 查到状态；自启动没有官方 API，开源库 XomaDev/MIUI-autostart 用反射读取，不建议为此引入依赖。

**F5. 验证清单（写进 R02-T010 或 R08-T002 的证据）**

1. 全新安装后，从游玩页第一次发送：应用弹层出现 → 系统弹窗出现 → 授权；切到后台，通知栏里能看到“正在写下一段…”；写完后收到“写好了”。
2. 在弹层上点“不用了”：设置页显示“已关闭”，点“去开启”能弹窗或跳到系统设置；回到应用后状态刷新。
3. 系统弹窗被拒两次：点“去开启”直接跳到系统通知设置。
4. 补记场景（造一个没有 `<record>` 的回复）：在后台时，补记阶段前台服务不中断，`dumpsys` 能持续看到服务。
5. 生成过程中划掉进度通知：不影响写完，也不影响完成通知。

---

## 第二部分：Android 13–16 与 HyperOS 兼容性清单

严重程度：**高** = 功能失效或明显有问题；**中** = 体验上有明显瑕疵；**低** = 小问题或预防性措施；**无** = 已经处理好。

### 2.1 通知与后台

| 项目 | 我们是否受影响（代码依据） | 严重程度 | 修复 | 来源 |
|---|---|---|---|---|
| POST_NOTIFICATIONS 运行时权限（13+） | 受影响，见原因 A：只问一次，不能再次申请，也看不到状态（`Play.tsx` 第 219–228 行） | 高 | F1 | [Notification runtime permission](https://developer.android.com/develop/ui/views/notifications/notification-permission) |
| 前台服务没有通知权限时 | 服务能正常运行，只是通知栏里看不到通知（我们在 `GenerationService.start` 里有意不检查权限，这是对的） | 中 | 配合 F1 | 同上 |
| 前台服务类型（14+ 必须声明） | 已声明 `dataSync` 和 `FOREGROUND_SERVICE_DATA_SYNC`，并调用了带类型的 `startForeground` | 无 | — | [Android 14 FGS types](https://developer.android.com/about/versions/14/changes/fgs-types-required) |
| dataSync 每 24 小时累计 6 小时（15+） | 已实现 `onTimeout` 并会停止服务；单回合很短，碰不到上限 | 低 | 保持现状。官方建议的长期替代是“用户发起的数据传输”任务（UIDT），目前没有必要换【待验证：dataSync 将来是否会被弃用】 | [FGS timeout](https://developer.android.com/develop/background-work/services/fgs/timeout) |
| 后台启动前台服务的限制（12+） | 受影响，见原因 D：两段请求之间服务断档，从后台再次启动会失败 | 高 | F3 中的延迟停止 | [Restrictions on starting FGS from background](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start) |
| 进度通知可被划掉（14+） | 受影响，但影响很小 | 低 | 不需要处理；完成通知（F2）不依赖进度通知 | [Android 14 all apps](https://developer.android.com/about/versions/14/behavior-changes-all) |
| 后台约 5 秒后断网（R01-T007 实测为 `blocked=APP_BACKGROUND`） | 前台服务运行期间网络正常；断档期间会断网 | 高 | F3 | 本项目 R01-T007 的真机记录 |
| 完成提醒 | 没有 | 高（体验） | F2 | — |
| 通知小图标 | 用的是系统的 `stat_notify_sync` | 低 | 换成自己的单色矢量图 | [Notification anatomy](https://developer.android.com/develop/ui/views/notifications) |
| HyperOS 通知过滤 / 不重要通知 / 悬浮与锁屏默认值 | 可能受影响【待验证】 | 中 | 完成通知用 DEFAULT 渠道，文案说清楚；在引导页里告诉用户可以打开“悬浮通知” | [小米：通知过滤适配说明](https://dev.mi.com/xiaomihyperos/documentation/detail?pId=1577)、[XimiTime: Unimportant notifications in HyperOS 2](https://ximitime.com/unimportant-notifications-starts-working-in-hyperos-2-0-on-xiaomi-devices-17658/) |
| 小米自启动、省电策略、清理最近任务 | 影响后台能否写完【待验证】 | 中 | F4 | [dontkillmyapp: Xiaomi](https://dontkillmyapp.com/xiaomi) |
| 应用待机分组 / 电池优化 | 侧载、用得少的应用可能被分到 rare 或 restricted 组；我们不用 Job 或闹钟，影响小 | 低 | F4 的“无限制”同时解决 | [App Standby Buckets](https://developer.android.com/topic/performance/appstandby) |
| Android 16 实时进度通知（ProgressStyle / Live Updates）、HyperOS“超级岛” | 没有使用 | 低（以后可以做） | 可选：生成进度用 `Notification.ProgressStyle`（API 36）【待验证：HyperOS 是否支持】 | [Progress-centric notifications](https://developer.android.com/about/versions/16/features/progress-centric-notifications) |

### 2.2 窗口、边到边与输入法

| 项目 | 我们是否受影响（代码依据） | 严重程度 | 修复 | 来源 |
|---|---|---|---|---|
| 边到边强制（targetSdk 35+；从 16 开始不能再退出） | 已处理：`MainActivity` 调用了 `enableEdgeToEdge()`，并按系统栏、刘海和输入法三者合并后的 inset 给 `android.R.id.content` 加内边距，然后消费掉 inset，WebView 不会再加一遍。CSS 里的 `env(safe-area-inset-bottom)` 因此是 0，不会重复计算 | 无 | 保持现状，不要再加 `windowOptOutEdgeToEdgeEnforcement`（在 16 上已经无效） | [Android 15 behavior changes](https://developer.android.com/about/versions/15/behavior-changes-15)、[Android 16 behavior changes](https://developer.android.com/about/versions/16/behavior-changes-16) |
| **系统栏下面的颜色和应用主题对不上** | 受影响。内边距露出来的是窗口背景，而窗口背景跟着**系统**的深色模式走（`values/themes.xml` 是 paper，`values-night` 是 ink），不跟应用自己的主题（`App.tsx` 里的 `data-theme`：paper / day / night）。例如系统是深色、应用选了“纸”，顶部状态栏和底部导航栏会是两条黑带；反过来就是两条米色带。状态栏图标的深浅也由 `enableEdgeToEdge()` 按系统模式自动决定 | 中（每次打开都能看到） | 新增一个原生命令 `set_system_bars(theme)`：设置 `content.setBackgroundColor(...)`，再用 `WindowInsetsControllerCompat(window, decor).isAppearanceLightStatusBars / isAppearanceLightNavigationBars` 设置图标深浅；在 `applyReading` 里调用。启动时可以从 `SharedPreferences` 读出上次的主题，在 `super.onCreate` 之前 `setTheme`，同时解决启动画面的颜色（见 2.4） | [Edge-to-edge in Views](https://developer.android.com/develop/ui/views/layout/edge-to-edge) |
| 输入法 inset | 已处理：`SOFT_INPUT_ADJUST_RESIZE` 加上手动处理 `Type.ime()` 的内边距。边到边模式下 adjustResize 不再自动缩小窗口，我们手动处理是对的 | 低 | 真机检查：输入框获得焦点时不被键盘挡住，键盘收起后底部不留空白；在全面屏手势和三键导航下各测一次【待验证】 | 同上，[IME insets](https://developer.android.com/develop/ui/views/layout/sw-keyboard) |
| 三键导航栏 | 15 及以上默认是 80% 不透明的遮罩，颜色可能取自窗口背景，和上一条是同一个问题 | 低 | 同上一条 | Android 15 behavior changes |
| 刘海 / 挖孔 | 已经把 `displayCutout()` 算进内边距；横屏时左右两侧会出现色带，和主题色问题一样 | 低 | 同上 | 同上 |

### 2.3 返回键与预测性返回

| 项目 | 我们是否受影响（代码依据） | 严重程度 | 修复 | 来源 |
|---|---|---|---|---|
| Android 16 加 targetSdk 36：系统不再调用 `onBackPressed()`，也不再派发 `KEYCODE_BACK` | **不受影响**。`TauriActivity` 把 `handleBackNavigation` 设为 false，wry 自己的回调因此不注册；返回由 Tauri 的 `AppPlugin.kt` 通过 `OnBackPressedDispatcher.addCallback`（AndroidX Activity 1.10.1）处理，官方说这种回调“不论 `enableOnBackInvokedCallback` 怎么设都会被调用”。有 JS 监听时触发 `back-button` 事件，交给 `tauri.ts` 的 `onBackButtonPress` 和我们自己的返回链（`context.tsx` 的 `useBack`）；没有处理者时调用 `exit(0)`，也就是 `finishAffinity()`。R01-T005 已经在真机上验证过手势返回和三键返回 | 无 | 保持现状。升级 Tauri 时回归测试一次（参考 tauri#14406：曾有升级后返回键直接退出应用的报告） | [Predictive back](https://developer.android.com/guide/navigation/custom-back/predictive-back-gesture)、[tauri#14133 back button event](https://github.com/tauri-apps/tauri/pull/14133)、[tauri#14406](https://github.com/tauri-apps/tauri/issues/14406) |
| 预测性返回动画 | `AppPlugin` 的回调**永远是开启的**（`OnBackPressedCallback(true)`），官方说明这种情况下“返回桌面”的预览动画不会出现；手势返回时没有“缩小预览”，直接按我们的逻辑走 | 低 | 可以接受。如果想要返回桌面的动画，需要按“是否还有可以关闭的层”动态开关回调，而这得改 Tauri 生成的代码，暂时不做 | 同上 |
| “再按一次退出” | 符合国内用户的习惯；官方更推荐直接退回桌面 | 低 | 保持现状 | — |

### 2.4 主题、字体与显示

| 项目 | 我们是否受影响（代码依据） | 严重程度 | 修复 | 来源 |
|---|---|---|---|---|
| 启动画面与窗口背景（Android 12+ 的 SplashScreen） | 启动画面背景取 `windowBackground`，跟系统深浅模式走；应用主题和系统不一致时，会先闪一下另一种底色 | 低 | 2.2 里的“记住主题、`setTheme`”方案一并解决；或者直接接受 | [Splash screens](https://developer.android.com/develop/ui/views/launch/splash-screen) |
| `configChanges` 包含 `uiMode` | 系统切换深色模式时 Activity 不会重建，窗口背景保留旧颜色，直到下次启动 | 低 | 同上，由应用主题决定颜色 | — |
| WebView 算法变暗 / HyperOS 强制深色 | targetSdk 33 及以上，WebView 默认不做算法变暗（需要应用主动允许）；但 HyperOS 设置里有一项“对第三方应用强制深色”【待验证】，可能把我们的页面反色 | 中【待验证】 | 在主题里加 `<item name="android:forceDarkAllowed">false</item>`；真机打开 设置 → 显示 → 深色模式 → 应用深色模式 看一下 | [WebView dark theme](https://developer.android.com/develop/ui/views/layout/webapps/dark-theme) |
| 系统字体大小 | Android 14 起字体最大可放大到 200%，而且是非线性放大。WebView 会不会跟随系统字体（`textZoom`）因版本而异【待验证】；我们有自己的阅读字号（`--story-size`），但按钮和标签用的是固定 px | 中【待验证】 | 真机把系统字体调到最大检查一遍；如果 WebView 跟随系统，界面可能溢出，可以考虑固定 `settings.textZoom = 100`，字号交给应用自己的设置（需要在 `onWebViewCreate` 里设置） | [Android 14 font scaling](https://developer.android.com/about/versions/14/features#non-linear-font-scaling) |
| 系统“显示大小” | 会改变 CSS 视口宽度，最大档位下可能只剩约 320–340 CSS px | 中 | 浏览器开发台用 320px 宽检查一遍；真机把“显示大小”调到最大检查一遍 | — |
| `elegantTextHeight`（16 起被忽略） | 只影响原生控件；我们的文字都在 WebView 里 | 无 | — | Android 16 behavior changes |

### 2.5 WebView 与网页能力

| 项目 | 我们是否受影响（代码依据） | 严重程度 | 修复 | 来源 |
|---|---|---|---|---|
| **`navigator.vibrate` 需要 VIBRATE 权限** | 受影响。`useLongPress.ts` 第 18 行调用了 `navigator.vibrate(10)`，但清单里没有声明 `android.permission.VIBRATE`。Chrome 官方文档写明 WebView 的振动 API“requires android.permission.VIBRATE”。没有这项权限时调用不会报错，只是静默不振动，所以长按没有手感 | 中 | 首选新增一个原生命令 `haptic()`，调用 `view.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)`：不需要权限，还会遵守系统“触感反馈”开关，手感也更接近原生。备选是在清单里加 `VIBRATE`（普通权限，安装时自动授予） | [Chrome WebView overview（硬件 API 表）](https://developer.chrome.com/docs/webview)、[webview-kiosk #283](https://github.com/nktnet1/webview-kiosk/discussions/283)、[HapticFeedbackConstants](https://developer.android.com/reference/android/view/HapticFeedbackConstants) |
| 剪贴板 `navigator.clipboard.writeText` | `Play.tsx` 第 447 行、`NewGame.tsx` 第 148 行在用。需要安全上下文和用户手势：`http://tauri.localhost` 在 Chromium 里算安全上下文，应该可以用【待验证】。另外 Android 13 起，系统复制后会自己显示一个预览浮层，我们再弹一个“已复制”就重复了 | 低 | 真机确认确实复制成功；按官方建议，在 Android 13 及以上不再弹自己的“已复制”（或者保留，算可以接受的重复）；如果复制失败，回退到原生的 `ClipboardManager` | [Copy and paste: avoid duplicate notifications](https://developer.android.com/develop/ui/views/touch-and-input/copy-paste#duplicate-notifications) |
| WebView 版本 | 国内版小米手机通过小米应用商店更新 Android System WebView，版本可能比 Play 渠道旧【待验证】。我们的 CSS 和 JS 没用很新的特性（没有用到 `dvh`） | 低 | 在开发者模式里显示 WebView 版本（`WryActivity.version` 已经能取到），方便以后排查问题 | [WebView overview](https://developer.chrome.com/docs/webview) |
| 后台的 WebView | 应用进后台时 `WryActivity.onPause` 调用了 `mWebView.onPause()`，渲染进程可能被节流或冻结；生成流在 Rust 里跑，不受影响，回到前台时 `visibilitychange` 会触发 `catchUp`（`Play.tsx` 第 178–184 行），这部分已经处理好。但补记、整理、写入数据库这些由 JS 驱动的后续步骤，要等回到前台才会执行（与原因 D 有关） | 中 | 完成通知放在原生一侧发（F2）；以后考虑把“流结束后的落库”移到 Rust 一侧 | — |
| HTTP 明文 | release 包是 `usesCleartextTraffic=false`；模型请求走的是 Rust（rustls），不经过 Java 的网络栈，这个开关管不到；页面本身也只加载本地资源。如果用户的中转服务是 http 地址，Rust 一侧仍然能连 | 低【待验证：Rust 客户端是否允许 http】 | 在设置里填 http 地址时提示“未加密”，但不阻止 | [Network security config](https://developer.android.com/privacy-and-security/security-config) |
| 预计 Android 17 起限制访问本地网络 | 如果中转服务部署在局域网，以后需要额外的权限 | 低（以后再处理） | 关注；Android 16 上可以用 `am compat enable RESTRICT_LOCAL_NETWORK` 预先测试 | Android 16 behavior changes |

### 2.6 文件、存档与进程

| 项目 | 我们是否受影响（代码依据） | 严重程度 | 修复 | 来源 |
|---|---|---|---|---|
| SAF 文件选择与导出 | `DocumentPickerPlugin.kt` 用的是 `ACTION_OPEN_DOCUMENT` 和 `ACTION_CREATE_DOCUMENT`，不需要存储权限，符合 Android 10 起分区存储的要求。导出的 MIME 类型是 `text/plain`：如果建议的文件名以 `.json` 结尾，部分文件管理器可能把它保存成 `xxx.json.txt`【待验证】 | 低 | 导出世界时使用 `application/json`；在小米自带的“文件管理”和系统 DocumentsUI 里各试一次 | [Storage Access Framework](https://developer.android.com/training/data-storage/shared/documents-files) |
| 进程被杀与状态恢复 | 数据都在 SQLite 里；`WryActivity.onSaveInstanceState` 只保存了 Activity ID。Activity 重建后整个页面重新加载，导航栈（`App.tsx` 里的 `stack` 状态）丢失，会回到首页。生成中途被杀时有 `recoverPending` 和“已中断”回合兜底 | 中 | 属于 R08-T002 的范围：把当前路由和阅读位置写进 localStorage 或 SQLite，启动时恢复；用 `adb shell am kill` 模拟测试 | [Process death](https://developer.android.com/topic/libraries/architecture/saving-states) |
| 备份 | `allowBackup=false`，加上 `data_extraction_rules` 把所有内容排除，密钥和存档都不会进入云备份或换机迁移；代价是换机时存档不会自动带走，只能手动导出 | 无 | — | — |
| 16 KB 页面大小 | 已完成（NDK r28） | 无 | — | [16 KB page sizes](https://developer.android.com/guide/practices/page-sizes) |
| 密钥存储 | Android Keystore 的 AES 密钥（`SecretStorePlugin.kt`）；HyperOS 换机或清除数据后需要重新填写 Key，这是预期行为 | 无 | — | — |

### 2.7 外观、屏幕与安装

| 项目 | 我们是否受影响（代码依据） | 严重程度 | 修复 | 来源 |
|---|---|---|---|---|
| 启动图标遮罩 | 使用自适应图标（`mipmap-anydpi-v26/ic_launcher.xml`，前景加背景），HyperOS 的圆角遮罩能正确裁剪 | 无 | — | [Adaptive icons](https://developer.android.com/develop/ui/views/launch/icon_design_adaptive) |
| 主题图标（Android 13+ 的 monochrome 图层） | 没有 `<monochrome>` 图层；HyperOS 的“图标主题”可能会自己生成或忽略【待验证】 | 低 | 加一个单色图层（可以和通知小图标共用同一个剪影） | 同上 |
| 大屏、折叠屏、方向 | 没有锁定方向，`configChanges` 包含 orientation 和 screenSize，旋转时不重建 Activity；宽屏布局已经有 `play-side` 侧栏。Android 16 在 sw600dp 及以上的设备上会忽略方向和尺寸限制，但我们本来也没有设置这些限制。用户的手机不属于大屏 | 低 | 小米折叠屏或平板上看一眼即可 | Android 16 behavior changes |
| 电视（leanback） | 清单里有 `LEANBACK_LAUNCHER` 分类和 `android.software.leanback`（required=false），这是模板自带的；手机上无害，只是电视上缺少 banner 图 | 低 | 可以删掉，减少无用的声明 | — |
| 侧载与 debug 签名 | HyperOS 安装时可能要求登录小米账号或经过“安全守护”扫描；R01-T005 记录 `adb install -r` 可以直接安装。需要注意：**换签名会导致无法覆盖安装**，正式签名之前要先导出存档 | 中 | 写进 `docs/RELEASE.md` | — |
| Android 14 最低可安装 targetSdk 为 23 | 我们是 36 | 无 | — | Android 14 behavior changes |
| Android 16 的 `scheduleAtFixedRate` 变化、Intent 匹配收紧 | 我们不用；应用内部的 `PendingIntent` 是显式且 IMMUTABLE 的 | 无 | — | Android 16 behavior changes |
| 后台启动 Activity 的限制（15+） | 我们不从后台拉起界面；完成通知点击后由用户主动回到应用，符合要求 | 无 | — | Android 15 behavior changes |

---

## 第三部分：建议的落地顺序

1. **F1 + F2**：权限状态、再次申请、直达系统设置，加上完成通知。这直接回应用户的反馈；改动集中在 `NotificationsPlugin.kt`、`GenerationService.kt`（或新建 `TurnNotifier.kt`）、`keep_alive.rs` 或 `stream.rs`（把“正常结束”的事件传给原生）、`Play.tsx`、`Settings.tsx`、`tauri.ts`。
2. **F3 的延迟停止**：只改 `GenerationService.kt` 一处，就能堵住后台补记阶段断网的漏洞。
3. **振动改成原生触感反馈**、**系统栏颜色跟随应用主题**：改动都很小，每次使用都能感觉到。
4. **F4 小米引导页**，以及字体、显示大小、强制深色的真机检查（可以并入 R08-T002 的真机清单）。

## 参考来源（查阅日期均为 2026-10-17）

- Android 16 面向 targetSdk 36 的变更：https://developer.android.com/about/versions/16/behavior-changes-16
- Android 15 面向 targetSdk 35 的变更：https://developer.android.com/about/versions/15/behavior-changes-15
- Android 14 对所有应用的变更：https://developer.android.com/about/versions/14/behavior-changes-all
- 通知运行时权限：https://developer.android.com/develop/ui/views/notifications/notification-permission
- 前台服务超时：https://developer.android.com/develop/background-work/services/fgs/timeout
- 从后台启动前台服务的限制：https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start
- 预测性返回：https://developer.android.com/guide/navigation/custom-back/predictive-back-gesture
- Chrome WebView 概览（振动需要 VIBRATE 权限）：https://developer.chrome.com/docs/webview
- webview-kiosk 讨论 #283（没有 VIBRATE 权限时静默失效）：https://github.com/nktnet1/webview-kiosk/discussions/283
- Tauri 返回键事件 PR #14133：https://github.com/tauri-apps/tauri/pull/14133；问题 #14406：https://github.com/tauri-apps/tauri/issues/14406
- dontkillmyapp（小米）：https://dontkillmyapp.com/xiaomi
- 小米澎湃OS开发者平台《MIUI9 通知过滤适配说明》：https://dev.mi.com/xiaomihyperos/documentation/detail?pId=1577
- XimiTime：HyperOS 2.0 的“不重要通知”：https://ximitime.com/unimportant-notifications-starts-working-in-hyperos-2-0-on-xiaomi-devices-17658/
- 文中提到、但没有逐页打开核对的官方页面（边到边、输入法、启动画面、WebView 深色主题、剪贴板、SAF、16 KB、自适应图标、待机分组、Android 16 进度通知），链接都写在对应表格里；其中具体细节以表中【待验证】的标注为准。

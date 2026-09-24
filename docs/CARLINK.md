# CarLink 接入状态

更新于 2026-09-24。目标设备是 vivo 手机，经 ICCOA CarLink 连接 2023 年购买的零跑 C11。用户使用的是带独立桌面的应用投屏：应用从车联列表启动到独立窗口，部分支持分屏。本次不把手机整屏镜像当作这一需求的验收结果。

## 当前实现

APK 版本 `1.1.4`，versionCode `42`。正式包名保持 `home.haohaochang.tv`；本轮测试版使用独立包名 `home.haohaochang.tv.debug`，桌面名称为“好好唱 KTV（测试版）”。

- MainActivity 新增官方 UCAR action `com.ucar.intent.action.UCAR` 与 category `com.ucar.intent.category.UCAR`，保持 exported，保留原手机与电视入口。
- 通过 UCAR action 或 `isUcarMode=true` 判断车载启动，包括宿主重新投递 Intent 的情况。
- 车载不请求传感器方向或强制横屏，由宿主决定方向；声明可调整窗口大小，并处理窗口尺寸与布局变化。现有点歌界面按窗口实测宽高排布。
- 沿用现有 NAS 登录、独立音轨播放与歌词；未添加麦克风录音或方向盘媒体服务。

这只是应用侧启动入口的准备，不是完整 CastKit 认证。车载亮暗色主题、厂商验收、实际 C11 窗口与音频路由仍未完成。普通 KTV 界面当前沿用暗色样式。

## 为什么入口存在还可能不显示

[vivo CastKit 介绍](https://developers.vivo.com/doc/d/0e713e08f323448c868f1ac3771b80c6) 明确区分应用开发、vivo 测试验收和智能车载后台配置上线。声明 UCAR 入口让宿主能找到指定包的车载 Activity，不会自动把包加入厂商应用清单。

本机 vivo 智能车载桌面 6.0.8.3 的只读检查与此一致：桌面读取车联服务的应用清单；服务从 `car/apps` 获取 `AuthorizedApp` 配置，离线使用缓存或内置列表，未配置包的启动检查可返回 `NOT_SUPPORT`。没有改写手机应用清单、系统设置或厂商组件。全民 K 歌、高德、Chrome 已有平台配置，不能据它们可用推断所有 APK 均可自动加入。

以上结论限定于传统桌面目录。与 SunnyTV 并行任务交叉核对后，还确认该组件存在 Fusion 路径：枚举普通 `MAIN`/`LAUNCHER` 应用，再按车辆协商的显示模式过滤。未单独配置的应用在某些窗口模式下可用，因此不能把传统目录的条件推广到全部 CarLink 模式。目标 C11 当前实际走哪条路径、好好唱安装后能否加入列表仍须实车验证。

后续应通过 [vivo 智能车载开发者入口](https://developers.vivo.com/product/joviincar/home) 对接普通应用接入，将包名、正式签名信息、UCAR Activity 和实测结果提交给厂商。未代用户联系厂商或提交应用。

## 验证与安装

本地检查使用 `gradle -p android testDebugUnitTest lintDebug assembleDebug`。入口回归检查 Android PackageManager 能解析 UCAR、手机和 TV 入口，以及车载/普通启动的方向策略；不启动 LAN 自动发现，不改曲库。测试通过不代表车联后台已上线或已在 C11 实测。

本轮结果：在独立 ASCII 路径副本构建，57 项 Android 测试全部通过（含 14 项 Android 6/9 的车载入口用例），debug APK 构建与签名校验通过；已检查 APK 含 UCAR action/category、DEFAULT 及可调整窗口声明。调试版经 USB 安装到 vivo V2454DA，并连接真实服务器，在 4K／440 dpi 虚拟电视窗口完成卡片遥控验证。C11 车联桌面可见性仍未验证。

本地调试包为 `haohaochang-tv-v1.1.4-debug.apk`，使用调试签名。它可以与正式版同时安装，正式版的 NAS 地址、登录和其他应用数据不会被覆盖。安装后打开“好好唱 KTV（测试版）”，重新连接 NAS 并扫码登录；测试版使用自己的应用数据，不会读取正式版的登录。

正式签名包名称为 `haohaochang-tv-v1.1.4.apk`，沿用已有 CI 签名流程。测试版与正式版的包名不同，测试版能否进入 CarLink 应用列表也需单独验证；目前没有 C11 实车检测结论。

使用测试版时，在停车状态检查：

1. 将调试包安装到手机，保留现有正式版。打开“好好唱 KTV（测试版）”，连接 NAS 并扫码登录。离开家庭网络时需使用手机可访问的 NAS 地址。
2. 连接 C11 CarLink，在 vivo 投屏应用管理中检查是否出现“好好唱 KTV（测试版）”；若出现，添加到车联桌面并从图标启动。
3. 检查约 16:9 窗口及车机允许的分屏；转动手机不应改变车载方向。
4. 验证点歌、原唱/伴奏、歌词、切歌、窗口切换和断开重连；验证音频输出与歌房播放租约。未测试前不宣称通过。

## 官方依据

- [普通应用接入标准](https://developers.vivo.com/doc/d/2a49ec4f4ae54806b4c083e39f4a6714)：UCAR 入口、启动参数、虚拟屏方向和亮暗色要求。
- [媒体应用接入标准](https://developers.vivo.com/doc/d/5d21dfa89b2d48fa85dc7d40f58a6972)：适用于由车载桌面提供媒体界面的接入方式，本次未实现。
- [ICCOA 模式列表](https://www.iccoa.cn/site/iccoaCase)：经典投屏 1.0、融合全屏 1.5、小窗 1.6、镜像 2.0；需手机和汽车共同支持。
- [vivo 6.0 官方说明](https://bbs.vivo.com.cn/newbbs/thread/38903605?show_title=1)：受支持车型可镜像使用手机应用，不能据此认定本任务的独立桌面应用已上线。

# v1.1.4 · 登录与电视遥控体验

- 浏览器后台登录现在保存一周的 HttpOnly Cookie，关闭浏览器后不用立即重新输入密码。
- 后台「设置与任务 → 管理密码」可以修改密码，最低 6 位；修改后旧密码和旧登录立即失效。
- 网页 `/play` 与 Android 点歌卡片在下一行完整可见时只移动焦点，目标出屏才滚动。Android 版在连接真实服务器的 3840×2160／440 dpi 预览中确认：到第三行不滚，进入第四行上移一行，连续方向键移动不再闪烁。
- 网页 favicon、PWA 图标、APK 图标和左上角统一为原版紫底白色麦克风。
- APK 加入 vivo CarLink UCAR 应用侧启动入口；是否出现在零跑 C11 的车联桌面仍取决于 vivo 平台配置和实车验证。

## 更新步骤

1. NAS 保留原数据目录、端口和 Compose 配置。已有分离容器的用户执行 `docker compose pull ktv`，再执行 `docker compose up -d --no-deps ktv`；CPU／NPU 镜像保持原版本。全新安装可用 `haohaochang-nas-v1.1.4.zip`。
2. 电视、手机和平板下载 `haohaochang-tv-v1.1.4.apk`，用正式签名覆盖原版；原应用登录和 NAS 地址保留。此前安装的独立调试版不会被覆盖。
3. PC 整理器协议未改，可以继续使用。新安装包为 `haohaochang-resource-ai-v1.1.4.zip`。

本次发布不自动更新正在运行的 NAS 或手机。正式签名 APK 与各附件的 SHA-256 见 `SHA256SUMS-v1.1.4.txt`。

# v1.1.1 · 在线找歌与收藏夹登录分开保存

以前在线找歌扫码登录和收藏夹自动下载共用一份 B 站 Cookie：在一边换账号，另一边跟着变，收藏夹下载因此报“请确认 B 站登录 Cookie 和当前账号清晰度权限”。本版把两处登录拆开，各自保存、各自刷新，互不覆盖。

- “设置与任务 → 在线资源”上方的“在线找歌 · B 站登录”只影响在线搜索、预览、在线下载和更新画质。
- 收藏夹卡片下方的“收藏夹自动下载 · B 站登录”只影响收藏夹同步和收藏夹下载；也可以继续直接填写 Cookie 或 bili-sync 的五项凭证。
- 两处各自的刷新令牌独立轮换，不会因为一端刷新让另一端失效。

## 这次如何更新

只更新 NAS 主镜像，不需要更换 Compose、分离镜像或 APK：

```sh
docker compose pull ktv
docker compose up -d --no-deps ktv
```

ARM64 在两条命令的 `compose` 后加上 `-f docker-compose.arm64.yaml`。CPU／NPU 容器保持原样，主镜像版本可用 `1.1.1` 或 `latest`。

升级后原有共享 Cookie 会复制给在线找歌，收藏夹保留原凭证和刷新令牌，所以两边通常都还能继续使用同一个账号，不需要重新扫码。要分开使用时，在收藏夹一侧扫码或填写收藏夹所属账号即可；在线一侧保持自己的账号不受影响。

APK 与 1.1.0.1 功能相同，已经安装的电视、手机和平板不必更新；PC 整理器与分离镜像同样不受影响。检测暂时失败不会清空任何一侧的 Cookie。

## v1.1.0 · 主程序与分离容器拆分、歌手卡片铺满

主程序恢复独立轻量镜像，保留 Python、FFmpeg 和下载工具。CPU／NPU 分离使用各自容器，沿用已验证的 1.0.8 镜像并锁定摘要。本次不重新发布 CPU、NPU 镜像。

Compose 自动连接同机服务并持久化内部鉴权密钥；PC → NPU → CPU 的调度和原有开关继续保留。以后日常发布只更新 ktv，两个分离镜像仅在明确需要时单独发布。

`/play` 清除歌手照片旧外边距，图片铺满卡片。APK 的歌手卡片也改为铺满图片、底部叠加姓名和歌曲数，保留遥控焦点边框。

## 这次如何更新

**配置附件已更新**：两份 Compose 均从 `services:` 开头，密码、端口和目录直接填写，中文注释标出修改位置；移除 x-worker 和 .env 模板。三个服务统一使用 host 网络，CPU／NPU 仅监听本机，解决 Docker 默认地址池耗尽导致的部署失败。已经正常运行的 1.1.0 无需更换镜像；遇到该部署报错时，重新下载 NAS 包并完整替换配置，保留原目录、密码和端口。

1. 下载 `haohaochang-nas-v1.1.0.zip`，阅读包内《NAS安装与升级.md》。x86 NAS 用 `docker-compose.yaml`，ARM64 用 `docker-compose.arm64.yaml`。
2. 等任务完成，沿用原 Compose 项目、密码、端口和 data／曲库／下载目录，替换配置、拉取新版 ktv 并启动整套服务。这次需要创建独立 CPU／NPU 容器，不能仅拉取主镜像。
3. 安装 `haohaochang-tv-v1.1.0.apk`，获得原生歌手卡片修正。同签名覆盖保留登录。
4. 现有 PC 整理器仍兼容；本版重新生成 `haohaochang-resource-ai-v1.1.0.zip`、`haohaochang-preprocess-v1.1.0.zip` 和完整 NAS 附件。

以后更新主程序只执行：

```sh
docker compose pull ktv
docker compose up -d --no-deps ktv
```

ARM64 在 `compose` 后增加 `-f docker-compose.arm64.yaml`。主镜像地址仍为 `ghcr.io/xudong7587/haohaochang:latest`，也可使用固定版本 `1.1.0`。

本地回归、USB 卡片检查及云端 Compose 验证的结果见 v1.1.0 Actions 与 Release。当时没有修改生产 NAS；实际 Intel NPU 设备访问仍需在 NAS 更新后确认。

# NAS 安装与升级 · v1.1.1

本版修正在线找歌扫码登录与收藏夹自动下载共用同一份 Cookie 的问题：两处登录分开保存、分别刷新，只更新主镜像即可。主程序、CPU 分离和 Intel NPU 分离仍是独立容器，主程序保留 Python、FFmpeg、图片处理和下载工具；CPU／NPU 沿用固定的 1.0.8 镜像，并锁定 SHA-256 摘要；以后日常更新只更换主程序。

## 选择配置

| NAS 类型 | 使用文件 | 启动的容器 |
| --- | --- | --- |
| Intel／AMD 64 位 x86 | `docker-compose.yaml` | ktv、separator-cpu、separator-npu |
| ARM64 | `docker-compose.arm64.yaml` | ktv、separator-cpu |

x86 NAS 没有 Intel NPU 时，NPU 状态显示未就绪，任务自动尝试 CPU。NPU 需要宿主机已安装可用驱动并提供 `/dev/accel/accel0`，本包不会安装驱动。ARM64 不启动 Intel NPU 镜像。

只导入其中一份 Compose。服务端口和内部连接已经配好，无需在网页填写 CPU／NPU 地址或密钥。

## 只修改标注的位置

两份配置都从 `services:` 开头，每个容器完整列出参数，没有 `x-worker`、引用合并或外部变量。按文件里的中文注释填写：

1. **必须修改**：`ADMIN_PASSWORD`，至少 12 位；升级时保留原密码。
2. **核对目录**：只改 `/data`、`/download`、`/media` 映射的冒号左侧。默认 `./data` 等表示本 Compose 目录下的文件夹；也可以填写 NAS 完整路径。
3. **同步目录**：如果修改了主程序的 data 路径，CPU／NPU 中的 `/data` 映射也必须填同一路径。x86 共三处，ARM64 共两处。
4. **按需修改**：`PORT` 默认 43210，升级时保留原端口。

标注“无需修改”的连接、运行参数和健康检查保持原样。无需创建 `.env` 文件；旧版使用 `.env` 的用户，把实际值填入 Compose 后再部署。

## 从 v1.0.7／v1.0.8 升级

1. 等当前整理、分离任务完成，在原 Compose 项目中替换配置。保留原项目名称，避免启动两个主程序共用数据库。
2. 在 Compose 注释标注处填回原管理密码、访问端口和三个实际目录。尤其是 `/data`，各容器必须指向同一份旧数据库所在目录。
3. 原端口是 3210 就继续填 3210，默认新安装端口为 43210。不要把新版示例密码覆盖到现有配置。
4. 先拉取新版 ktv 镜像，再启动整套 Compose。这次迁移需要创建独立分离容器，不能只重建 ktv。

```sh
# Intel / AMD x86-64 NAS，在本包所在目录执行
docker compose pull ktv
docker compose up -d

# ARM64 NAS 使用以下两条
docker compose -f docker-compose.arm64.yaml pull ktv
docker compose -f docker-compose.arm64.yaml up -d
```

如果还运行着更早的独立分离容器，先停止它们，确认本机 18001、18002 没有被旧容器占用；保留旧数据目录。PC 整理器可继续运行，原 PC 连接和模型选择会保留。

主程序首次启动后生成 `data/separation/internal.key`，分离容器自动读取同一密钥。只重建主程序不会更换密钥。三个服务共用原 data 目录，各自写入独立的任务子目录；不需要把曲库、下载目录映射给分离容器。

## 首次安装

从本版 Release 下载 `haohaochang-nas-v1.1.1.zip`。设置至少 12 位的管理密码，确认 `/data`、`/media`、`/download` 的映射后，按上面的命令启动。打开 `http://NAS-IP:端口/admin` 登录。

三个容器均使用 host 网络，保留 PC 和 TV 自动发现；CPU／NPU 只监听本机 `127.0.0.1:18002`／`18001`。无需创建 Docker bridge 子网，也无需在路由器或防火墙开放分离端口。

如果旧配置报 `all predefined address pools have been fully subnetted`，在原 Compose 项目中完整替换为这份配置并重新部署。它不创建默认网络，不需要清理其他项目的网络或调整 Docker 地址池。

## 以后日常更新

```sh
docker compose pull ktv
docker compose up -d --no-deps ktv
```

ARM64 在两条命令的 `compose` 后都加上 `-f docker-compose.arm64.yaml`。

在 NAS 的图形界面里，对 `ktv` 执行拉取镜像和重建即可。CPU／NPU 的固定镜像不随主程序版本变化；已经下载过的模型、编译缓存继续使用。通常不需要重新导入整套 Compose。

只有 Release 明确写了“分离器更新”时，才替换相应 Compose 固定摘要并重建那个分离容器。普通界面、点歌或曲库功能调整不会触发这一步。

## 更新后检查

打开管理页“人声分离”，确认 CPU 已连接。PC、NPU 可用时按 PC → NPU → CPU 的顺序处理，原来手动关闭的开关继续保持关闭。第一次 CPU 分离需要联网下载模型，NPU 首次编译也需要等待。

模型优先复用 `data/separator/models`，否则使用 `data/models`；NPU 缓存优先复用 `data/npu/npu-cache`，否则使用 `data/npu-cache`。v1.0.7／v1.0.8 的任务继续使用 `data/separation/demucs` 和 `data/separation/openvino-npu`，不删除旧数据。

网页歌手卡片随 NAS 更新。v1.1.1 只改 NAS 端，APK 与 1.1.0.1 功能相同；全新安装可用 `haohaochang-tv-v1.1.1.apk`，同签名覆盖保留登录。现有 PC 整理器仍兼容；新安装可用 `haohaochang-resource-ai-v1.1.1.zip`。

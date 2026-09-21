# NAS 人声分离 · v1.1.3

主程序、CPU 和 Intel NPU 使用独立容器，PC 整理器保持独立。处理顺序为 PC → NPU → CPU → 已配置的外部 API。常规开关都在管理页“人声分离”，Compose 配好本机地址和共享密钥，无需手动填写连接信息。

## 安装与迁移

按 [NAS安装与升级.md](NAS安装与升级.md) 选择配置：Intel／AMD x86 用 docker-compose.yaml，ARM64 用 docker-compose.arm64.yaml。沿用原密码、端口和 data／曲库／下载目录。从 v1.0.7／v1.0.8 迁移时启动整套 Compose，创建独立分离容器；保留原项目名称，避免两个主程序共用数据库。

主程序不再安装 PyTorch、Demucs 和 OpenVINO。CPU、NPU 复用已经发布的 1.0.8 镜像，并锁定完整 SHA-256 摘要。后续主程序 Release 只更新 ktv；分离镜像有独立发布流程，只有明确的模型、兼容或分离功能改动才更新。

## 设备与资源

Intel NPU 需要宿主机已有可用驱动和 /dev/accel/accel0。NPU 容器获得设备目录及对应设备权限；没有 NPU 时状态为未就绪，任务尝试 CPU。AMD／高通 NPU 未适配。ARM64 配置不启动 Intel NPU 容器。

CPU 使用 htdemucs，每次处理一首，推理限制 2 线程并降低进程优先级，单次最多 6 小时。第一次分离需要联网下载模型，之后复用缓存。NPU 模型随独立 NPU 镜像提供，首次编译需要等待。

CPU 模型优先使用 data/separator/models，否则使用 data/models；NPU 缓存优先使用 data/npu/npu-cache，否则使用 data/npu-cache。任务继续保存到 data/separation/demucs 和 data/separation/openvino-npu。内部密钥在 data/separation/internal.key，只重启主程序不会更换它。

## 任务与日常更新

已存在的分离任务先恢复原断点。断线后查询原任务，避免重复上传；分离进程重启时，未完成推理按原有策略重试。校验成功后才发布伴奏，失败保留可用资源。

日常执行 docker compose pull ktv，再执行 docker compose up -d --no-deps ktv，CPU／NPU 容器继续运行。ARM64 命令增加 -f docker-compose.arm64.yaml。不要删除旧模型、编译缓存或任务目录。

NPU 只负责音频分离。视频裁剪优先 PC，失败后使用主程序中的 FFmpeg。两个分离镜像也保留各自音频处理需要的 FFmpeg。

当前验证包括本机模拟协议、真实 FFmpeg 与云端隔离 Compose 的 CPU 实际分离；新部署的 NPU 设备访问、音质和速度需要在用户 NAS 验证。模型来源与许可见源码 separator/INTEL-MODEL-CARD.md，镜像保留相关许可文件。

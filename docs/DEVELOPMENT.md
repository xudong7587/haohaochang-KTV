# 开发说明

先阅读 [模块分工](DEVELOPMENT-PLAN.md) 和 [对抗性审查](ADVERSARIAL-REVIEW.md)。第 0／1 批已完成，验证结果与实机范围见 PROJECT-STATUS.md。

## 开发和验证

v0.3.14：人工选择的 B站独立画面／原唱不使用时长差异拦截；已确认的 MV 替换也跳过时长比较。保留生成结果与其输入的完整性校验、分离音轨校验和自动匹配逻辑。`bili-stream.js` 统一限定 HTTPS bilivideo.com/cn、v1d.szbdyd.com 子域及默认／4483 端口，逐跳检查重定向；优先普通 CDN，下载按备用线路重试并核对 Content-Length／完整 Content-Range，原子替换文件。线路分类参考 [bili-sync 配置说明](https://bili-sync.amto.cc/configuration#启动-cdn-排序)。`DELETE /api/admin/jobs/:id` 仅删除失败记录，媒体不动；热更新通过带时间戳 URL 重新加载页面，APK 菜单同时清 HTTP 缓存，保留 DOM 存储。

需要 Node.js 22.13+，推荐 Node 24。媒体处理需要 FFmpeg、ffprobe；在线下载需要 yt-dlp。Dockerfile 已安装这些工具。

```sh
npm ci
# 设置 ADMIN_PASSWORD 环境变量后：
npm run dev
npm run build
npm start
npm test
```

开发前端默认在 `5173`，后端在 `3210`。可用 `FFMPEG`、`FFPROBE`、`YTDLP` 指定程序路径，用 `MEDIA_ROOTS` 指定多个媒体目录，目录之间用 `|` 分隔。二维码地址在后台配置并保存到 settings.json。

开发者使用 `docker build -t haohaochang:dev .` 构建本地镜像。NAS x86 部署使用 `docker-compose.yaml`，ARM64 使用 `docker-compose.arm64.yaml`。设置 `KTV_IMAGE=haohaochang:dev` 即可测试本地主镜像；分离容器固定使用 deploy/separation-images.json 中的版本和摘要。

`npm test` 包含真实媒体测试，使用开发依赖中的 FFmpeg/ffprobe 二进制。如果包管理器阻止安装脚本，需要先允许 `ffmpeg-static` 的安装脚本或执行 `node node_modules/ffmpeg-static/install.js`。

浏览器联动检查：安装 Playwright 后运行 `node scripts/ui-check.mjs`，可用 `PLAYWRIGHT_MODULE` 指定已有模块路径、`BROWSER_CHANNEL` 指定浏览器，默认使用 Playwright Chromium，Windows 可设置 BROWSER_CHANNEL=msedge。测试使用独立数据库和合成测试曲，不写入正式曲库。截图位于 `test-results/ui/`。

APK 使用 Java 21、Gradle 9.4.1、Android SDK 36 构建：

```sh
gradle -p android testDebugUnitTest assembleDebug
```

最低 Android 6；前端使用 Vite legacy 兼容构建（Chrome 53 目标）与 AbortController 补丁，仍建议更新 WebView；编译目标不等同于解码器实测。v0.4.0 APK 使用 Media3 1.11.0 原生播放器与 SurfaceView，独立媒体经 MergingMediaSource 使用同一时钟播放；WebView 负责点歌、歌词与菜单；没有在 TV 端嵌入 FFmpeg 或 AI。v0.3.10 起正式分发使用持久 PKCS12 签名，CI 从 `TV_KEYSTORE_BASE64` 与 `TV_KEYSTORE_PASSWORD` Secrets 构建版本化名称 `haohaochang-tv-v<版本>.apk`；密钥不进入 Git。独立构建 release 时设置 `TV_KEYSTORE_FILE`、`TV_KEYSTORE_PASSWORD` 并运行 `gradle -p android assembleRelease`。PR 只构建 debug 包。旧 CI debug 签名可能不同，迁移说明见用户手册。

APK 直接分发给家庭电视，保留现有 `targetSdk 28` 行为。正式构建仅豁免面向 Google Play 的 `ExpiredTargetSdkVersion` 检查，其余 release lint 保留；未来提交应用商店前需要单独迁移 target SDK 并验证平台行为。

PC 更新器协议验证：安装 `psutil==7.0.0` 后执行 `python -m unittest discover -s pc-worker -p 'test_update*.py'`。打包脚本 `scripts/package-release.py` 生成带逐文件 SHA-256 清单的更新 ZIP；发布前需放入同提交的正式 APK。`node scripts/check-release-version.mjs` 校验前端、PC、Android、README 与用户手册版本。

本地 NAS 预览仅放行 `POST /api/admin/find-lyrics` 作为读取远程歌词操作，其他管理写入继续拒绝；查得内容只是编辑草稿，不能保存到正式媒体。自动歌词匹配保留 120 秒时差限制，手动查找可展示超时差候选并提示核对。Live 后缀和合唱顺序在 `shared/lyrics-identity.js` 统一处理。

封面手动编辑使用 `GET /api/admin/poster-search` 和短期候选图片代理；保存只接受服务端候选 ID，上传接口在管理员认证后接受不超过 8 MB 的原始图片字节。两条保存路径复用同歌写锁、修订检查及封面转换，不添加媒体下载任务。只读预览可搜索、查看候选，保存仍返回 403。

歌词提供者新增 `qq-lyrics.js`、`netease-lyrics.js`，使用各平台公开搜索／歌词接口，不请求音频或平台账号。接口格式参考 [QQMusicApi](https://github.com/copws/qq-music-api) 与 [网易云接口实现](https://github.com/feeluown/feeluown-netease/blob/master/fuo_netease/api.py)，实际响应以受限 HTTPS 请求处理；重定向拒绝、10 秒超时、响应最多 2 MB，每次最多读取 6 个候选的 LRC。外部接口不保证长期稳定。测试为 `tests/chinese-lyrics.test.js`、`tests/poster-editor.test.js`、`tests/poster-editor.browser.mjs`，全部使用隔离 fixture。

本机验证记录与待验收项见 [验证记录](VALIDATION.md)，系统决策见 [系统设计](DESIGN.md)。


## 当前检查入口

```sh
npx playwright install chromium
node scripts/ui-check.mjs
node tests/library-ui.browser.mjs
node scripts/player-check.mjs
python -m unittest discover -s separator -p test_protocol.py
```

Python 协议测试需 fastapi==0.115.12、python-multipart==0.0.20 和 httpx，可在独立虚拟环境安装，无需模型或 GPU。浏览器与媒体测试使用临时目录和随机 localhost 端口。

## 本地中文歌词索引

配置 `KTV_LYRICS_INDEX=/data/lyrics/index.json`，文件使用 UTF-8 JSON 数组，LRC 相对索引目录存放。Docker Compose 可在 ktv.environment 中增加同名变量，将索引与歌词放入已映射的 data/lyrics 目录。

```json
[{"id":"my-recording-1","title":"歌名","artist":"歌手","duration":240,"version":"studio","file":"歌曲.lrc","sourceUrl":"https://example.com/source","license":"自有或获授权"}]
```

按歌名和歌手匹配；已知时长允许相差最多 120 秒，缺少时长或录音版本标签不同不再单独拒绝，实际演唱者不同仍拒绝。多份通过歌名、歌手、时长和版本检查的歌词默认选择时长最接近的一份，并保留候选数量。索引最多 20000 项／8 MB，单个 LRC 最多 1 MB，路径不能越出索引目录。支持增强逐字 LRC 与毫秒 offset。失败时回退 LRCLIB；自动匹配仍需试听核对，不保证逐字节奏一致。未找到歌词不阻止整理。

## v0.3.0 局域网与在线视频

Compose 的三个服务均使用 Linux host 网络，不分配 Docker 子网。ktv 默认端口 43210、KTV_DISCOVERY_ENABLED=1；CPU／NPU 是独立容器，分别只监听 127.0.0.1:18002／18001，不使用 ports 映射。主程序生成并保留 data/separation/internal.key，分离容器读取同一密钥。公司环境测试设置 KTV_LOCAL_ONLY=1，createApp({discovery:false})，仅绑定 localhost。

NAS 从 UDP 回复的源 IPv4 推导 PC 地址，检查发现 nonce，再用绑定源 IP 的一次性 challenge 配对；广播不携带工作密钥。发现只支持 RFC1918 IPv4，不跨 VLAN。PC 默认开放工作监听，测试模式显式关闭。在线预览经 NAS 代理，源 URL 仅允许 HTTPS bilivideo.com/cn 域名及其子域，重定向再次校验，凭证不返回浏览器。

在线任务使用 .ktv-online 隐藏目录保留原始下载与裁剪结果，避免自动入库器抢先处理完整视频。worker 的 /clip、/jobs/:id、/clip-artifacts/:id 共用持久化队列；NAS 复用分离任务的幂等上传与检查点协议。waiting-worker 状态由重新配对唤醒；手动连接可重试。新浏览器检查为 `node tests/online-player.browser.mjs`，LAN 协议检查为 `python -m unittest discover -s pc-worker -p test_lan.py`，均不探测局域网。

B站预览优先使用播放器提供的 AVC/AAC DASH 流，yt-dlp 为后备；协议实现参考其 [Bilibili 提取器](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/bilibili.py)，平台变动仍可能影响可用性。

## v0.3.1 PC 状态与启动

`/pc` 是 NAS 前端入口，`GET /api/admin/pc/status` 使用已有管理员认证。NAS 用已配对的工作密钥访问 `/desktop/status`，筛选字段后返回，禁止缓存；浏览器无需访问 PC 地址。管理设置提供同源 `/pc` 链接。

`node tests/pc-dashboard.browser.mjs` 覆盖登录、代理、隐私字段、断线、桌面/手机布局和管理端名称。`npm test` 中的 pc-flow.test.js 用真实 FFmpeg、临时数据库和 localhost 协议替身验证裁剪→提取音频→分离→入库的顺序，不执行模型推理。Windows 运行 `powershell -ExecutionPolicy Bypass -File scripts/launcher-check.ps1` 验证 start.cmd 的隐藏启动链；安装脚本使用临时替身，不下载模型、不启用 LAN。以上检查均纳入 CI。

## 本地反馈优化验证

新增 `node --test tests/feedback.test.js`、`node tests/feedback.browser.mjs`、`python -m unittest discover -s separator -p test_concurrency.py`。Windows 预处理回归为 `powershell -NoProfile -ExecutionPolicy Bypass -File tools/bili-preprocess/test.ps1`。均已纳入 CI 配置，实际本地结果与发布范围见 VALIDATION.md。

在线搜索首次升级启用后记录 `onlineDefaultMigrated`，后续明确关闭不会在重启时重置。设置接口支持独立提交 `onlineEnabled` 或 `publicUrl`，不会覆盖未提交的另一项。后台任务列表保留全部在途任务及有限最近历史；进度为模型当前步骤，无法报告百分比的阶段只显示名称。


## v0.3.6 在线高清链路

`server/bili-login.js` 管理二维码临时会话与共享登录，`providers/bili-wbi.js` 实现签名，`bili-download.js` 按当前账号选择独立DASH并验证真实媒体。设计参考 [bili-sync取流代码](https://github.com/amtoaer/bili-sync/blob/master/crates/bili_sync/src/bilibili/video.rs) 与 [扫码实现](https://github.com/amtoaer/bili-sync/blob/master/crates/bili_sync/src/bilibili/credential.rs)。未直接依赖或调用bili-sync进程。B站来源（在线下载、更新画质、收藏夹下载）统一走这条 API 取流；`favorite-download` 再把独立画面与原唱合成为一个文件。yt-dlp 只保留给 B站以外的来源（YouTube 等）与旧链接替换，平台改版时优先修 API 路径。

在线缓存位于 `.ktv-online/dash`，分辨率与凭证隔离；原始音频成为歌曲来源，独立画面通过 `split-video:<id>` 保留。版本回收保护这类来源引用。`upgrade-hd`只接受已记录的在线来源与裁剪区间，不自动覆盖已有音轨。PC裁剪仍使用已有 `video_only` 协议，新增可选 `vocal_activity` 字段不改变旧分离适配器兼容性。

新增契约测试：`bili-hd.test.js`、`pc-flow.test.js`、`metadata-batch.test.js`、`preview-cancel.test.js`、`lyrics-alignment.test.js`。外部平台均用受控传输fixture，真实用户验证只在隔离本机目录进行，不能把其Cookie、登录二维码或原始媒体加入Git。

TV配对由 `/api/tv-pairing` 创建三分钟内存会话，二维码只携带手机确认凭据；手机通过member认证后确认，电视用另一随机凭据轮询并一次性领取roomToken。Android13+使用OnBackInvokedCallback，旧设备用onBackPressed。网页`haohaochangBack()`返回是否消费操作，根页面交由APK双返回退出。`node tests/tv-pairing.browser.mjs`在隔离localhost上验证首次/重复扫码、登录持久化及返回层级，并已纳入CI；原生遥控器退出仍需实机验收。

## v0.3.7 存储与预览

`server/song-storage.js` 在歌曲写锁内将受管来源视频的全部音轨无损保存为 MKA，更新来源指针与指纹后清除重复画面；`resource-cleanup.js` 回收无引用版本，`download-cleanup.js` 根据成功导入记录和文件签名删除下载输入。生产文件只由正式部署后的任务执行清理，测试使用临时目录。当前播放／队列／在途任务均保护歌曲；未知文件和外部来源不参与删除。

`tests/resource-storage.test.js` 包含多视频合一与后续准备回归，`tests/download-cleanup.test.js` 覆盖失败、改动和共享输入保护，`tests/preview-fallback.test.js` 覆盖签名后备及 CDN Range 保留。默认视频只封装并遍历数据包，显式编码由 PC 完整解码并返回 SHA-256；这两种校验级别必须在文档和状态中区别表述。

电视发现由 `server/index.js` 在 HTTP 启动后开启：`KTV_TV_DISCOVERY_ENABLED=1` 或现有 `KTV_DISCOVERY_ENABLED=1`，`KTV_LOCAL_ONLY=1` 禁用。UDP 43212 只响应私网 IPv4、受大小／频率限制且不含凭证；`KTV_TV_HTTP_PORT` 可声明外部 HTTP 端口，默认 `PORT`。LAN Compose 使用 host 网络接收广播；桥接环境不保证广播可达。

新增 `tests/adaptive-player.browser.mjs` 检查歌星编辑、公共点歌、深色队列、闲置按钮、手机横竖屏、真实 legacy bundle 与启动恢复。`scripts/check-poster-runtime.mjs` 在实际 Docker FFmpeg 上执行 API 保存 PNG／JPEG、方形尺寸／白底和音轨不变检查，并检查启动脚本与图标；CI 和发布晋升 latest 前均执行。歌星资料存储于 `artist-profile:<hash>` KV 和 `/data/artists`，按歌手串行写入与修订检查；自动补图不覆盖已有照片。

播放器资源由 `/api/playback-assets/:id` 给出，`/api/assets/:id/:kind` 使用 sendFile 直接提供范围请求，无播放时转码。v0.3.13 删除 controller 的 100ms 校时定时器；不得重新引入持续比较音画差／周期 seek。保持显式状态切换、拖动、错误后备的时间对齐，以及租约撤销后的立即静音。PlayerVisuals 只读音频时钟，不设置 currentTime；UI 的空闲菜单计时与播放租约心跳仍保留。APK UA 使用 CSS 全屏以保留 DOM 控件，浏览器继续原生全屏加 CSS 后备。

PC 更新器优先读取 Release 固定名附件 `haohaochang-pc-update.json`（schema=1），包地址固定到对应 tag。运行 `python scripts/package-release.py` 或 `--pc-only` 会生成该清单；发布时必须与版本化 PC ZIP 一起上传，缺少清单时客户端回退 REST API。对清单格式、版本、下载域名、大小和 SHA-256 的校验失败不会静默回退。


## v1.0.3 验证与实现约束

B站流帧率可能来自整毫秒时间间隔（62.5 vs 60、30.303 vs 30）；下载后继续核对真实高度、音轨与有效时长，帧率比较用 1 ms 间隔容差。不要退回固定 0.1 fps 门槛。登录轮换位于 `server/bili-credentials.js`，合并并发检查；后台任务和在线预览取流前使用当前凭证。`bili-refresh-confirm` 含待确认的旧令牌，属于秘密设置，不可返回浏览器或日志。

Android `SongCache` 是当前歌曲专用缓存，复用 Media3 CacheDataSource；停止播放器后取消预取，等待网络写入退出再释放与删除，不能在仍读取时删除。不可用缓存回退直读。租约容忍仅限服务端租约有效期内，认证、接管、后台静音和看门狗仍保留。新增 `SongCacheTest`、RoomSession 网络抖动测试和网页租约回归。

分离安装见 [NPU.md](NPU.md)。主程序使用 Node slim，保留 Python、FFmpeg 和下载工具；CPU Demucs 与 Intel NPU OpenVINO 使用固定的独立镜像。x86 Compose 包含三个服务，ARM64 包含主程序和 CPU；PC 继续独立。恢复代码后保留任务取消的 taskFetch／taskSignal 逻辑。`tests/bili-credentials.test.js` 使用协议替身，不能把它称为真实长期凭证维护验收。

## 多架构发布

`publish.yml` 用 ubuntu-latest 和 ubuntu-24.04-arm 原生构建 amd64／arm64 主镜像。每个架构先发布 SHA 加架构的临时标签，再通过 `scripts/check-compose-runtime.sh` 调用固定的独立分离镜像，验证实际短音频、自动鉴权、CPU 回退及只重建主程序。全部通过后合并主镜像版本 manifest 并更新主镜像 latest。workflow_dispatch 可在打标签前验证当前分支，不更新 latest。

## 主程序与分离镜像发布

主程序标签 `v*` 只触发 `.github/workflows/publish.yml` 的主镜像构建、Compose 实际调用验证和主镜像标签推广。Python、FFmpeg、yt-dlp 留在主程序，模型运行环境留在独立 CPU／NPU 镜像。

CPU／NPU 更新使用 `Publish separation runtime (manual)` 工作流，选择一个 backend 并填写独立版本号。它发布 `runtime-<版本>`，拒绝覆盖已有版本，不更新 latest，不修改 Compose。确认设备实测与协议兼容后，再单独更新 `deploy/separation-images.json`、默认 Compose 的固定版本／摘要，并运行 `node scripts/render-compose.mjs` 同步 ARM 配置。普通 UI Release 不执行该工作流。

公共 Compose 使用直接值与中文注释，无 x-worker、YAML 合并引用或 .env 参数。`node scripts/render-compose.mjs` 保留注释生成 ARM64 文件；`--check` 校验格式与固定镜像。只更新 NAS 配置附件时用 `python scripts/package-release.py --nas-only`，同步该附件的 SHA256SUMS，不重打 PC 或 APK。

`sh scripts/check-compose-runtime.sh` 在隔离临时目录使用发给用户的 Compose，通过测试覆盖文件指定镜像、密码、端口和每个容器的数据目录，关闭 LAN 自动发现。验证不创建任何 Compose 网络、自动鉴权、无 NPU 的 CPU 实际分离、以及只重建 ktv 后分离容器 ID 和密钥不变。不能对生产 NAS 运行这个测试脚本。

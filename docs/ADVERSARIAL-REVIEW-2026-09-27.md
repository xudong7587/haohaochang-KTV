# 标准版对抗性审查 · 2026-09-27

已确认 7 项缺陷或安全缺口，其中 2 项 P1、5 项 P2；另列 1 项用户反馈改进建议。最先应处理歌曲删除与点播的并发冲突，以及 PC 自动配对的设备信任边界。以下保留 v1.1.4 审查时的证据；A01–A07 及手机反馈项已在 v1.1.5 修复分支实现，回归测试见 tests/security-regressions.test.js、separator/test_protocol.py、pc-worker/test_lan.py。历史复现脚本仅适用于原审查基线，不作为新版通过标准。

## 审查基线与范围

- GitHub `origin/main`、本地标准版 HEAD、`v1.1.4` 标签解引用均为 `f255ff962adffb6ccb464ba0b2505aa07849c6f8`。已执行 fetch 核对；[正式 Release](https://github.com/xudong7587/haohaochang-KTV/releases/tag/v1.1.4) 发布于 2026-09-24。
- GitHub [同提交 CI](https://github.com/xudong7587/haohaochang-KTV/actions/runs/35955000791) 状态为 success。
- 原工作区处于 `codex/haohaochang-115-rc`，未提交的服务端、前端和配置变更均与 115 分支有关。全部保留，未纳入本轮基线。
- 排除 115 网盘、`android-115`、STRM，以及车载／CarLinkLaunch／车机投屏相关逻辑；即使标准版基线包含车载文件，也不审查这些功能。
- 检查 NAS 鉴权、曲库文件生命周期、任务与分离协议、网页播放和登录；普通 Android 网络／播放协调及部署文件做静态检查。
- 全部动态复现使用临时数据库、合成媒体与 localhost；LAN 用内存 UDP/ASGI 替身。没有连接生产 NAS、探测局域网或添加真实曲库内容。

## 问题清单

| 编号 | 优先级 | 问题 | 验证程度 |
| --- | --- | --- | --- |
| A01 | P1 | 删除与点播并发，文件已删而数据库删除失败 | HTTP 并发复现 |
| A02 | P1 | PC 自动配对向任意可达内网设备发放长期工作密钥 | 实际配对路由＋内存网络替身 |
| A03 | P2 | 未鉴权上传先解析并落盘，之后才返回 401 | 生产固定版 FastAPI＋实际路由复现 |
| A04 | P2 | 限流拒绝前仍同步计算密码哈希 | HTTP＋进程 CPU 计时 |
| A05 | P2 | 改密无法撤销已签发的点歌／房间凭证 | HTTP 复现；管理员权限已正确撤销 |
| A06 | P2 | PC 普通裁剪静默丢弃第二条及后续音轨 | 真实 FFmpeg 复现；协议层条件触发 |
| A07 | P2 | 分离器完成任务无容量／保留期回收 | 小规模文件复现＋生命周期静态检查 |

P1 表示应优先修复的数据完整性或权限边界问题；A02 的风险前提是 PC 所在内网存在不可信且可达的设备。P2 按触发概率和实际部署环境安排，不表示已在生产环境发生。

## A01：删除与点歌未共用歌曲互斥，失败后无法恢复文件

代码：[library-delete.js:185–215](https://github.com/xudong7587/haohaochang-KTV/blob/f255ff962adffb6ccb464ba0b2505aa07849c6f8/server/library-delete.js#L185-L215)、[room.js:107–155](https://github.com/xudong7587/haohaochang-KTV/blob/f255ff962adffb6ccb464ba0b2505aa07849c6f8/server/room.js#L107-L155)。

删除接口取得歌曲写锁，只在开始时检查队列，随后异步遍历删除清单并删除文件。点歌的 enqueue 不参与这把锁，也没有“正在删除”状态。另一个请求可以在文件检查期间把歌曲加入队列。

复现先创建隔离歌曲和 250 个小文件以拉长目录检查窗口，获取正式删除预览 token，再并发发送删除和点歌请求。结果：

- 点歌返回 200。
- 删除返回 400，错误为 `FOREIGN KEY constraint failed`。
- 源文件和播放文件均已不存在。
- songs 与 queue 记录仍然存在。

这里的媒体内容是测试标记，验证的是文件删除和数据库事务顺序，不涉及解码。250 个文件用于稳定暴露真实的 await 窗口；普通目录也存在该窗口，NAS 慢盘／SMB 更容易扩大它。

修复方向：在开始文件操作前原子标记“删除中”，让手动点歌、后台任务投递和开场音乐选歌都遵守同一边界。文件先移到可恢复的隔离区，数据库操作成功后再实际删除；不能只在 rm 前多检查一次队列，那仍有异步竞争窗口。

验收：并发删除与所有入队入口时，要么点歌被拒绝且删除完整成功，要么删除被拒绝且所有文件保留；模拟数据库提交失败时也能恢复原资源。

## A02：自动配对校验“来自内网”，没有校验“这是授权 NAS”

代码：[pc-worker/lan.py:32–55](https://github.com/xudong7587/haohaochang-KTV/blob/f255ff962adffb6ccb464ba0b2505aa07849c6f8/pc-worker/lan.py#L32-L55)、[lan.py:68–87](https://github.com/xudong7587/haohaochang-KTV/blob/f255ff962adffb6ccb464ba0b2505aa07849c6f8/pc-worker/lan.py#L68-L87)、[run.py:12–19](https://github.com/xudong7587/haohaochang-KTV/blob/f255ff962adffb6ccb464ba0b2505aa07849c6f8/pc-worker/run.py#L12-L19)。

PC 默认监听全部地址并开启 LAN 配对。任意私网发送者可索取挑战，再从同一 IP 提交挑战，接口会返回 worker.json 中的长期工作密钥。随机挑战与 IP 绑定阻止了部分重放，但不证明设备获得过用户授权；last_paired 也不限制后续新设备领取密钥。

内存替身以任意私网地址完成该流程，实际 /lan/pair 返回 200 和预设测试密钥。测试没有接触真实网卡。

在共享 Wi-Fi、办公网或受感染家庭设备能访问 PC 端口的条件下，可取得工作服务权限，访问其受密钥保护的任务／结果接口，提交消耗资源的任务。未测试系统命令执行，不将其描述为远程代码执行。

修复方向：首次配对需要本机确认或短时配对码，建立 NAS 身份绑定；后续自动重连用已绑定身份，不重新发放通用长期密钥。增加撤销、轮换和设备列表。若产品明确选择“信任全部家庭内网”，也应提供关闭首次自动配对的可见开关。

验收：陌生私网设备即使取得 UDP 挑战也拿不到工作密钥；已绑定 NAS 重启后能自动恢复；撤销设备后旧密钥失效。

## A03：工作服务在鉴权前接收并落盘上传内容

代码：[separator/upload_guard.py:14–38](https://github.com/xudong7587/haohaochang-KTV/blob/f255ff962adffb6ccb464ba0b2505aa07849c6f8/separator/upload_guard.py#L14-L38)、[app.py:58–60](https://github.com/xudong7587/haohaochang-KTV/blob/f255ff962adffb6ccb464ba0b2505aa07849c6f8/separator/app.py#L58-L60)、[clipping.py:100–102](https://github.com/xudong7587/haohaochang-KTV/blob/f255ff962adffb6ccb464ba0b2505aa07849c6f8/separator/clipping.py#L100-L102)。

UploadGuard 在解析前限制并发数和字节数，但没有检查 Authorization。FastAPI 先解析 multipart 文件，再执行路由 Depends(auth)。

在 FastAPI 0.115.12、Starlette 0.46.2、python-multipart 0.0.20 环境中，向真实 /clip 路由发送无凭证的 2 MiB 测试文件，最终为 401，但已经创建临时文件且 rolledToDisk=true。只观察临时文件创建，未读取任何用户文件。

因此无密钥请求也能消耗临时磁盘及上传槽位；/clip 的解析上限约 4 GiB，两个慢上传可占住当前两个槽位。占满磁盘和慢上传阻塞是由代码边界推导出的风险，本轮没有实施大流量压力测试。默认 NAS CPU／NPU 只监听回环，主要网络暴露面是默认 LAN 监听的 PC。

修复方向：在 ASGI 中间件里校验请求头，校验成功后才获取上传槽和调用 receive；同时限制请求体读取总时长、空闲时间及磁盘低水位。

验收：无效／缺失密钥时 receive 不被调用，multipart 临时文件数为零；被拒绝的请求不占用正常上传槽。

## A04：达到限流阈值后仍可触发同步 scrypt

代码：[app.js:58–87](https://github.com/xudong7587/haohaochang-KTV/blob/f255ff962adffb6ccb464ba0b2505aa07849c6f8/server/app.js#L58-L87)、[app.js:140–145](https://github.com/xudong7587/haohaochang-KTV/blob/f255ff962adffb6ccb464ba0b2505aa07849c6f8/server/app.js#L140-L145)、[request-limits.js:8–38](https://github.com/xudong7587/haohaochang-KTV/blob/f255ff962adffb6ccb464ba0b2505aa07849c6f8/server/request-limits.js#L8-L38)。

后台改过密码、保存 adminPasswordHash 后，任意携带错误 Bearer 的请求都会走 scryptSync。限流器为选取预算先调用 authenticated(req)，在计数和返回 429 之前就执行了这项同步计算。

隔离服务耗尽 auth 预算后各发送 15 次请求：无密码组全为 429，约 231 ms；错误密码组也全为 429，但耗时约 680 ms、进程 CPU 约 625 ms。耗时会随机器变化，关键证据是所有被限流的错误凭证请求仍持续消耗密码计算。

同步哈希运行在 NAS Node 主线程，持续请求会挤占播放心跳、状态和控制处理；返回 429 不能保护这部分开销。尚未在真实 NAS 上测出断音阈值。

修复方向：先执行低成本的来源／认证失败预算，再计算密码；避免对任意业务 API 每次同步派生密码。兼容旧 Bearer 登录时也要单独限制计算并发与队列。

验收：auth 预算耗尽后，新增错误密码请求不再触发 KDF；并发失败登录期间，正常播放心跳仍满足既定时限。

## A05：管理改密不会撤销旧房间 token

代码：[app.js:213–223](https://github.com/xudong7587/haohaochang-KTV/blob/f255ff962adffb6ccb464ba0b2505aa07849c6f8/server/app.js#L213-L223)、[room-registry.js:8–15](https://github.com/xudong7587/haohaochang-KTV/blob/f255ff962adffb6ccb464ba0b2505aa07849c6f8/server/room-registry.js#L8-L15)。

改密正确清除了管理员 Cookie 会话，旧密码也不可用；但共用 roomToken 和独立歌房 token 没有过期或撤销校验。

HTTP 实测：改密后，旧管理员 Cookie、旧管理密码访问 /admin 均为 401；旧默认房间 token 和独立房间 token 访问 /state 均为 200，旧 token 创建新歌房也为 200。

如果用户因为密码泄露、旧访客或设备遗失而改密，已保存点歌凭证的设备仍能访问歌曲、控制歌房、使用允许成员调用的在线任务入口。这个问题没有保留管理员权限；不应描述成“旧密码仍能登录后台”。

修复方向：提供“撤销所有播放／点歌设备”及按设备撤销，并在改密时让用户明确选择；引入凭证版本或可撤销会话。同步收回旧 SSE 和播放器权限，保留房间队列无需保留旧凭证。文档应分别说明管理会话和播放会话的寿命。

验收：选择全部撤销后，旧 token、旧 SSE 和旧播放器失去访问权；新登录能继续使用原曲库和队列。

## A06：PC 普通裁剪只保留第一条音轨

代码：[separator/clipping.py:50–58](https://github.com/xudong7587/haohaochang-KTV/blob/f255ff962adffb6ccb464ba0b2505aa07849c6f8/separator/clipping.py#L50-L58)、[server/clipping.js:82–89](https://github.com/xudong7587/haohaochang-KTV/blob/f255ff962adffb6ccb464ba0b2505aa07849c6f8/server/clipping.js#L82-L89)。

普通 PC 裁剪使用 -map 0:a:0，NAS 后备使用 -map 0:a；NAS 收到 PC 结果时只要求“有音轨”，没有比较音轨数量。

用真实 FFmpeg 制作含两个不同音调音轨的短视频，调用生产 execute_clip(video_only=False)：输入 audioTracks=2，输出 audioTracks=1，任务状态 done。若来源以不同音轨存储原唱和伴奏，后续音轨会丢失。

这是已验证的协议层缺陷。当前常用 B站独立画面裁剪走 video_only=True，不受这一项影响；本轮没有把多音轨协议夹具包装成已发生的线上用户故障。

修复方向：普通裁剪保留所有需要的音轨及顺序，结果校验比对源音轨数；确需单轨时由调用方明确给出选择。NAS 与 PC 使用相同的轨道保留契约。

验收：相同双音轨素材分别走 PC 成功路径、PC 离线后备路径，音轨数／顺序一致，且原唱和伴奏能分别辨认。

## A07：分离工作目录长期累积，活动队列上限不限制已完成任务

代码：[job_store.py:39–69](https://github.com/xudong7587/haohaochang-KTV/blob/f255ff962adffb6ccb464ba0b2505aa07849c6f8/separator/job_store.py#L39-L69)、[inference.py:76–110](https://github.com/xudong7587/haohaochang-KTV/blob/f255ff962adffb6ccb464ba0b2505aa07849c6f8/separator/inference.py#L76-L110)、[clipping.py:90–94](https://github.com/xudong7587/haohaochang-KTV/blob/f255ff962adffb6ccb464ba0b2505aa07849c6f8/separator/clipping.py#L90-L94)。

任务完成后仍保存上传源、解码 WAV、模型输出和最终结果；裁剪保留 input.mp4 与 clip.mp4。recover 只清理被中断的 input.part；没有按年龄、总容量或 NAS 确认消费回收结果的流程。NAS 正式资源版本清理不覆盖这些工作目录。

隔离测试中，一个真实裁剪结果在恢复后源文件／结果均保留，再顺序创建 12 个小型已完成任务后共保留 13 个目录，pending=0；capacity=10 只限制活动任务。未做实际灌满磁盘测试。

长期整理会持续占用 PC 或 NAS data 卷，最终影响新任务，NAS 共盘时也可能影响数据库写入。幂等查询还会逐一读取历史 info.json，历史越多查询成本越高。

修复方向：增加 NAS 消费确认与有宽限期的回收，设置工作目录容量及保留期、低磁盘拒绝新任务；保留必要的小型幂等索引。不能在结果首次 GET 后立即删除，必须支持传输中断和 NAS 重试。

验收：完成、失败、取消、传输中断及重启分别测试；仍被 NAS 使用的结果保留，超过保留期的结果可回收，磁盘不足时返回可理解的错误。

## 另一个建议：在线任务失败后给点歌端明确反馈

代码：[routes/online.js:90–131](https://github.com/xudong7587/haohaochang-KTV/blob/f255ff962adffb6ccb464ba0b2505aa07849c6f8/server/routes/online.js#L90-L131)、[mobile-requests.jsx:24–43](https://github.com/xudong7587/haohaochang-KTV/blob/f255ff962adffb6ccb464ba0b2505aa07849c6f8/src/mobile-requests.jsx#L24-L43)。

/requests/status 只查 running／queued／waiting-worker，failed／review 的提示分支不可达。前端也只显示活动任务。夹具中的在线请求在 queued 时返回一条，改成 failed 后返回空数组，进度条随之消失。

当前文档明确采用“只显示活动进度、空闲隐藏”，因此这一项单列为产品反馈建议，不计入上述 7 项缺陷：保留最近一次请求的失败／待核对状态，提供关闭提示或联系管理员的入口，避免用户把进度消失误认为完成后反复点歌。

## 验证结果与未覆盖范围

| 验证 | 结果 |
| --- | --- |
| 标准版 npm test | 243 项；242 通过、1 跳过、0 失败；含真实 FFmpeg |
| npm run build | 通过；存在既有 chunk 大小提示 |
| separator/test_protocol.py | 16 项通过 |
| pc-worker/test_lan.py | 2 项通过；内存网络替身 |
| tv-pairing.browser.mjs | 通过；Edge，隔离 localhost |
| player-lease.browser.mjs | 通过；接管、撤销静音、离线、延迟响应 |
| library-ui.browser.mjs | 通过；草稿、删除、隐藏恢复、排序等组件契约 |
| 本轮 Node 对抗复现 | 已取得 A01/A04/A05 及任务反馈观察 |
| 本轮 Python 对抗复现 | 已取得 A02/A03/A06/A07 观察 |
| npm audit --omit=dev | registry.npmjs.org 请求超时，无法得出依赖漏洞结论 |

最初浏览器入口在 .codex 隐藏目录下返回 404，原因是 res.sendFile 的 dotfile 规则。把同一构建产物放到普通临时目录再运行原测试后三项均通过；未把该本地路径问题计为正式部署缺陷。

未重跑 Android 实机／APK 构建、Docker 实际镜像、NAS 反代多人压力、GPU／NPU 推理或真实平台下载。受审查的五个 separator 文件与 v1.0.8 相同，但这不替代固定摘要镜像的实际运行验证。没有宣称这些缺陷已在生产 NAS 重现，也没有宣称项目不存在其他漏洞。

收藏夹取消后“重新同步不重下”的观察已排除：合集 /retry 能创建替代下载任务，复现返回 200 且任务数恢复为 1。

## 材料与复现

- [Node 复现脚本](../scripts/review-20260927.mjs)
- [Python 工作服务复现脚本](../scripts/review-20260927-worker.py)
- [Node 观察 JSON](review-evidence/2026-09-27/review-20260927-node.json)
- [工作服务观察 JSON](review-evidence/2026-09-27/review-20260927-worker.json)
- [依赖审计超时记录](review-evidence/2026-09-27/dependency-audit.json)
- 基线与浏览器日志保存在隔离工作区根目录的 baseline-*.log、review-*.log。

在本次 Windows 隔离工作区，Node 24.18.0：

```powershell
node scripts/review-20260927.mjs
python -m venv .review-venv
.review-venv/Scripts/python -m pip install fastapi==0.115.12 python-multipart==0.0.20 httpx psutil==7.0.0 numpy==1.26.4
.review-venv/Scripts/python scripts/review-20260927-worker.py
```

先安装 package-lock 对应 Node 依赖并准备 ffmpeg-static／ffprobe-static 二进制。Python 脚本使用 Windows 二进制路径；迁移到 Linux 时需要调整该路径。所有脚本只操作自己的临时目录，退出时清理夹具；结果 JSON 留在 test-results。它们断言的是当前缺陷表现，退出 0 仅表示复现成立，修复后应转换为断言正确行为的正式回归测试。

建议先交付 A01 的删除／入队一致性修复，再一起处理 A02–A05 的认证边界。A06–A07 涉及工作服务，按项目规则另发 CPU／NPU runtime；先完成兼容验证，再更新固定版本清单与 Compose，不能通过普通主程序 Release 默默改写分离镜像。

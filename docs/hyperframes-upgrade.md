# HyperFrames 0.8.33 → 0.9.43：能力、接口与本地部署

核对日期：2026-11-13（美国东部时间）。目标是本机运行 MCP，局域网客户端通过 Streamable HTTP 调用，本机 Chromium/FFmpeg 完成渲染。

## 版本与依据

- 升级前 `package.json` 和 Dockerfile 都固定为 `0.8.33`。
- 实时查询 npm 官方 registry 的 `latest` 为 `0.9.43`；官方 GitHub 同名 release 也已发布。
- 现在 `package.json` 固定 `0.9.43`，新增 `package-lock.json`，本地和容器都使用项目内的同一份 CLI。Dockerfile 不再另装一份全局 CLI。
- MCP 自身版本统一为 `1.3.0`；`hyperframes_version` 返回实际执行的 CLI 版本。`/health` 的 `hyperframesVersion` 是依赖声明版本，不能代替实际 CLI 版本查询。

对比直接使用两个版本 npm 发布包中的 `dist/cli.js` 和命令定义，避免将当前文档中的能力误当成新版独有能力。对比范围是 CLI 能力及其 MCP 覆盖情况，没有逐一审计全部 Studio UI 和内部提交。

原始来源：

- [0.8.33 npm 发布包](https://registry.npmjs.org/hyperframes/-/hyperframes-0.8.33.tgz)
- [0.9.43 npm 发布包](https://registry.npmjs.org/hyperframes/-/hyperframes-0.9.43.tgz)
- [0.8.33 CLI 源码](https://github.com/heygen-com/hyperframes/blob/v0.8.33/packages/cli/src/cli.ts)
- [0.9.43 CLI 源码](https://github.com/heygen-com/hyperframes/blob/v0.9.43/packages/cli/src/cli.ts)
- [0.9.43 render 命令](https://github.com/heygen-com/hyperframes/blob/v0.9.43/packages/cli/src/commands/render.ts)
- [0.9.43 发布说明](https://github.com/heygen-com/hyperframes/releases/tag/v0.9.43)

## 能力差异与 MCP 决定

| 能力 | 0.8.33 | 0.9.43 | 本次 MCP 处理 |
| --- | --- | --- | --- |
| 视频输出 | MP4、WebM、MOV、GIF、PNG 序列 | 增加 HLS；MOV 可选 ProRes 档位 | render 暴露全部六类格式及 ProRes、HLS 参数；下载接口补齐 MIME |
| 画质 | draft / standard / high；MOV 固定 ProRes 4444 | 增加 looks / delivery；默认 looks，新增关键帧间隔、峰值码率、缓冲参数 | 保留旧选项，新增选项均开放；未指定画质时沿用新版默认 |
| 帧率、变量、批量输出 | 已支持 1–240、分数帧率、变量、批量、分辨率、自动 workers、低内存模式 | 保留并扩展 | 这些以前被 MCP 参数限制遮住，本次开放；不是新版首次实现 |
| 时间片段 | 无 render 的 start/end 选项 | 增加起止秒数导出；上游限制为特定帧率的 SDR MP4 | render 增加 start/end；组合限制交给 CLI 校验 |
| 综合检查 | 已有 check：lint、运行时、布局、运动、对比度 | 增加/扩展范围与组件筛选、缓存、预算、craft 检查等；validate/inspect 标记弃用 | 新增 hyperframes_check；保留 validate 向后兼容 |
| 截图 | 已有 snapshot、时间点、缩放、角度、参考视频对比 | 增加范围/场景采样、review 场景与切点拼图、JSON 输出、keep；默认存入独立 artifacts 目录 | 新增 hyperframes_snapshot；不传 describe，不调用视觉模型 |
| 时间轴/历史 | 没有 timeline/history 顶层命令 | 增加轨道、片段读取和编辑，以及历史撤销/恢复 | 新增只读 hyperframes_timeline；编辑和 history 通过高级 CLI 按需调用 |
| 音频分析 | 已有 beats、normalize-audio | 新增统一 audio，分析声音落点、响度、静音等 | 新增 hyperframes_audio，固定 fast 本地信号分析；不调用托管音频分析 |
| 转写 | 已有 Whisper、Parakeet/auto、字幕导入与导出 | 扩展 Parakeet 运行器和引擎实现；上游也有托管引擎 | 增加 auto/whisper/parakeet 和 language；专用接口不提供 heygen 引擎 |
| 素材/参考视频 | 已有 capture、compare、去背景等 | 增加 media-use、measure、diff 等顶层命令 | 扩展高级 CLI 白名单；不为低频命令逐一制造专用接口 |
| 桌面、分享、账户 | 已有部分发布/登录/云部署命令 | 增加桌面协作、分享、用量、账单和 Pro 模板相关命令 | 不增加官方云渲染、发布或账户接口，符合本次局域网部署范围 |

两个发布包的顶层命令注册表分别为 40、56 项，旧命令没有从注册表移除。16 个新增项为：

```text
media-use share open catch-up audio timeline history usage models clean update
diff measure reverse billing templates
```

这表示入口数量变化，不代表 56 项都能离线运行或均属于视频渲染。比如 share 会分享成片，templates 需要 Pro，billing 管理订阅，open 面向桌面应用。

本次新增 5 个专用 MCP 工具，总数 16 → 21：

```text
hyperframes_version
hyperframes_check
hyperframes_snapshot
hyperframes_timeline
hyperframes_audio
```

其他必要修复：

- init 原来直接传 `--fps`，但 CLI 没有该 init 参数。现在创建后把帧率写入 composition 根元素的 `data-fps`，并验证有效范围。
- init 校验项目名并跳过在服务器上安装 AI 编程 skills；默认空白模板已实测。
- CLI 失败现在设置 MCP `isError: true`，避免客户端误判为成功。
- 原先文件列表跳过整个 renders 目录，现在可发现视频、HLS 分片和 PNG 序列。
- 本机运行默认使用仓库 `workspace/projects` 和项目内 CLI；原先的 `/workspace/projects`、`/usr/local/bin/hyperframes` 是容器路径。
- 本机未显式指定浏览器时交给 HyperFrames 自动发现，不再强行传入仅容器存在的 wrapper。

## 远程调用与目录

```text
局域网客户端
  → HTTP POST /mcp
  → src/server.js 注册的工具
  → execFile(项目内 hyperframes, 参数数组, { cwd: 项目目录 })
  → 本机 Chromium / FFmpeg
  → 成片保存到本机项目目录
  → 工具返回文字/JSON；客户端再用 HTTP GET /artifacts/... 下载
```

MCP 本身没有把项目打包上传到官方云，也没有每次创建临时项目目录。`project_write_file` 直接写到 `HF_WORKSPACE/<project>/`，render 把该目录作为工作目录。使用 `execFile` 传参数数组，不经 shell 拼接命令。

| 文件类别 | 当前本机路径/规则 | 生命周期 |
| --- | --- | --- |
| 项目源码与素材 | `/Users/YOUR_USER/work/tools/hyperframes-mcp/workspace/projects/<project>/` | 持续保留，多次调用复用 |
| 默认成片 | 项目内 `renders/<project>_<日期>_<时间>.<ext>` | 持续保留；显式 output 可指定其他项目内路径 |
| 截图 | 项目内 `.hyperframes/artifacts/snapshots/<unique-id>/` | 持续保留 |
| 检查报告 | 项目内 `.hyperframes/artifacts/checks/` | 持续保留 |
| macOS / Windows 渲染中间文件 | 系统临时目录 `hf-render-*` | 普通模式在收尾时删除 |
| Linux 渲染中间文件 | 成片目录旁 `work-<job-id>-*` | 普通模式在收尾时删除 |
| 源视频抽帧缓存 | 默认系统临时目录 `hyperframes-extract-cache-<uid>` | 跨任务复用，不随单次 render 全部删除；framesCacheDir 可指定项目内目录或 off |
| debug 中间文件 | 上游 producer 的 `.debug/<job-id>`，可受 PRODUCER_RENDERS_DIR 影响 | debug 模式保留 |

本机实测渲染期间出现：

```text
/var/folders/vv/c4rxspk153g_gsxwlzvl5k4c0000gn/T/hf-render-igvNHF
```

渲染结束后该目录已删除。正常清理逻辑不能保证在强制杀进程、主机崩溃、断电时执行。`debug`、成功任务的 `KEEP_TEMP=1`、分段恢复或缓存也可能有意保留数据。

客户端机器不会因调用该 MCP 自动生成渲染目录；只有客户端主动下载时才在客户端保存文件。MCP 主机需要有所有引用素材的本地文件或可访问 URL，客户端的 `/Users/...` 或 `C:\\...` 路径不会被自动上传。

当前 render 工具会等待 CLI 完成再返回，默认上限 15 分钟。没有后台任务队列、独立 job ID 查询或断线续接接口；上游内部的渲染进度目前缓存在子进程输出中，没有转发成 MCP 进度通知。长视频调用方需设置合适超时。

## 本机局域网服务

已启动后台进程，监听 `0.0.0.0:9006`。当前本机局域网地址：

```text
MCP:    http://<this-machine-LAN-IP>:9006/mcp
health: http://<this-machine-LAN-IP>:9006/health
```

其他机器应使用支持 HTTP Streamable HTTP 的 MCP 客户端。运行在公网的云端客户端无法直接连接局域网地址。

运行文件（均在 gitignore 的 workspace 内）：

```text
workspace/server.pid
workspace/server.log
workspace/projects/
```

本次后台进程未设开机自启。从仓库目录停止本次进程：

```bash
kill "$(cat workspace/server.pid)"
```

需要再次以前台方式运行：

```bash
npm ci
npm start
```

默认面向可信局域网，无鉴权；高级 CLI 参数不是文件系统隔离边界。专用 render 不使用官方云，但原始 CLI 的部分素材、分析、模型命令仍可能按调用者指定的选项联网。catalog/add 获取注册表、素材远程 URL、首次模型下载也需要网络。

## 已验证与边界

`npm run check` 和 `git diff --check` 通过。`npm run smoke` 的真实 HTTP MCP 测试通过，发现 21 个工具，包括：

- 初始化协议、列出工具、实际 CLI 版本、创建项目并写入 24fps。
- 文件写入/读取、metadata、lint、compositions、timeline、check。
- 两个时间点的真实 PNG 截图与下载字节校验。
- 1 秒、320×180、24fps、24 帧的动态 MP4，ffprobe 检查、完整 FFmpeg 解码、HTTP 下载字节一致。
- HLS playlist/segment 输出、正确 MIME 下载及完整解码。
- 本地正弦测试音频的响度/静音分析、SRT 导入、TTS 声音列表。
- 越界输出、不安全截图目录、互斥参数、禁止的 cloud 命令及 CLI 错误返回。

证据保存在：

```text
workspace/verification/smoke-1794628986426-report.json
workspace/verification/smoke-1794628986426/
workspace/verification/lan-report.json
workspace/projects/lan-smoke/renders/lan-smoke.mp4
```

最后一项额外通过本机的 `<this-machine-LAN-IP>` 地址发起 MCP 创建和渲染、完整解码及下载字节一致性检查，并观察到临时目录创建/删除。已确认监听所有 IPv4 网卡；尚未从第二台独立机器验证网络或主机防火墙通行。

本次未实际执行语音识别模型推理、Kokoro 合成、去背景模型、所有 GIF/MOV/PNG 编码组合、批量变量任务或 Docker 构建，也没有更改登录启动项。doctor 显示本机 Chrome/FFmpeg/Whisper CLI 可用，Kokoro Python 运行时和 Docker 未安装；这些是可选能力边界，不影响已验证的本机 MP4/HLS 渲染。

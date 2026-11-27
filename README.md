# HyperFrames MCP 服务器

简体中文 | [English](README.en.md)

这是一个面向局域网部署的 HyperFrames 0.9.43 MCP 服务器。客户端可通过 Streamable HTTP 创建项目、编写文件、检查和验证合成、查看时间线、渲染视频、转写音频、生成配音、访问素材目录和文档，也可调用高级 HyperFrames CLI 工具。

## 架构

```text
局域网客户端 → HTTP /mcp → 服务主机 → 项目本地的 HyperFrames CLI → 本机 Chromium / FFmpeg → 视频文件
局域网客户端 ← HTTP /artifacts/<project>/<file> ← 服务主机
```

本仓库直接使用公开发布的 HyperFrames npm 包。Nate Herk 的学生工具包采用 MIT 许可，其中附带的 AIS 品牌素材没有再使用许可，请勿将这些素材复制到服务器中。

## 本地运行

需要 Node.js 22 或更高版本、FFmpeg，以及 Chromium 或 Chrome。

```bash
npm ci
npm start
```

本机通过 `http://localhost:9006/mcp` 连接。局域网客户端使用 `http://<this-machine-LAN-IP>:9006/mcp`，传输协议为 Streamable HTTP。

服务默认监听 `0.0.0.0:9006`。渲染全部在服务主机上完成，无需 HeyGen 账号、官方云渲染服务或全局安装的 HyperFrames。

服务按顺序选择浏览器：先读取 `PUPPETEER_EXECUTABLE_PATH`，再读取 `HYPERFRAMES_BROWSER_PATH`，然后检查 Docker 镜像安装的 `/usr/local/bin/hyperframes-chromium` 是否存在。以上都未提供时，由 HyperFrames 自动检测 Chrome 或 Chromium。选定的路径会通过上述两个变量传给 CLI。每次调用 CLI 都设置 `CI=1`。

客户端须支持通过普通 HTTP 连接局域网 MCP 服务。托管在云端的客户端无法直接访问局域网私有 IP。

| 变量 | 默认值或说明 |
| --- | --- |
| `HOST` | `0.0.0.0` |
| `PORT` | `9006` |
| `HF_WORKSPACE` | 安装版使用 `<install dir>/.hyperframes-mcp/projects`，见下文「安装」。源码运行时使用 `<this-repo>/.hyperframes-mcp/projects`。 |
| `HYPERFRAMES_BIN` | 本包的 `node_modules/.bin/hyperframes`，位置为 `<repo>/node_modules/...` 或 `<install dir>/app/node_modules/...`。 |
| `HYPERFRAMES_MCP_HOME` | 默认项目工作区的基准目录。安装版启动器将其设为安装目录。源码运行时该变量未设置，服务使用仓库根目录。 |
| `HYPERFRAMES_MCP_NODE` | 仅供启动器使用，指定 Node.js 可执行文件。默认使用 `PATH` 中找到的第一个 `node`。 |
| `HF_COMMAND_TIMEOUT_MS` | `900000`，单次同步命令限时 15 分钟。`hyperframes_render` 作业使用下方的独立超时设置。 |
| `HF_RENDER_TIMEOUT_MS` | `7200000`，每个渲染作业限时 2 小时。超时后停止并标记为失败。 |
| `HF_MAX_CONCURRENT_RENDERS` | `1`，同时运行的渲染作业数，其余作业排队。 |
| `PUPPETEER_EXECUTABLE_PATH` / `HYPERFRAMES_BROWSER_PATH` | 手动指定浏览器路径，默认自动检测。 |
| `HF_MAX_UPLOAD_BYTES` | `1073741824`，单次文件或归档包上传上限为 1 GiB。 |
| `HF_MAX_EXTRACT_BYTES` | `2147483648`，单个归档包解包后的总大小上限为 2 GiB。 |
| `HF_MAX_ARCHIVE_ENTRIES` | `10000` |
| `HF_REQUEST_TIMEOUT_MS` | `3600000`，接收单个 HTTP 请求的时限，含上传请求体。 |
| `PUBLIC_BASE_URL` | 默认未设置。下载链接根据请求的 `Host` / `X-Forwarded-*` 头生成。可设为 `https://hf.example.com` 等固定地址。 |

`bin/hyperframes-mcp.js` 和安装版启动器支持 `--host`、`-p/--port`、`-w/--workspace`（会展开 `~`）、`--browser`（设置 `PUPPETEER_EXECUTABLE_PATH`）、`-v/--version` 和 `-h/--help`。用于配置服务的参数会设置相应变量。

访问 `http://localhost:9006/health` 可检查服务状态，返回 `{ ok, service, version, hyperframesVersion, maxUploadBytes }`。`hyperframesVersion` 是依赖中声明的版本，调用 `hyperframes_version` 可查看实际运行的 CLI 版本。`GET /` 会列出主要路由。

服务启动时会创建 `HF_WORKSPACE`，并清空其下的 `.staging/`。该目录用于暂存上传、归档包和待删除文件。项目名不能以 `.` 开头，因此该目录不会被当成项目。

## 安装

`npm run package` 会在源码目录以外生成独立的安装目录。安装包包含平台专用的二进制文件，请在实际运行服务的机器上打包。

```bash
cd hyperframes-mcp            # 进入源码目录
npm ci
npm run package -- --out=~/work/tools/hyperframes-mcp
~/work/tools/hyperframes-mcp/hyperframes-mcp --version
```

打包脚本将 `bin/`、`src/`、包清单、锁文件和两份 README 复制到 `<out>/app/`，在该目录执行 `npm ci` 安装生产依赖，再生成启动器 `hyperframes-mcp` 和配置示例 `hyperframes-mcp.env.example`。

```text
~/work/tools/hyperframes-mcp/
├── hyperframes-mcp                启动器，供 launchd 调用
├── hyperframes-mcp.env            可选配置，从示例复制
├── hyperframes-mcp.env.example    配置示例，升级时覆盖
├── service.log                    启用 launchd 后写入的日志
├── app/                           服务代码和依赖，升级时替换
└── .hyperframes-mcp/projects/     服务创建的默认项目目录
```

升级时先拉取新源码，执行同一条 `npm run package -- --out=...`，再重启服务。脚本会先在旁边装好新版本，再替换 `app/`，同时更新启动器和配置示例。`hyperframes-mcp.env` 与 `.hyperframes-mcp/` 会保留。

用 `cp hyperframes-mcp.env.example hyperframes-mcp.env` 复制配置后，按上表编辑变量。命令行参数优先。运行 `hyperframes-mcp --help` 可查看 `--host`、`--port`、`--workspace` 和 `--browser`。启动器支持通过软链接执行，使用 `HYPERFRAMES_MCP_NODE` 指定的 Node.js，或 `PATH` 中找到的第一个 `node`（22 或更高版本）。启动器把 `HYPERFRAMES_MCP_HOME` 设为自己的目录，默认项目目录会建在这里。通过源码运行 `npm start` 时，默认项目目录建在仓库根目录下。

### 在 macOS 上通过 launchd 后台运行

使用 [launchd 配置模板](docs/launchd/com.example.hyperframes-mcp.plist)。launchd 不会展开 `~`，请将 `/Users/YOUR_USER` 改为实际用户目录。模板里的 `PATH` 必须包含 `node`、`ffmpeg` 和 `ffprobe` 所在目录，可以用 `which node ffmpeg` 查看路径。将 `ProcessType` 保持为 `Interactive`。`Background` 或未设置时，macOS 可能限制服务器及其 Chrome、FFmpeg 进程使用 CPU 和磁盘。

在 `hyperframes-mcp.env` 里设置浏览器路径，例如 `PUPPETEER_EXECUTABLE_PATH=/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`。

```bash
mkdir -p ~/Library/LaunchAgents
cp docs/launchd/com.example.hyperframes-mcp.plist ~/Library/LaunchAgents/
# 编辑路径后执行以下命令
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.example.hyperframes-mcp.plist   # 立即启动，并在登录时启动
launchctl print gui/$(id -u)/com.example.hyperframes-mcp | head -20                          # 查看状态
launchctl kickstart -k gui/$(id -u)/com.example.hyperframes-mcp                              # 重启，例如升级后
launchctl bootout gui/$(id -u)/com.example.hyperframes-mcp                                   # 停止并卸载任务
tail -f ~/work/tools/hyperframes-mcp/service.log                                             # 查看日志
curl --retry 10 --retry-connrefused --retry-delay 1 http://127.0.0.1:9006/health             # 等待服务就绪
```

停止服务会发送 SIGTERM，正在运行的渲染作业会终止。作业状态存在内存中，重启后需要重新提交。项目文件和已生成的结果保留在磁盘上。

## 可选的 Render.com / Docker 部署

仓库提供 `Dockerfile` 和 `render.yaml`，用于在 Render.com 托管本项目的 MCP 服务。渲染由容器运行的 HyperFrames 执行。局域网部署请使用上面的本地步骤。

容器使用 `/workspace/projects` 和与本地服务相同的 npm 锁定依赖。镜像安装 Debian 的 `chromium` 和 FFmpeg。Render 只提供约 64 MB 的 `/dev/shm`，镜像在 `/usr/local/bin/hyperframes-chromium` 提供包装脚本，通过 `--disable-dev-shm-usage --no-sandbox --disable-gpu --single-process` 等参数启动浏览器。服务会自动检测这个脚本。

1. 在 Render 中，从本 GitHub 仓库创建 **Web Service**。
2. 选择 Docker 运行时，Blueprint 已指定该选项。
3. 部署 `main` 分支。
4. 部署后访问 `/health`，确认返回的 JSON 中有 `ok: true`。
5. 使用下面的 MCP 地址。

`https://YOUR-SERVICE.onrender.com/mcp`

Render 的 Web Service 要求服务监听 `0.0.0.0` 和环境变量 `PORT` 指定的端口，本服务默认会读取这些设置。自带的健康检查使用 `/health`。

## 连接 MCP 客户端

局域网内使用 **Streamable HTTP** 连接 `http://<this-machine-LAN-IP>:9006/mcp`。部署在 Render.com 时，使用部署后以 `/mcp` 结尾的 HTTPS 地址。

```text
https://YOUR-SERVICE.onrender.com/mcp
```

连接后，服务器通过 MCP 的 `instructions` 告知客户端操作顺序：上传素材、提交渲染、查询进度、下载结果和清理项目。

### 客户端合成指南

`hyperframes init` 使用 `--skip-skills`，因为 HyperFrames 自带的 Agent 技能需要本地 shell 和 `npx`。MCP 客户端通过 `hyperframes_docs` 读取本服务器提供的两个主题，内容存放在 [`src/guide/`](src/guide/)。

- `contract` 说明合成 HTML 的规则，涵盖片段时间、时间线注册、确定性、场景 `<template>` 文件、ID 对应关系、字体和素材路径，并附有最小的双场景示例。
- `workflow` 说明工具和 HTTP 接口的调用顺序，从 `hyperframes_init` 开始，依次上传、写入、检查、截图、渲染、下载，最后调用 `project_cleanup`。

MCP 的 `instructions` 以及 `hyperframes_init`、`project_write_file` 的描述都会提示客户端，先阅读这两个主题，再编写合成。其他主题交给 `hyperframes docs` 处理。升级 HyperFrames 时，请对照 `node_modules/hyperframes/dist/skills/` 下的 `hyperframes`、`hyperframes-cli` 技能，核对指南并更新 `src/server.js` 中的 `CLI_DOC_TOPICS`。`npm run smoke` 会验证指南中的示例能否通过 `check`。

连接后，客户端可以发现 25 个工具。

| 工具 | 用途与主要参数 |
| --- | --- |
| `hyperframes_doctor` | 检查服务主机上的 HyperFrames、Node、FFmpeg 和 Chromium。 |
| `hyperframes_version` | 查看实际运行的 CLI 版本。 |
| `hyperframes_init` | 创建项目，参数为 `name`、`example`、`resolution`、`fps`。执行 `init --non-interactive --skip-skills`，随后把 `fps` 写到合成根元素的 `data-fps`。上传前须先调用此工具。 |
| `hyperframes_info` / `hyperframes_lint` / `hyperframes_validate` / `hyperframes_compositions` | 分别查看项目元数据（JSON）、静态检查、旧版验证结果，以及合成 ID 和时长。 |
| `hyperframes_check` | 推荐使用的综合检查，涵盖静态规则、运行时、布局、运动和对比度。参数包括 `samples`、`at`、`range`、`components`、`atTransitions`、`strict`、`contrast`、`craft`、`cache`、`snapshots`、`timeout`、`budget`、`json`。 |
| `hyperframes_snapshot` | 生成 PNG 关键帧或审阅图。参数包括 `frames`、`at`、`range`、`composition`、`review`、`end`、`keep`、`zoom`、`zoomScale`、`angle`、`against`、`json`、`timeout`。CLI 会清空显式指定的 `output`，请使用独立的输出目录，避开项目根目录、`index.html`、`assets`、`compositions` 和 `.hyperframes` 等路径。此工具在本地生成截图，无需调用 AI 视觉服务。 |
| `hyperframes_timeline` | 读取轨道、片段和时间信息。通过 `hyperframes_cli` 编辑。 |
| `hyperframes_audio` | 在本地分析音频的时间、响度和静音区间，固定使用 `--quality fast`。参数包括 `input`、`target`、`at`、`range`、`capabilities`、`json`。 |
| `hyperframes_render` | 提交后台渲染作业，见[渲染作业](#渲染作业)。 |
| `hyperframes_render_status` / `_cancel` / `_list` | 查询、取消和列出渲染作业。 |
| `hyperframes_transcribe` | 在本地转写音频，支持 `engine`（`auto` / `whisper` / `parakeet`）、`model`、`language`，也支持导入 SRT、VTT 或 JSON。可能需要下载模型。 |
| `hyperframes_tts` | 在本地用 Kokoro 生成配音，支持 `text`（最多 20 000 字符）、`output`、`voice`、`speed`、`language`。可能需要下载模型。 |
| `hyperframes_catalog` / `hyperframes_add` | 搜索素材目录或安装目录中的条目，需要联网。 |
| `hyperframes_docs` | 读取 `contract`、`workflow`（见[客户端合成指南](#客户端合成指南)）或指定的 CLI 文档主题。 |
| `project_write_file` / `project_read_file` / `project_list_files` | 读写 UTF-8 文本文件，单次写入最多 2 MB。读取二进制文件时返回下载链接。文件列表含渲染产物和截图，跳过 `node_modules` 和 `.git`。 |
| `project_cleanup` | 删除已完成的项目或仅清理中间文件，见[清理已完成的项目](#清理已完成的项目)。 |
| `hyperframes_cli` | 通过原始 `args`（最多 60 个）同步调用高级命令。允许的命令包括 `doctor init info lint validate check preview render compositions catalog add transcribe tts upgrade docs snapshot timeline audio normalize-audio beats inspect keyframes layout measure diff compare grade-compare media-treatment media-use remove-background capture history`。云服务、发布、分享和账号命令不在允许列表内。 |

项目名须符合 `^[a-zA-Z0-9][a-zA-Z0-9._-]{0,80}$`。文件路径参数都以项目目录为基准，解析软链接后仍须指向项目内的位置。

## 文件与渲染产物

项目保存在 `HF_WORKSPACE/<project>/`。CLI 在项目目录中运行，多次渲染共用同一个项目。

- 默认渲染文件为项目内的 `renders/<project>_<date>_<time>.<ext>`。可通过相对项目目录的 `output` 指定其他路径。
- 截图保存在 `.hyperframes/artifacts/snapshots/<unique-id>/`，检查报告保存在 `.hyperframes/artifacts/checks/`。
- 在 macOS 和 Windows 上，渲染中间文件位于系统临时目录中的 `hf-render-*`。Linux 上则位于输出文件旁的 `work-<job-id>-*` 目录。正常完成或失败时，HyperFrames 通常会删除工作目录。调试模式、`KEEP_TEMP=1` 或进程、主机意外退出可能留下文件。
- 提取后的媒体默认缓存在系统临时目录下的 `hyperframes-extract-cache-<uid>`，供多个渲染复用。将渲染参数 `framesCacheDir` 设为 `"off"` 可关闭本次渲染的缓存。
- 局域网客户端收到文本或 JSON 结果后，需要通过 `/artifacts/<project>/<relative-file>` 下载文件。作业成功后，`hyperframes_render_status` 在 `artifacts` 中列出生成文件的 `url`、`size` 和 `sha256`。调用 `project_list_files` 可查找 HLS 分片、PNG 序列等文件。

## 清理已完成的项目

服务会保留项目，直到客户端调用 `project_cleanup`。请在下载所需产物后再清理。

| 参数 | 默认值 | 含义 |
| --- | --- | --- |
| `project` | 必填 | 项目名。 |
| `scope` | `"project"` | `"project"` 删除整个项目目录（源码、上传文件和渲染产物），同时移除该项目已结束的作业记录。`"intermediate"` 仅删除 `.hyperframes/artifacts/` 中的截图和检查报告，以及渲染崩溃或被终止后留下的 `work-<8 hex>-*` 目录。 |
| `dryRun` | `false` | 设为 `true` 时，只返回将要删除的路径、文件数和字节数。 |
| `cancelRenders` | `false` | 默认只在项目没有排队或运行中的渲染作业时执行。设为 `true` 时，先取消这些作业（发 SIGTERM，10 秒后发 SIGKILL）。所有作业停止后才删除。 |

返回结果包含每个删除路径的 `files` 和 `bytes`，以及合计的 `totalFiles`、`totalBytes`。删除整个项目时，服务先把项目目录移入工作区的暂存目录，后续工具调用、上传和 `/artifacts` 下载会立即找不到项目，随后才清除文件。删除是永久的。系统临时目录中的共享媒体缓存 `hyperframes-extract-cache-<uid>` 会保留，供其他项目使用。

## 通过 HTTP 传输二进制文件

MCP 工具通过 `project_write_file` 和 `project_read_file` 处理 UTF-8 文本。图片、音频、视频和字体通过与 `/mcp` 并列的 HTTP 路由传输，二进制数据无需进入模型上下文。先调用 `hyperframes_init` 创建项目，再使用相对项目目录的路径，并对路径的每一段分别做百分号编码。

| 路由 | 用途 |
| --- | --- |
| `PUT /files/<project>/<path>` | 上传单个文件，请求体为原始字节。服务会创建父目录。新建返回 `201`，覆盖返回 `200`，响应包含 `{ path, size, sha256, url }`。 |
| `POST /archives/<project>[/<dir>]` | 上传 `tar` 或 gzip 压缩的 `tar.gz`，解包到项目或指定的 `<dir>`。返回各文件的 `size`、`sha256` 和 `url`。 |
| `GET` / `HEAD /artifacts/<project>/<file>` | 下载文件，支持单个 `Range` 请求（`206` / `416`）、`ETag` / `If-Range` 和 UTF-8 文件名。 |

上传时可设置 `X-Content-SHA256: <hex>`，校验失败返回 `422`。设置 `If-None-Match: *` 可阻止覆盖已有文件（`412`）。上传超限返回 `413`，项目不存在返回 `404`，方法错误返回 `405`。错误响应格式为 JSON `{ "error": ... }`。服务先将上传内容写入临时文件，成功后再重命名到目标位置，失败时不会留下不完整的目标文件。

服务用随包安装的 npm `tar` 读取归档，因此 Linux 和 macOS 行为一致，无需系统 `tar`。归档在解包前后都会经过检查。只接受普通文件和目录。遇到软链接、硬链接、设备文件、绝对路径或带 `..` 的路径，会拒绝整个归档（`400`），项目中不会写入文件。解包后的总大小和条目数会在写入前根据归档头检查，超限返回 `413`。

```bash
BASE=http://<host>:9006
curl -T logo.png "$BASE/files/demo/assets/logo.png"
curl -H "X-Content-SHA256: $(sha256sum voice.wav | cut -d' ' -f1)" -T voice.wav "$BASE/files/demo/assets/voice.wav"
tar -czf assets.tgz -C ./assets . && curl --data-binary @assets.tgz "$BASE/archives/demo/assets"
curl -C - -o out.mp4 "$BASE/artifacts/demo/renders/out.mp4"   # 断点续传
```

## 渲染作业

MCP 客户端一次工具调用通常在约一分钟后超时。渲染可能需要更久，因此以后台作业运行。

1. `hyperframes_render` 校验参数并将作业加入队列，立即返回 `jobId` 和 `status`。无效参数会立即报错。
2. `hyperframes_render_status { jobId, waitSeconds?, logLines? }` 返回作业状态。`queued` 附带 `queuePosition`。`running` 返回从 CLI 的 `@hf-progress` 日志读取的 `progress`，有预计剩余时间时也会返回 `etaSeconds`。`succeeded` 返回 CLI 的 `output` 和 `artifacts`。`failed` 返回 `error` 和较长的 `logTail`。已取消时返回 `cancelled`。`waitSeconds` 可取 0 至 30，调用会等到作业结束或时间耗尽。请将等待时长设在客户端的工具调用超时以内。
3. `hyperframes_render_cancel { jobId }` 可取消排队或运行中的作业。运行中的作业会收到发给整个进程组的 SIGTERM，10 秒后仍未退出则发送 SIGKILL。
4. `hyperframes_render_list { project? }` 列出作业。

`hyperframes_render` 只有 `project` 必填，其余参数均可选，分别对应同名 CLI 选项。

| 类别 | 参数 |
| --- | --- |
| 输出 | `output`、`composition`、`format`（`mp4`、`mov`、`webm`、`gif`、`png-sequence`、`hls`）、`resolution`、`fps`（1 至 240，可用整数或 `"30000/1001"` 这样的分数）、`start` / `end`（秒） |
| 质量 | `quality`（`draft`、`standard`、`high`、`looks`、`delivery`）、`crf`（0 至 51）或 `videoBitrate`、`maxBitrate`、`bufferSize`、`keyframeInterval`、`proresProfile`（`proxy`、`lt`、`422`、`hq`、`4444`）、`hdr` 或 `sdr`、`motionBlur: "off"`、`videoFrameFormat`（`auto`、`jpg`、`png`）、`gifLoop`、`hlsSegmentSeconds`（1 至 60） |
| 性能 | `workers`（1 至 32 或 `"auto"`）、`gpu`、`browserGpu`、`docker`、`lowMemoryMode`、`framesCacheDir`（相对项目的路径，或 `off` / `none` / `false` / `0`） |
| 变量与批处理 | `variables`（对象，以 JSON 传入）、`strictVariables`、`batch`、`batchConcurrency`（1 至 10）、`batchFailFast` |
| 诊断 | `strict`、`strictAll`、`bestEffort`、`debug`、`json` |
| 作业 | `waitSeconds`（0 至 30） |

`output`、`composition`、`batch` 和 `framesCacheDir` 的路径必须位于项目内。作业成功时会列出生成的文件。指定了 `output` 就使用该文件或目录，否则列出作业开始后在 `renders/` 中修改的文件，最多 200 项，`truncated` 表示剩余项数。

提交 `hyperframes_render` 时也可传入 `waitSeconds`，耗时较短的作业可以在提交请求内完成。默认一次运行一个作业，可通过 `HF_MAX_CONCURRENT_RENDERS` 调整。作业状态存在内存中，只保留最近 200 个已结束的作业。服务重启会停止运行中的渲染并清除作业记录，已渲染的文件仍在项目中。使用 `hyperframes_cli` 执行 `command: "render"` 时仍为同步调用，受客户端超时限制。

在 HyperFrames 0.9.43 中，`start` / `end`（或 `hyperframes_cli` 的 `--start` / `--end`）会启用分段渲染。该模式自动选取工作线程数，每段约为帧数除以 30，忽略 `workers`。即使设置 `browserGpu: true`，WebGL 也会通过 SwiftShader 用软件渲染。选区跨过的每一段都会重启 Chrome。作业信息会有 `warnings`，`hyperframes_cli` 输出也会以 `WARNING:` 标记。测量渲染速度或 GPU 加速效果时，请使用完整合成。

声明为「数字或字符串」的数值参数（`workers`、`fps`、`waitSeconds`、`logLines`）也接受 `"4"` 这样的数字字符串，以兼容部分客户端。

## 验证

```bash
npm run check
npm run smoke
```

冒烟测试会在本机回环地址上启动独立服务，发起实际的 HTTP MCP 调用。覆盖项目创建、静态检查和综合检查、截图、时间线、MP4 和 HLS 渲染作业（提交、查询、取消、列表）、FFmpeg 完整解码、产物下载、二进制上传、归档上传、Range 请求、软链接越界检查、本地音频分析、转写文件导入、合成指南和错误处理。指南按原文返回，`contract` 示例项目须通过静态和综合检查，且截图中须能看到挂载的场景。

媒体和报告保存在 `workspace/verification/`。测试需要安装 Chrome 和 FFmpeg，测试过程中无需下载语音识别或语音合成模型。

升级范围和限制见[版本对比与验证记录](docs/hyperframes-upgrade.md)。

## Render.com 存储限制

Render 默认使用临时文件系统。运行期间创建的项目可能随实例替换或重新部署而丢失。生产环境可以给项目素材和渲染产物配置持久化磁盘或对象存储。

## 安全

服务面向可信的局域网客户端。服务本身没有身份验证，任何能够访问服务的客户端都可以向任意项目上传文件，或从中下载文件。MCP 工具和 HTTP 路由都会解析软链接，并将文件路径限制在项目目录内。高级 CLI 接受原始命令参数，其进程拥有服务账号的文件访问权限。如果需要公开部署，请先为 MCP 端点配置访问保护。请勿把私密媒体、凭据或密钥放进项目文件。

## HyperFrames

HyperFrames 是基于 HTML 的视频框架和命令行工具。服务器使用已安装的 HyperFrames npm 包及其 CLI 运行渲染。

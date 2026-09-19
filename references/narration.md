# 本地讲稿试听

文件预览页可能无法跨域连接本地服务；编辑弹窗提供「打开本地编辑窗口」作为同源备用入口，携带当前草稿继续编辑。请求立即显示提交状态，并设连接超时；不能只显示 Failed to fetch。后台只允许 null 文件来源与该服务的精确 loopback 来源，仍校验令牌。本地窗口成功保存后提示刷新预览，不能声称文件页面已自动同步。页面来源连接故障不应丢弃草稿。

讲稿需保留持续编辑入口。`assets/notes-editor.js` 与本地 `/notes` 接口允许用户自由补充完整讲稿，明确确认后调用 Codex 优化口头表达并保存。`scripts/notes-editor.py` 保留事实、限定条件和新增信息，不为时长删减要点；保留原稿、用户草稿与优化结果。未确认草稿按页面保留；优化失败或源稿冲突不覆盖。成功更新 slides.notes 后复用语音监听自动生成缓存，前端同步最新文案。

用户要求自然男声演讲试听时，使用开源 Qwen3-TTS 的 1.7B CustomVoice 模型作为本地方案。项目为 https://github.com/QwenLM/Qwen3-TTS ，官方模型为 `Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice`，可从官方 Hugging Face 或 ModelScope 仓库下载。保留许可证与来源；模型放在独立运行时目录，不提交进 skill 仓库。当前用户偏好是自然年轻男声、日常讲述语气，不要老成低沉、明显京腔或刻意播音腔。用户已授权直接选择普通音色，当前使用 `Aiden` 配合中文与标准普通话指令；不要重新启用已被否定的 `Dylan`。自然度与口音须以实际试听为准，不承诺与真人无异。

使用独立 Python 环境，按官方依赖安装 qwen-tts 与支持本机 GPU 的 PyTorch；不要改变其他应用的 Python 环境。生成期间讲稿仅在本机处理。权重下载不是上传讲稿。

涉及 PyTorch 的依赖安装串行执行，避免 CPU/CUDA 版本文件混装。安装完成后确认 `torch.cuda.is_available()` 并实际生成短音频；Windows 可使用 `attn_implementation='sdpa'`，不强制安装 FlashAttention。

## 已提供的生成与接入工具

`scripts/generate-narration.py --html <index.html> --model <本地模型目录>` 从该 Deck 的 `const slides` JSON 数据提取 notes，按页生成音频与 `narration/manifest.json`、`manifest.js`。`--pages 1,2` 用于先试音，`--plan` 查看文本与停顿拆分。默认按相近文本长度分批推理，显存不足可用 `--batch-size 1`；已完成段落会缓存以便中断后继续。页面适配限定为当前 SVG 查看器数据结构，其他项目先编写对应数据适配，不能盲目运行。

`node scripts/install-narration.mjs <index.html>` 将 `assets/narration/` 播放资源同步进实际页面并接入播放器。它要求 slides、show(i)、index、current-title 与 notes-content 接口；读取实际源码确认兼容后执行。播放器读取本地脚本清单和相对路径 WAV，可供 file URL 离线播放，不依赖在线 TTS 或浏览器系统声音。

## 节奏与一致性

- 用语义完整句子、正常语速合成；保留段间停顿，将明确的“停两秒”等舞台指令转成静音，移除 Markdown 加粗与“结束”等非朗读提示。不要改写用户讲稿来适应预算时间。
- 音频实际时长是试听依据，预算仅用于对比；不得强行倍速到预算值。默认 1×，可手动调速，保持音调。
- 支持播放/暂停、重播、进度跳转与播放时间。播放器不显示本页时长、预算、余量等额外统计行。连续播放是显式选项，等音频结束后才翻页；用户主动翻页时停止上一页音频，避免叠音。
- 当前 SVG 预览布局中，「播放讲稿」放在画面下方操作栏、左侧「总览」提示右边；右侧仍为页码、翻页和复制 SVG。主栏只显示播放/暂停、细进度条、时间和播放设置图标；重播、语速与连续播放收进向上展开的设置浮层，支持再次点击、点击外部、焦点离开与 Escape 关闭。仅生成中、音频不可用或出错时在播放器下方显示必要状态，正常播放时不显示额外文字，也不预留空白。统一按钮尺寸与图标，弱化辅助操作边框；备注区域只保留讲稿标题与可滚动正文。窄屏播放器独立成行，隐藏快捷键提示时播放按钮仍应可见。
- 音频与原始 notes 做一致性检查。修改讲稿后重新生成受影响页，不能播放旧稿冒充最新；缓存键包含文稿、声线与风格配置。新音频生成完成后再更新清单。
- 备注控件不能随文案长度挤压画布；正文独立滚动，键盘操作控件时不误翻页。演示视频与讲稿不能同时出声。
- 更新后同步工作区 skill、本地安装副本和实际预览资源。静态页面需刷新才会读取新的清单及脚本。

## 保存后自动生成本地缓存

用户要求修改讲稿后自动生成时，运行 `scripts/watch-narration.py --config <本地配置.json>`。配置包含 `html`（真实入口绝对路径）、`model`（本地模型路径）、`speaker`、`style`、`batchSize`、`debounceSeconds`。使用生成脚本同一个独立 Python 环境。每个文档仅运行一个 watcher；设置后台启动并确认实际进程存在，需要跨重启持续生效时提供当前用户登录启动入口，避免重复进程。

首次启动以当前稿为基线，不擅自把尚待用户确认的声线批量应用到旧稿；之后每次保存都比较逐页文稿与声线配置，只生成受影响页。连续保存先防抖，单队列串行生成；中途再次修改后，旧稿结果不能发布为新稿音频。待处理任务写入 `narration/watch-state.json`，重启后继续。自动失败重试最多两次，之后明确显示错误并保留 `build.log`，不要无限重试。

若用户明确否定当前声线且新声线尚未确定，配置 `voiceReady:false`：仍记录改稿任务，暂不生成被否定的声音。确定声线后更新 speaker/style 并设置 `voiceReady:true`，自动处理队列。普通已确定声线的任务不需增加此确认步骤。

播放器通过 `narration/live.js` 读取任务状态及最新缓存清单，可在 file URL 下加载。生成中禁用旧音频；缓存就绪后自动启用播放。同一音频未变化时不能因轮询打断播放。若打开的页面仍是旧讲稿，提示刷新读取最新内容，不能把新语音配到旧文案上。

## Apple Silicon Mac 本地生成

`generate-narration.py` 支持配置 `backend: "mlx"`，通过 `mlx-audio` 在 Apple GPU 上运行 Qwen3-TTS CustomVoice，继续使用 `Aiden` 和原讲稿风格。Windows 默认 `cuda` 路径保持不变。Mac 使用独立 Python 3.12 环境安装 `mlx-audio soundfile filelock`，模型下载到运行时目录，不放进项目仓库。依赖和模型来源为 PyPI `mlx-audio` 与 Hugging Face `mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit`。

复制 Windows 配置为 `narration-config.mac.local.json`，设置当前 Mac 的 `html`、`model` 路径，以及 `backend: "mlx"`、`batchSize: 1`、`stateFilename: "watch-state.mac.json"`。设置 `generateMissing: true` 时，监听器启动会排队生成无匹配讲稿音频的页面；已有匹配音频会保留。之后保存改稿继续防抖生成。用 `--pages 24.3` 可单独生成小数内部页号，不能误用界面显示的顺序页码。

先用该环境的 Python 执行 `scripts/generate-narration.py --html <index.html> --model <模型目录> --config <Mac配置> --pages <内部页号>` 验证真实音频，再启动 `scripts/watch-narration.py --config <Mac配置>`。需登录自动恢复时，以用户 LaunchAgent 运行监听器；不要同时运行第二个监听器。主观声音效果与 Windows 可能略有差异，需实际试听。

## 生成验收

### 逐字定位

Mac 使用 `scripts/align-narration.py --config <Mac配置> --watch` 对现有音频持续补齐时间点。配置 `alignmentModel` 为本地 `mlx-community/Qwen3-ForcedAligner-0.6B-8bit` 模型目录；时间数据写入 `narration/alignment.json` 和 `alignment.js`，以音频文件名及完整 notes 校验，不修改音频。生成服务与对齐服务各自有单实例锁；可用 `--pages <内部页号>` 单页验收。原稿中的加粗、标点、舞台停顿必须保留显示，但不错误映射成发音字符。

网页在 player.js 之前加载 alignment.js 和 `assets/narration/characters.js` 的运行副本。中文按对齐模型的字级时间定位；英文与数字按词内细分、极短字共享边界在相邻发音区间内细分，不能宣称逐音素精确。没有对齐数据时不伪造均匀时间点。当前字 opacity 为 1，其余字为 .4，RAF 跟随 audio.currentTime；滚动仅调整讲稿容器，单字点击从该字的 start 播放，空格仍用于暂停或继续。`node scripts/test-narration-characters.mjs` 验证字级点击、粗体、静音区间、标点及滚动。

先生成短页和长页，再生成全部。检查自然度、漏字/重复、英文缩写、长句及停顿；至少核对首尾和总时长，检查音频有效且没有削波。验证暂停/续播、翻页中止、连续翻页、拖动进度、文稿过期与文件缺失提示。不能将波形有效或脚本检查通过等同于主观听感已验收。

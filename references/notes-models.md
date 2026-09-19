# 讲稿整理模型

“编辑讲稿”的“整理模型”可选本地千问或 Codex，选择保存在浏览器本地。
本地千问只读取本机文本模型，不联网下载权重，不会在失败时转发到 Codex。
Qwen3-TTS 和 ForcedAligner 是语音模型，不能代替讲稿文本模型。

本地文本运行时使用独立 Python 环境安装 `mlx-lm`，避免改变语音生成环境。
默认路径：

- Python：`~/Library/Application Support/PPTedit/notes-venv/bin/python`
- 模型：`~/Library/Application Support/PPTedit/models/Qwen3-4B-4bit`

也可以在本地 layout bridge 配置中设置 `notesPython`、`notesModel` 为已安装的绝对路径，设置 `notesProvider` 为 `qwen` 或 `codex` 控制旧客户端默认值。浏览器只提交 provider 枚举，不接收运行命令和路径。

安装后重启 layout bridge，打开“编辑讲稿”会重新检查模型。语音仍由原有监听服务更新。
模型调用在隔离进程中运行，600 秒超时；本地文本请求串行执行。返回格式、旧稿冲突检查和原始请求备份在两种模型下保持一致。

验证：`python3 scripts/test-notes-provider.py`、`node scripts/test-notes-editor.mjs`。
真实模型验收应使用临时 HTML，确认改写结果再检查生产入口；不要为验证覆盖用户讲稿。

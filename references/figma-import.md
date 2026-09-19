# Figma 原稿导入

PPT 的 Figma 导入使用 `figma_mcp.py` 启动本机 Codex app-server，并直接调用原生 MCP 工具，不再启动模型回合来发现工具或拼接 SVG。Figma 服务地址只在该进程中显式配置，复用 Codex 的 OAuth 客户端，不复制凭证，也不修改用户全局配置。MCP 配置方式见 [OpenAI 官方说明](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)。

启动后先查询后台实际工具清单。缺少 `use_figma` 或 `get_screenshot` 时明确失败，保留页面；不能以技能文档存在、桌面端有工具或 `/health` 成功代替连接验收。`/health` 的 `figmaTransport` 只标识当前实现版本。

`figma-export.js` 只读指定文件和节点，加载每一种实际字体后调用原生 `exportAsync`。每块 8000 字符，最多并发 4 个只读调用，每块核对文件、节点、总块数、长度及 FNV-1a 哈希；拼接后再次验证完整内容。不能将大 SVG 直接作为工具文本返回：服务会截断超过 20 KB 的文本。

截图同时支持内嵌 PNG 和 Figma 原生临时资源 URL。下载只接受 HTTPS Figma MCP 资源地址，限制大小、超时，并验证 PNG 内容。临时 URL 不应显示在界面或交付文案中。

任何读取、字体、校验或截图失败均不覆盖页面。完整读取后由 `layout-bridge.py` 核对画布尺寸和保存前的源文件版本，再原子替换；任务目录保留 before/after、截图和原生工具记录。网络和授权失效仍可能发生，应按明确错误恢复连接，不能把失败当作完成。

本地回归检查：

```sh
python3 scripts/test-figma-reference.py
python3 scripts/test-figma-mcp.py
python3 scripts/test-local-codex.py
```

部署需包含 `figma_reference.py`、`figma_mcp.py`、`figma-export.js` 和已更新的 `layout-bridge.py`，并重启既有后台服务。实际验收必须提交具体节点任务、检查完成状态和目标 SVG，再刷新 PPT 核对同一页。

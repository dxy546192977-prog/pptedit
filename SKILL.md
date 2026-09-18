---
name: h5-editor
description: 创建、修改、调试和验收 H5、HTML 单页、落地页与网页 Deck。当任务需要修改真实网页源码并在浏览器中验证时使用；不适用于没有 HTML 运行时的原生演示文件。
---

# H5 / HTML 编辑与验收

把目标页面当作可运行的网页产品处理：先找到真实入口和源码，再进行小范围修改，最后验证实际浏览器结果。

## 工作流

### 1. 定位真实页面

- 读取项目约定、启动脚本和相关 README。
- 使用 `rg --files` 和 `rg` 查找页面入口、路由、样式、脚本与资源。
- 判断目标是静态页面、组件页面、响应式单页还是横向 Deck。
- 如果有多个候选入口，根据用户给出的路由、截图、文件或近期改动缩小范围。

### 2. 建立基线

修改前确认：

- 实际启动方式和正在服务的入口；
- Git 状态与用户已有改动；
- 布局、字体、色彩、间距、动效和资源路径；
- 固定画布、缩放容器、运行时数据和响应式断点。

优先修改源文件，不直接编辑 `.next/`、`dist/`、`out/` 等生成目录。

### 3. 实施修改

- 保持现有技术栈、组件边界和与任务无关的内容。
- 文案或局部样式任务只做对应修改，不顺带重写整页。
- 响应式页面同时考虑窄屏、平板和桌面端，不把整个页面简单缩小作为唯一方案。
- Deck 保留画布尺寸、页码、翻页键盘操作和原有导出能力。
- 动效页面保留 `prefers-reduced-motion` 或等价的低动效路径。
- 使用 `apply_patch` 编辑文件，避免覆盖用户的无关改动。

### 4. 验证实际结果

按风险选择并执行：

1. 语法、类型、lint 或构建检查。
2. 启动或复用项目的本地服务。
3. 在浏览器中打开真实路由，检查关键交互、控制台和资源加载。
4. 覆盖目标设备与典型视口，检查溢出、遮挡、截断和不可点击区域。
5. 如果页面支持保存，刷新后再确认结果。

不要把“文件已修改”当作页面已验收。如果环境阻止浏览器检查，明确说明已验证和未验证的边界。

## 可视化编辑器

### 编辑 PPT 的默认入口

用户说「编辑 PPT」「把项目加载编辑器」「提取 SVG 到 Figma」时，默认使用已确认的**完整 PPTedit 工作台**：左侧章节目录与缩略图／大纲、顶部工具栏、中央画布、讲述备注和「预览／编辑」切换。先读取 [references/ppt-workspace-default.md](references/ppt-workspace-default.md)，定位并打开目标项目的完整工作台。仅打开 HTML 的 `?edit=1`，或只更新 `assets/h5-editor/` 内核与配色，不算完成此请求。普通 H5 局部编辑及用户明确指定其他入口时仍按其要求执行。

### 网页 Deck 的编辑 / SVG 预览双模式

网页 Deck 默认采用上述完整工作台，SVG 预览与编辑共享当前文档源，并提供明确的双向切换入口。已有旧版编辑能力可保留兼容，但不再作为「编辑 PPT」的默认交付入口。具体状态同步与验收要求见 [references/deck-modes.md](references/deck-modes.md)；创建或调整这类双模式 Deck 时读取。此约定不要求普通 H5 或原生 PPTX 增加 SVG 预览。

只有在项目已接入浏览器编辑器，或用户明确要求可视化编辑时，才读取 [references/visual-editor-adapter.md](references/visual-editor-adapter.md)。

本 Skill 的可复用编辑器资源位于 `assets/h5-editor/`。接入具有 `public/` 目录的宿主项目时，先查看差异，再显式安装：

```bash
node scripts/install-h5-editor.mjs --target <project-root> --check
node scripts/install-h5-editor.mjs --target <project-root> --apply
```

优先使用 `{page-url}?edit=1`，避免改变相对资源的解析基准。Next.js 中显式 `.html` 页面可使用安装器提供的 `{page-url}/edit` 临时跳转入口；目录型页面需由宿主为具体路径添加 redirect。写盘是宿主选配能力，必须只在本地开发环境中开放受限路径。

## 讲稿语音试听

用户要求用自然人声试听网页 Deck 讲稿、检查演讲节奏时，读取 [references/narration.md](references/narration.md)，使用本地开源模型生成音频，并将播放控件接入实际预览页。

## 参考版式修改

用户要求上传参考图后由 Codex 修改当前页时，读取 [references/layout-reference.md](references/layout-reference.md)，接入本地后台与当前 SVG 源文件。

讲稿改写和参考版式默认接入本机 Codex。运行 `node scripts/install-layout-reference.mjs <index.html>` 自动检测已安装 CLI、复用登录、生成本地配置并启动后台，无需手填 CLI 绝对路径或 API Key。HTTP 预览须传入配置路径及 `--origin <预览站点源地址>`。重启电脑后用 `python3 scripts/setup-local-codex.py --html <index.html> --config <配置文件> --start` 恢复服务。前提是本机安装且登录 Codex、Python 可导入 Pillow；安装缺失条件必须明确报告。接入验收应真实调用本地 Codex，不能只以模拟响应或 health 成功代替。

## 完成标准

当用户要求 skill 与当前预览联动更新时，将同一轮反馈同时落实到实际预览页面的源码与 skill 的可复用规则；若涉及本 skill 提供的运行时资源，也同步相应资源。同步工作区 skill 与本地已安装副本。只有文档修改不能算完成页面更新，只有页面补丁也不能算完成 skill 更新。确认实际入口及生成关系，避免覆盖文稿内容或修改归档版本；能访问浏览器时刷新并验收，否则明确说明文件已更新、当前标签页仍需刷新。此约定是执行工作流，不代表静态页面或 skill 本身具备自动热更新能力。

- 修改了真实源文件，并保留用户已有改动。
- 目标视口和关键交互正常。
- 相关检查通过，且没有新增明显的控制台或资源错误。
- 最终说明修改位置、验证结果和仍存在的限制。

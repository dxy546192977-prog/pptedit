# PPTedit / H5 Editor

PPTedit 是一个面向 AI 编程 Agent 的 H5 / HTML 编辑 Skill，并提供可嵌入现有网页的浏览器可视化编辑器。它用于在真实源码上完成定位、修改、响应式检查和浏览器验收。

## 演示

![PPTedit：从普通 HTML 页面进入可视化编辑模式](demo/media/pptedit-demo.gif)

[观看高清 MP4](demo/media/pptedit-demo.mp4)

## 适用场景

- 活动页、落地页、响应式单页和移动端 H5
- 基于 HTML 的演示文稿与横向 Deck
- 静态 HTML / CSS / JavaScript；React、Next.js、Vue 等工程可使用 Agent 源码工作流
- 需要在浏览器中改字、移动元素、调整布局或导出 PNG / SVG 的页面

## 安装与使用

在支持 Agent Skills 的环境中加载本目录，然后通过 `$h5-editor` 发起页面修改或验收任务。

将浏览器编辑器接入现有项目：

```bash
# 先预览变更
node scripts/install-h5-editor.mjs --target /path/to/project --check

# 确认后安装或更新
node scripts/install-h5-editor.mjs --target /path/to/project --apply
```

在目标页面的 `</body>` 前加入：

```html
<script src="/h5-editor/bootstrap.js"></script>
```

编辑器会从 `bootstrap.js` 的实际地址推导其余资源，因此可部署在站点子路径。保存 API 不在站点根目录时，可额外设置 `data-h5ve-save-endpoint="/your-base/api/h5-editor/save/"`；该地址必须与页面同源。

浏览器可视化写回面向宿主明确映射的 HTML 文档，不会把运行时 DOM 反向转换成 JSX 或 Vue SFC；框架组件应由 Agent 直接修改源文件后再做浏览器验收。

直接访问 `{page-url}?edit=1` 对相对 CSS、脚本和图片路径最稳妥。Next.js 项目中的显式 `.html` 页面还会获得 `{page-url}/edit` 临时跳转入口，浏览器最终落到同一查询参数地址；目录型页面需由宿主为确定路由单独添加 redirect，避免拦截 `/profile/edit` 等应用页。`output: "export"` 的静态导出项目不会注入自定义路由，请直接使用查询参数。详细约定见 [visual-editor-adapter.md](references/visual-editor-adapter.md)。

## 本地演示

```bash
node demo/server.mjs
```

访问 `http://127.0.0.1:4173/demo/` 查看预览，或打开 `http://127.0.0.1:4173/demo/edit` 体验编辑模式。示例服务仅在当前会话中模拟保存，不会改写仓库文件。

## 验证与边界

```bash
npm run check
npm test
```

- 安装器只同步前端资源和显式 `.html/edit` 临时跳转配置。
- 写盘需要宿主自行实现受限的 `/api/h5-editor/save/` 接口；也可使用只读或下载回退模式。
- 复杂滤镜、伪元素、网页动效和视频无法完全转换为可编辑矢量图层。

## License

[MIT](LICENSE)

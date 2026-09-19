# PPTedit

PPTedit（Skill 名：`h5-editor`）是一个面向 AI 编程 Agent 的 H5 / HTML 编辑 Skill。它可以帮助 Agent 定位真实页面源码、完成修改，并在浏览器中检查响应式布局和交互效果。

## 安装与引用

将仓库安装到 Codex 的 Skills 目录：

```bash
git clone https://github.com/dxy546192977-prog/pptedit.git ~/.codex/skills/h5-editor
```

重启 Codex 后，在提示词中通过 `$h5-editor` 引用：

```text
使用 $h5-editor 修改这个 H5 / HTML 页面，并在浏览器中验证结果。
```

## 更新已有电脑与演示稿

`git pull --ff-only` 只更新 Skill 仓库。已有演示稿中复制的运行资源还需同步：

```bash
node scripts/install-preview-workspace.mjs "/绝对路径/演示稿目录"
```

适用于已接入 `PPT_NARRATION_HOST` 的完整工作台：同步全部 assets，保留演示内容和本机服务配置。随后停止旧编辑服务，从最新仓库运行 `python3 scripts/serve-svg-editor.py --config <本机配置>`，并强制刷新浏览器缓存。其他电脑须使用自己的配置、路径和凭证。

更新前会把被替换的不同资源与原 index.html 备份到 `制作源/PPTedit资源备份/`。项目自定义的同名资源会被仓库版本覆盖；若需保留项目外观变体，请先核对差异。当前迁移边界见 [功能传递核查](references/runtime-handoff-audit.md)。

总览网格与左侧目录均支持拖动排序。保存需本地编辑服务；成功后同步顺序、章节树和页码，失败会显示原因。纯静态公开预览不能写回文件。

回归验证：`node scripts/test-overview-drag-browser.mjs`（需 Playwright 与 Chrome，可用 `PLAYWRIGHT_MODULE` 指定 Playwright 入口）。

## 演示

Figma 原稿读取的连接、校验与排障方式见 [Figma 导入说明](references/figma-import.md)。

![PPTedit 自动播放演示](demo/media/pptedit-demo.gif)

[观看高清 MP4](demo/media/pptedit-demo.mp4)

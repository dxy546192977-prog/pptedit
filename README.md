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

## 演示

![PPTedit 自动播放演示](demo/media/pptedit-demo.gif)

[观看高清 MP4](demo/media/pptedit-demo.mp4)

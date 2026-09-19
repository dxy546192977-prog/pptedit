# 功能传递核查

本次基线为已推送的 be2b9a6，以及当前述职演示稿的运行副本。Git 仓库干净只能证明该仓库修改已提交，不能证明其他项目里的实现已经回收。

## 已修复

- 总览网格：项目曾有 preview-grid-drag.js，但该文件不在仓库，检查的入口也没有安装调用。现在由 preview-navigation.js 安装 preview-overview-drag.js，复用侧栏的保存与状态同步链路。
- 整章拖动：回收 navigation-tree.js 和 preview-nav-drag.js 中对章节节点的移动支持，保留章节子页面。
- 资源分发：旧 install-preview-workspace.mjs 只复制四份资源，且安装时重新生成源 CSS、联网获取图标。现在离线复制全部 assets，更新已有引用版本，补上必需入口，备份被替换的不同文件。
- 浏览器回归覆盖完整安装后的真实网格拖动、跨章节移动、小数页号、刷新持久化、取消、失败和普通点击；逐文件校验全部安装资源与仓库一致。

## 仍有独立版本差异

- narration/player.js：项目有备注区播放控件、更多倍速以及同步讲稿逻辑，仓库仍是另一版本播放器。上次提交虽包含 characters.js 和对齐脚本，也不能据此认定逐字播放整条链路已经传递；此项尚未完成通用迁移。
- layout-reference/client.css：项目副本缺少仓库中已有的确认按钮交互样式修复。更新方向应从仓库到项目，不能盲目反向覆盖。

- preview-actions.js、preview-rail.css、preview-edit-mode.css：述职项目采用顶部统一工具栏及备注区播放器，仓库保留另一套工作台外观。不能声称两者界面完全一致。
- preview-workspace.css：项目含备注拖动手柄位置与 demo-action 隐藏规则，属于项目界面差异，未直接覆盖通用版本。
- preview-edit-mode.js：仓库已携带 editorMedia 元数据，项目副本缺少此项；因此不能把项目文件全量反向覆盖仓库。
- 本机 pptedit-config.js、模型路径、服务 token、生成的讲稿音频属于本机配置或演示内容，不应作为通用 Skill 上传。

其他电脑需同时更新仓库、演示稿 assets 和运行中的编辑服务，再刷新浏览器。此次自动化验证不代表已远程验收那台电脑，也不代表全部 Figma、模型、语音或部署集成均完成真实外部调用。

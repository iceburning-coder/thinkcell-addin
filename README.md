# think-cell 风格图表 · Office 加载项

在 PowerPoint 和 Excel 的「开始」选项卡加一个 **think-cell 图表** 按钮，打开侧边面板：
粘贴或读取数据 → 选图表类型和注释 → 实时预览 → 一键插入。

图表引擎与 Obsidian skill `thinkcell-charts` 是同一套代码（tccore），运行在面板里的 Python（Pyodide）中，
不需要安装 Python，也不依赖外部 CDN（运行环境已打包在 `pyodide/` 里）。

## 功能
| 在哪里 | 按钮 | 效果 |
|---|---|---|
| PowerPoint | 插入到当前页 | 插入矢量图；右键 →「转换为形状」可逐个编辑 |
| PowerPoint | 作为新幻灯片插入 | 在当前页后新增一页，图表已是原生可编辑形状 |
| Excel | 读取选区 | 把选中的单元格读进数据框 |
| Excel | 插入图表（高保真） | 带全部注释（CAGR、差异箭头…）的矢量图，放在选区右侧 |
| Excel | 插入 Excel 原生图表 | 随单元格数据自动更新（没有 think-cell 注释） |
| 浏览器 | 下载 SVG / PNG / PPTX | 直接打开 taskpane.html 也能用 |

支持 17 类图表：柱/条（堆积·簇状·100%·断轴·对数）、瀑布（e 小计、拆解、多段）、折线（高亮、右轴、轮廓）、面积、
组合、Pareto、蝴蝶/龙卷风、Mekko（百分比/单位）、饼/圆环、Pie-of-pie、同心环、散点/气泡四象限+趋势线、足球场、K 线、量规、甘特、Harvey ball 表格。
「高级：JSON 规格」可以直接写引擎的全部参数（与 skill 的报告 JSON 相同）。

## 兼容性与失败保护

- PowerPoint 的可编辑幻灯片插入需要 `PowerPointApi 1.2`：1.2–1.3 可插入可编辑形状，但不能可靠追踪并从面板重新载入；1.4 起才识别外层图表组并保存稳定引用。读取/更新所选形状需要 1.5。1.8 以上在点中组内文字、线条等子对象时会自动向上识别所属图表；1.5–1.7 需先按 Esc 或单击边框选中最外层组。更低版本仍可插入普通图片。
- Excel 的高保真图片图表、形状列表和文档扫描需要 `ExcelApi 1.9`；1.7–1.8 只保留单元格读取、原生图表及逐工作表变更监听，不再显示实际不可用的形状操作。再低的版本只能手动更新。
- SVG 插入失败会自动改用 PNG。PowerPoint/Excel 更新都采用“先插入并保存状态，最后删除旧图”的顺序；中途失败会保留旧图，提交后的清理失败则保留新旧两份并给出恢复提示。
- 所有 Office callback、`context.sync()` 与文档设置保存错误都会显示在面板中，不再静默忽略。

## 数据与安全边界

- 图表状态使用带版本号的结构，并在本地草稿、文档设置、剪贴板和高级 JSON 四个入口统一校验；未知未来版本只读打开，不能覆盖保存。
- 图表标题、标签、字体和颜色在进入 SVG 前会转义或校验；本地自定义主题也只接受有限数量的 `#RRGGBB` 颜色。预览还会再经过 SVG 元素/属性白名单。渲染失败后插入和下载按钮会保持禁用。
- 剪贴板整图载荷有大小、深度、字段和图表类型限制，并拒绝 `__proto__` 等原型污染字段。
- 加载项使用清单中的 `ReadWriteDocument`，用于插入/更新图形、读取 Excel 选区及把图表状态保存在当前 Office 文档内；当前实现不上传图表数据。

## 文档状态、迁移与恢复

- 新插入图表使用 v3 状态：每张图都有稳定 UUID，文档设置以 `TC:chart:<chartId>` 保存；PowerPoint 用形状标签、Excel 用替代文字保存非敏感身份标记。用户改形状名后仍可重新载入。
- v1/v2 与旧的“形状名作为设置键”记录仍可读取。旧记录只在一次图表操作完整成功后增量写成 v3，旧键保留，不会在后台自动删除。高于 v3 的未来版本只读打开。
- 更新和 1.4+ 的“插入可编辑幻灯片”均采用待处理标记；插入后会识别新增幻灯片和外层图表组，再保存稳定引用。若 Office 在保存、重命名、标记或删除阶段失败，原图优先保留；只有能用目标图表标记证明归属的新幻灯片才会清理，歧义对象不会自动删除，清理失败也会保留待恢复标记。
- 面板底部的“文档状态与恢复”可检查未完成操作、重复 ID、孤立状态、未跟踪形状和 Excel 断链。恢复动作必须逐项点击；复制的诊断信息默认只有版本、能力标志、数量和错误码，不包含图表标题或数据。

## Excel 数据链接

- 高保真图片图表用工作簿级定义名称 `TC_LINK_<UUID>` 跟踪数据区域，不再只记住 A1 地址。因此插入/删除行列、移动区域或重命名工作表后仍能解析当前位置。
- 工作表或定义名称被删除时，链接标记为断开，保留最后一次图片和数据。可在“文档状态与恢复”中选择新区域重新链接。
- 单元格变更按图表 ID 独立防抖并串行刷新。同一图表不会同时执行两个替换；面板写回单元格时，只忽略工作表、区域和数值哈希完全一致的一次事件，不会用固定时间窗吞掉紧随其后的用户编辑。
- Excel 图表形状引用使用工作表稳定 ID，不依赖可改名的工作表名称；旧名称型引用仍可按稳定 shape ID 迁移。若数据写回成功但图表替换失败，会清除内部回声并重新从单元格刷新，避免“数据新、图片旧”。
- 自动刷新只在任务窗格打开时运行；Excel 原生图表由 Excel 自身维护链接。跨 PowerPoint/Excel 的“复制图表”仍是状态快照，不是后台实时跨程序链接。

## 已知限制

- 当前没有 OneDrive/Graph 服务端，因此 PowerPoint 图片图表与另一个 Excel 文件之间不能在两个应用关闭后保持实时链接。若需要真正跨程序链接，建议下一阶段采用用户明确选择的云文件 + Microsoft Graph，并为离线、权限撤销和版本冲突提供状态；Custom Functions 不适合直接驱动 PowerPoint 形状更新。
- Pyodide 与 Python 图表引擎首次加载约 20 MB；浏览器缓存后会明显加快。PPTX 组件只在首次导出/插入可编辑幻灯片时懒加载。
- Office 桌面端支持程度取决于 requirement set。缺少形状检查能力时仍可插入图片，但不能承诺从面板重新载入、诊断或原位更新。

## 一次性部署（约 10 分钟）

### 1. 放到 GitHub Pages
1. 在 GitHub 新建一个**公开**仓库，比如 `thinkcell-addin`。
2. 把本文件夹里的**全部文件**上传到仓库根目录（网页上「Add file → Upload files」，可以直接拖整个文件夹里的内容；包含 `.nojekyll`）。
3. 仓库 Settings → Pages → Source 选 `Deploy from a branch`，分支 `main`、目录 `/ (root)`，保存。
4. 一两分钟后访问 `https://<你的用户名>.github.io/thinkcell-addin/taskpane.html`，能看到面板并出现预览就成功了。

### 2. 生成 manifest
```bash
python3 make_manifest.py https://<你的用户名>.github.io/thinkcell-addin
```

### 3. 安装到 Mac 的 PowerPoint / Excel
```bash
bash install_mac.sh
```
完全退出 PowerPoint 和 Excel 再打开，「开始」选项卡右侧会出现「咨询图表 → think-cell 图表」。
（若没出现：「插入 → 加载项 → 我的加载项」里能找到。）

Windows：把 manifest.xml 放到一个共享文件夹，在「信任中心 → 受信任的加载项目录」添加该文件夹即可。

## 更新
- skill 的图表引擎更新后：`python3 build_pylib.py`，再把 `py/pylib.zip` 重新上传到 GitHub。面板下次打开自动生效。
- 修改面板界面：改 `taskpane.html / .js / .css` 后上传。
- manifest 里的 ID 固定不变，更新不需要重新安装。

## 文件
```
taskpane.html/js/css   面板界面
py/addin_api.py        Python 桥接（render → SVG，render_pptx → 单页 PPTX）
py/pylib.zip           tccore 引擎 + python-pptx（由 build_pylib.py 生成）
pyodide/               浏览器里的 Python 运行环境（Pyodide 0.27.2 + lxml + Pillow）
assets/                图标
make_manifest.py       生成 manifest.xml
install_mac.sh         Mac 侧载安装
```

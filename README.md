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

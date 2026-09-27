"""把 skill 里最新的 tccore 引擎打包进插件：python build_pylib.py
（skill 的图表引擎更新后运行一次，再把 py/pylib.zip 上传到 GitHub 即可）"""
import os, pathlib, shutil, tempfile, zipfile, importlib.util

here = pathlib.Path(__file__).resolve().parent
tccore = here.parent / "scripts" / "tccore"
out = here / "py" / "pylib.zip"
tmp = pathlib.Path(tempfile.mkdtemp())
shutil.copytree(tccore, tmp / "tccore", ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
for mod in ("pptx", "xlsxwriter"):
    spec = importlib.util.find_spec(mod)
    if not spec:
        raise SystemExit(f"缺少 {mod}：pip install python-pptx XlsxWriter")
    shutil.copytree(pathlib.Path(spec.origin).parent, tmp / mod, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
shutil.copy(here / "py" / "addin_api.py", tmp / "addin_api.py")
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for p in tmp.rglob("*"):
        if p.is_file():
            z.write(p, p.relative_to(tmp))
shutil.rmtree(tmp)
print("已更新", out, f"{out.stat().st_size / 1e6:.1f} MB")

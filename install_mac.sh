#!/bin/bash
# 把插件注册到 Mac 上的 PowerPoint 和 Excel（侧载）。用法：bash install_mac.sh
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
for APP in Powerpoint Excel; do
  WEF="$HOME/Library/Containers/com.microsoft.$APP/Data/Documents/wef"
  mkdir -p "$WEF"
  cp "$DIR/manifest.xml" "$WEF/thinkcell-charts.manifest.xml"
  echo "已安装到 $APP：$WEF"
done
echo "请完全退出并重新打开 PowerPoint / Excel，在「开始」选项卡右侧找到「think-cell 图表」按钮。"

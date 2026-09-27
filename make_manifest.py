"""生成 Office 加载项 manifest：python make_manifest.py https://<用户名>.github.io/<仓库名>"""
import sys, uuid, pathlib

base = sys.argv[1].rstrip("/") if len(sys.argv) > 1 else "https://localhost:3000"
VER = sys.argv[2] if len(sys.argv) > 2 else "3"   # 改这个数字可强制 Office 重新加载面板（绕过缓存）
ID = "5c1f7b8e-3a2d-4c6e-9b0f-7d2e4a1c8b93"   # 固定 ID，更新 manifest 时保持不变
xml = f"""<?xml version="1.0" encoding="UTF-8"?>
<OfficeApp xmlns="http://schemas.microsoft.com/office/appforoffice/1.1"
           xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
           xmlns:bt="http://schemas.microsoft.com/office/officeappbasictypes/1.0"
           xmlns:ov="http://schemas.microsoft.com/office/taskpaneappversionoverrides"
           xsi:type="TaskPaneApp">
  <Id>{ID}</Id>
  <Version>1.0.{VER}.0</Version>
  <ProviderName>Xiaowu</ProviderName>
  <DefaultLocale>zh-CN</DefaultLocale>
  <DisplayName DefaultValue="think-cell 风格图表"/>
  <Description DefaultValue="咨询风格图表：瀑布、Mekko、CAGR/差异箭头等，一键插入 PPT 和 Excel"/>
  <IconUrl DefaultValue="{base}/assets/icon-32.png"/>
  <HighResolutionIconUrl DefaultValue="{base}/assets/icon-64.png"/>
  <SupportUrl DefaultValue="{base}/README.html"/>
  <AppDomains><AppDomain>{base}</AppDomain></AppDomains>
  <Hosts>
    <Host Name="Presentation"/>
    <Host Name="Workbook"/>
  </Hosts>
  <DefaultSettings>
    <SourceLocation DefaultValue="{base}/taskpane.html?v={VER}"/>
  </DefaultSettings>
  <Permissions>ReadWriteDocument</Permissions>
  <VersionOverrides xmlns="http://schemas.microsoft.com/office/taskpaneappversionoverrides" xsi:type="VersionOverridesV1_0">
    <Hosts>
{''.join(f'''      <Host xsi:type="{h}">
        <DesktopFormFactor>
          <GetStarted>
            <Title resid="Tc.Title"/>
            <Description resid="Tc.Desc"/>
            <LearnMoreUrl resid="Tc.Url"/>
          </GetStarted>
          <ExtensionPoint xsi:type="PrimaryCommandSurface">
            <OfficeTab id="TabHome">
              <Group id="Tc.Group.{h}">
                <Label resid="Tc.Group"/>
                <Icon>
                  <bt:Image size="16" resid="Tc.I16"/>
                  <bt:Image size="32" resid="Tc.I32"/>
                  <bt:Image size="80" resid="Tc.I80"/>
                </Icon>
                <Control xsi:type="Button" id="Tc.Btn.{h}">
                  <Label resid="Tc.Btn"/>
                  <Supertip><Title resid="Tc.Btn"/><Description resid="Tc.Desc"/></Supertip>
                  <Icon>
                    <bt:Image size="16" resid="Tc.I16"/>
                    <bt:Image size="32" resid="Tc.I32"/>
                    <bt:Image size="80" resid="Tc.I80"/>
                  </Icon>
                  <Action xsi:type="ShowTaskpane">
                    <TaskpaneId>TcPane</TaskpaneId>
                    <SourceLocation resid="Tc.Url"/>
                  </Action>
                </Control>
              </Group>
            </OfficeTab>
          </ExtensionPoint>
        </DesktopFormFactor>
      </Host>
''' for h in ("Presentation", "Workbook"))}    </Hosts>
    <Resources>
      <bt:Images>
        <bt:Image id="Tc.I16" DefaultValue="{base}/assets/icon-16.png"/>
        <bt:Image id="Tc.I32" DefaultValue="{base}/assets/icon-32.png"/>
        <bt:Image id="Tc.I80" DefaultValue="{base}/assets/icon-80.png"/>
      </bt:Images>
      <bt:Urls>
        <bt:Url id="Tc.Url" DefaultValue="{base}/taskpane.html?v={VER}"/>
      </bt:Urls>
      <bt:ShortStrings>
        <bt:String id="Tc.Title" DefaultValue="think-cell 风格图表"/>
        <bt:String id="Tc.Group" DefaultValue="咨询图表"/>
        <bt:String id="Tc.Btn" DefaultValue="think-cell 图表"/>
      </bt:ShortStrings>
      <bt:LongStrings>
        <bt:String id="Tc.Desc" DefaultValue="打开图表面板：粘贴或选中数据，生成瀑布、Mekko、CAGR 箭头等咨询风格图表并插入。"/>
      </bt:LongStrings>
    </Resources>
  </VersionOverrides>
</OfficeApp>
"""
out = pathlib.Path(__file__).with_name("manifest.xml")
out.write_text(xml, encoding="utf-8")
print("manifest.xml ->", base)

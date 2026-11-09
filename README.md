# 饭点 · Windows 桌面版

独立可运行的 Windows x64 应用，沿用饭团小厨与答案餐盘设计。界面由应用内的 WebView2 显示，清单、筛选和记录由桌面程序保存为独立文件；不需要打开浏览器、安装 Node.js 或运行本地服务器。

默认使用深色界面与 Logo 同款珊瑚橘按钮。内置上海宜山路光启城周边 31 家餐馆，也可以添加自己的清单。

[下载 Windows 安装版](https://github.com/Nealgu/Eat-what/raw/refs/heads/main/release/饭点-1.2.2-安装.exe) · [下载免安装 ZIP](https://github.com/Nealgu/Eat-what/raw/refs/heads/main/release/饭点-1.2.2-Windows-x64.zip) · [SHA-256 校验码](release/SHA256SUMS.txt)

[查看早期版本截图](docs/screenshot.png)

## 安装或直接运行

- 打开 `release/饭点-1.2.2-安装.exe` 安装，可创建桌面快捷方式和开始菜单入口，并提供卸载程序。
- 完整解压 `release/饭点-1.2.2-Windows-x64.zip` 后可直接打开 `饭点.exe`。请将 DLL 和 `web` 文件夹留在程序旁边。
- 从源码构建后可打开 `release/饭点-1.2.2-Windows-x64/饭点.exe`。

运行需要 Windows x64、.NET Framework 4.8 与 Microsoft Edge WebView2 Runtime。若缺少 WebView2，应用会显示微软官方安装入口。当前构建未做商业代码签名。

## 日常功能

- 按距离、人均预算和分类选餐；有多家可选时避开紧邻的上一个答案。
- 点击「就吃这家」保存选择记录，最多保留 365 条。按钮会变成「撤销选择」，可在当前结果卡上撤销这次确认。
- 搜索、新增、编辑、停用和删除餐馆；删除后可以撤销。
- 「导出完整备份」保存清单、筛选和记录；「恢复备份」先显示数量预览，再由用户确认替换。
- 可导入此应用完整备份，以及旧版本导出的餐馆 JSON 数组。
- 未填写的距离与预算显示「待补充」，仍可参与选餐。

## 附近搜店

在 Windows 应用中点「附近搜店」→「定位并搜索」，允许定位后即可联网查询当前位置附近的餐馆。无需注册地图账号或填写 Key。查询半径使用当前的距离筛选，最多返回 25 家，距离为直线距离。地图覆盖和地址完整度因地区而异，人均消费显示为「待补充」。点「回到我的清单」可使用本地餐馆。

饭点只在用户主动搜索时查询，将位置按约 1 公里网格取整后发送给 Private.coffee Overpass。精确位置用于本机距离计算。© OpenStreetMap 贡献者，地图数据按 ODbL 提供。 [数据许可](https://www.openstreetmap.org/copyright) · [查询服务与隐私条款](https://overpass.private.coffee/)

## 光启城周边清单

2026-11-06 根据公开门店资料新增 11 家，初始清单共 31 家，围绕上海宜山路 455 号光启城及附近道路。包含周真真南昌拌粉、柒月粉、德克士、成都你六姐、必胜客、韩宫宴、新石器、海底捞、小猫钓渝、留柱小馆和老爸厨房。

25 家内置餐馆已有可展示的地址，门店来源见 `places.js`，可在清单中按地址搜索并在抽选结果中查看。新增批次的完整来源、核验日期和资料局限见 `catalog-sources.json`。营业与价格以门店当日为准。

已有数据首次打开新版时只追加这批新店，按稳定 ID 或去除括号分店名后的名称去重；保留用户编辑、停用状态、筛选和历史。批次成功保存后不会重复添加，之后删除的新店也不会在重启时重新出现。主动恢复批次更新前的旧备份后，下次启动会再次补充本批新店；旧清单中删掉的其他店不会补回。

## 数据和恢复

默认数据目录：`%LOCALAPPDATA%\FoodTime`。在「餐馆清单」中点击「数据文件夹」可打开。

- `state.json`：当前数据。
- `state.previous.json`：上一次有效保存，用于恢复。
- `state.corrupt-*.json`：损坏的数据原件，保留以便排查。
- `WebView2`：应用显示组件的独立缓存。
- `application.log`：启动或文件操作失败时的诊断记录。

数据写入先写临时文件，再原子替换。保存失败会提示，界面不会冒充保存成功；主数据损坏时尝试读取上一份有效数据。升级和卸载程序均不删除此数据目录。重要清单仍建议定期手动导出备份。

## 开发和构建

开发需要 Node.js，项目没有 npm 第三方依赖。克隆仓库后可直接运行测试与预览：

```powershell
git clone https://github.com/Nealgu/Eat-what.git
cd Eat-what
node --test tests/core.test.cjs tests/state-codec.test.cjs tests/storage.test.cjs
node serve.cjs
```

浏览器预览地址为 `http://localhost:5180`；浏览器数据与桌面版分开。

在 Windows 上打包：

```powershell
powershell -NoProfile -File desktop/get-dependencies.ps1
node desktop/build-windows.cjs
```

Windows 构建使用系统 .NET Framework C# 编译器，不需要安装 Visual Studio 或 .NET SDK。依赖脚本下载固定版本 `Microsoft.Web.WebView2 1.0.4314.35`，SDK 缓存不纳入仓库。应用图标已随源代码提供，修改时可安装 Python 与 Pillow 并运行 `desktop/create-icon.py` 重新生成。

仓库包含源码、测试、实机截图和可下载的安装包。预览产物、依赖缓存、个人数据和本地验证目录均由 `.gitignore` 排除。

测试可通过 `饭点.exe --data-dir <绝对路径>` 使用隔离目录，避免影响日常数据。该参数仅由启动进程传入，网页界面不能指定任意文件路径。

`desktop/Program.cs` 是 Windows 宿主，`storage.js` 对接受限的本地读写和附近搜店接口，`state-codec.js` 负责备份校验。附近查询由 `desktop/NearbyService.cs` 连接 Overpass 服务。

SDK 来源与实现依据：[微软 WebView2 包](https://www.nuget.org/packages/Microsoft.Web.WebView2/1.0.4314.35)、[微软 WinForms 集成指南](https://learn.microsoft.com/microsoft-edge/webview2/get-started/winforms)。分发目录附有 WebView2 的许可文件。

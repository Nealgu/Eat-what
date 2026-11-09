const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const root = path.resolve(__dirname, '..');
const sdkVersion = '1.0.4314.35';
const sdk = path.join(root, '.deps', 'webview2-' + sdkVersion);
const release = path.join(root, 'release');
const portable = path.join(release, '饭点-Windows-x64');
const csc = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
if (!fs.existsSync(csc)) throw new Error('需要 Windows .NET Framework 4.x 编译器。');
if (!fs.existsSync(path.join(sdk, 'lib/net462/Microsoft.Web.WebView2.Core.dll'))) throw new Error('请先运行 desktop/get-dependencies.ps1 下载固定版本 SDK。');
if (!fs.existsSync(path.join(root, 'assets/app.ico'))) throw new Error('请先运行 desktop/create-icon.py 生成图标。');
function run(file, args, options = {}) {
  const result = cp.spawnSync(file, args, { cwd: root, stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(path.basename(file) + ' 执行失败：' + result.status);
}
run(process.execPath, ['build.cjs']);
fs.mkdirSync(portable, { recursive: true });
fs.cpSync(path.join(root, 'dist'), path.join(portable, 'web'), { recursive: true });
for (const file of ['Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll']) fs.copyFileSync(path.join(sdk, 'lib/net462', file), path.join(portable, file));
fs.copyFileSync(path.join(sdk, 'runtimes/win-x64/native/WebView2Loader.dll'), path.join(portable, 'WebView2Loader.dll'));
const sdkLicense = path.join(sdk, 'LICENSE.txt');
if (fs.existsSync(sdkLicense)) fs.copyFileSync(sdkLicense, path.join(portable, 'WebView2-LICENSE.txt'));
fs.copyFileSync(path.join(root, 'assets/app.ico'), path.join(portable, 'app.ico'));
const common = ['/nologo', '/codepage:65001', '/target:winexe', '/platform:x64', '/optimize+', '/win32manifest:' + path.join(__dirname, 'app.manifest'), '/win32icon:' + path.join(root, 'assets/app.ico')];
const standardReferences = ['System.dll', 'System.Core.dll', 'System.Drawing.dll', 'System.Windows.Forms.dll', 'System.Web.Extensions.dll'];
run(csc, [...common, '/out:' + path.join(portable, '饭点.exe'), ...standardReferences.map(name => '/reference:' + name),
  '/reference:' + path.join(portable, 'Microsoft.Web.WebView2.Core.dll'), '/reference:' + path.join(portable, 'Microsoft.Web.WebView2.WinForms.dll'), path.join(__dirname, 'Program.cs')]);
fs.writeFileSync(path.join(portable, '使用说明.txt'), '\ufeff饭点 1.0.0\r\n\r\n直接打开“饭点.exe”，无需启动服务器或安装 Node.js。\r\n请保留此文件夹中的 web 和 DLL 文件。\r\n\r\n清单、筛选和记录保存在 %LOCALAPPDATA%\\FoodTime。\r\n“备份数据”会导出完整 JSON，可通过“恢复备份”导回。\r\n应用会保留上一份有效数据，升级或卸载程序均不会删除个人数据。\r\n\r\n运行需要 Windows x64、.NET Framework 4.8 与 Microsoft Edge WebView2 Runtime。\r\n缺少 WebView2 时，应用会显示微软官方安装入口。\r\n', 'utf8');
fs.writeFileSync(path.join(release, 'build-info.json'), JSON.stringify({ version: '1.0.0', sdkVersion, builtAt: new Date().toISOString(), architecture: 'x64', signed: false }, null, 2));
if (fs.existsSync(path.join(__dirname, 'Uninstall.cs')) && fs.existsSync(path.join(__dirname, 'Installer.cs'))) {
  run(csc, [...common, '/out:' + path.join(portable, '卸载饭点.exe'), ...standardReferences.map(name => '/reference:' + name), path.join(__dirname, 'Uninstall.cs')]);
  function fileList(directory, prefix = '') {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? fileList(path.join(directory, entry.name), prefix + entry.name + '/') : [prefix + entry.name]);
  }
  fs.writeFileSync(path.join(portable, 'install-files.json'), JSON.stringify([...new Set([...fileList(portable), 'install-files.json'])], null, 2));
  const zipPath = path.join(release, '饭点-1.0.0-Windows-x64.zip');
  const ps = "Add-Type -AssemblyName System.IO.Compression.FileSystem\nif (Test-Path -LiteralPath $env:FOODTIME_ZIP) { Remove-Item -LiteralPath $env:FOODTIME_ZIP }\n[System.IO.Compression.ZipFile]::CreateFromDirectory($env:FOODTIME_PORTABLE, $env:FOODTIME_ZIP)";
  run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { env: { ...process.env, FOODTIME_PORTABLE: portable, FOODTIME_ZIP: zipPath } });
  run(csc, [...common, '/out:' + path.join(release, '饭点-1.0.0-安装.exe'), ...standardReferences.map(name => '/reference:' + name), '/reference:System.IO.Compression.dll', '/reference:System.IO.Compression.FileSystem.dll', '/reference:Microsoft.CSharp.dll', '/resource:' + zipPath + ',FoodTime.Payload.zip', path.join(__dirname, 'Installer.cs')]);
}
console.log('Windows 应用已生成：' + path.join(portable, '饭点.exe'));

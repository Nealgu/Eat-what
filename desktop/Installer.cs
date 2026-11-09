using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Windows.Forms;
using Microsoft.Win32;

internal static class Installer
{
    private static readonly string InstallRoot = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "FoodTime");
    [STAThread]
    private static int Main(string[] args)
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        if (args.Length == 2 && args[0] == "--extract-only")
        {
            try {
                string target = Path.GetFullPath(args[1]);
                if (Directory.Exists(target) && Directory.GetFileSystemEntries(target).Length != 0) return 3;
                Extract(target);
                return File.Exists(Path.Combine(target, "饭点.exe")) ? 0 : 4;
            } catch { return 2; }
        }
        if (args.Length != 0) return 1;
        Form form = new Form();
        form.Text = "安装饭点";
        form.ClientSize = new Size(440, 300);
        form.FormBorderStyle = FormBorderStyle.FixedDialog;
        form.MaximizeBox = false;
        form.StartPosition = FormStartPosition.CenterScreen;
        form.BackColor = Color.FromArgb(248,248,243);
        form.Font = new Font("Microsoft YaHei UI", 9F);
        form.Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
        Label title = new Label { Text = "饭点", Font = new Font(form.Font.FontFamily, 25F, FontStyle.Bold), ForeColor = Color.FromArgb(53,72,61), Location = new Point(30,25), AutoSize = true };
        Label body = new Label { Text = "让饭团小厨，帮你选好这一顿。\r\n\r\n安装后可直接打开，清单和记录保存在这台电脑。\r\n不需要启动网页服务，也不需要 Node.js。", Location = new Point(32,91), Size = new Size(380,95), ForeColor = Color.FromArgb(104,121,91) };
        CheckBox shortcut = new CheckBox { Text = "创建桌面快捷方式", Checked = true, Location = new Point(32,200), AutoSize = true };
        Button install = new Button { Text = "安装并打开饭点", Location = new Point(230,241), Size = new Size(177,36), BackColor = Color.FromArgb(223,121,85), ForeColor = Color.White, FlatStyle = FlatStyle.Flat };
        install.FlatAppearance.BorderSize = 0;
        install.Click += delegate {
            install.Enabled = false;
            try {
                string appFolder = Path.Combine(InstallRoot,"app-1.0.0");
                Extract(appFolder);
                string appExe = Path.Combine(appFolder,"饭点.exe");
                string menu = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs),"FoodTime");
                Directory.CreateDirectory(menu);
                CreateShortcut(Path.Combine(menu,"饭点.lnk"),appExe,appFolder);
                CreateShortcut(Path.Combine(menu,"卸载饭点.lnk"),Path.Combine(appFolder,"卸载饭点.exe"),appFolder);
                if (shortcut.Checked) CreateShortcut(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory),"饭点.lnk"),appExe,appFolder);
                using (RegistryKey key = Registry.CurrentUser.CreateSubKey(@"Software\Microsoft\Windows\CurrentVersion\Uninstall\FoodTime")) {
                    key.SetValue("DisplayName","饭点"); key.SetValue("DisplayVersion","1.0.0"); key.SetValue("Publisher","FoodTime");
                    key.SetValue("InstallLocation",InstallRoot); key.SetValue("DisplayIcon",appExe + ",0");
                    key.SetValue("UninstallString","\"" + Path.Combine(appFolder,"卸载饭点.exe") + "\"");
                    key.SetValue("NoModify",1,RegistryValueKind.DWord); key.SetValue("NoRepair",1,RegistryValueKind.DWord);
                }
                Process.Start(new ProcessStartInfo(appExe) { WorkingDirectory = appFolder, UseShellExecute = true });
                form.Close();
            } catch (Exception error) {
                MessageBox.Show("安装没有完成。请先关闭已打开的饭点，再重试。\r\n\r\n" + error.Message,"安装饭点",MessageBoxButtons.OK,MessageBoxIcon.Warning);
                install.Enabled = true;
            }
        };
        form.Controls.AddRange(new Control[] {title,body,shortcut,install});
        Application.Run(form);
        return 0;
    }
    private static void Extract(string target)
    {
        Directory.CreateDirectory(target);
        string prefix = Path.GetFullPath(target).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        using (Stream payload = Assembly.GetExecutingAssembly().GetManifestResourceStream("FoodTime.Payload.zip"))
        using (ZipArchive zip = new ZipArchive(payload,ZipArchiveMode.Read)) {
            foreach (ZipArchiveEntry entry in zip.Entries) {
                string path = Path.GetFullPath(Path.Combine(target,entry.FullName));
                if (!path.StartsWith(prefix,StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("安装包中的路径无效。");
                if (String.IsNullOrEmpty(entry.Name)) { Directory.CreateDirectory(path); continue; }
                Directory.CreateDirectory(Path.GetDirectoryName(path));
                using (Stream source=entry.Open()) using (FileStream output=new FileStream(path,FileMode.Create,FileAccess.Write,FileShare.None)) source.CopyTo(output);
            }
        }
    }
    private static void CreateShortcut(string file,string target,string directory)
    {
        Type type = Type.GetTypeFromProgID("WScript.Shell");
        dynamic shell = Activator.CreateInstance(type);
        dynamic link = shell.CreateShortcut(file);
        link.TargetPath = target; link.WorkingDirectory = directory; link.IconLocation = target + ",0"; link.Description = "饭点 · 今天吃点什么"; link.Save();
    }
}

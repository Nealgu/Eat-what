using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;

internal static class Uninstall
{
    private static readonly string Root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"Programs","FoodTime");
    [STAThread]
    private static int Main(string[] args)
    {
        Application.EnableVisualStyles();
        if (args.Length == 2 && args[0] == "--cleanup") {
            int pid;
            if (!Int32.TryParse(args[1],out pid)) return 2;
            try { Process.GetProcessById(pid).WaitForExit(10000); } catch (ArgumentException) { }
            try { Cleanup(); return 0; } catch { return 1; }
        }
        string ownDirectory = Path.GetFullPath(AppDomain.CurrentDomain.BaseDirectory).TrimEnd(Path.DirectorySeparatorChar);
        string expected = Path.Combine(Root,"app-1.2.2");
        if (!String.Equals(ownDirectory,expected,StringComparison.OrdinalIgnoreCase)) {
            MessageBox.Show("这是免安装版本，关闭饭点后删除程序文件夹即可。\r\n个人清单和记录保存在独立的数据目录，不会随程序文件夹删除。","饭点"); return 0;
        }
        if (MessageBox.Show("要卸载饭点吗？\r\n\r\n程序和快捷方式会被移除，个人清单与记录会继续保留。\r\n请先关闭正在运行的饭点。","卸载饭点",MessageBoxButtons.YesNo,MessageBoxIcon.Question) != DialogResult.Yes) return 0;
        try {
            // A temporary copy finishes after this installed executable has exited.
            string helper = Path.Combine(Path.GetTempPath(),"FoodTime-uninstall-" + Guid.NewGuid().ToString("N") + ".exe");
            File.Copy(Application.ExecutablePath,helper);
            Process.Start(new ProcessStartInfo(helper,"--cleanup " + Process.GetCurrentProcess().Id) { UseShellExecute=false,CreateNoWindow=true });
            return 0;
        } catch (Exception error) { MessageBox.Show("卸载没有完成，请关闭饭点后重试。\r\n"+error.Message,"饭点"); return 1; }
    }
    private static void Cleanup()
    {
        string appFolder = Path.Combine(Root,"app-1.2.2");
        string prefix = Path.GetFullPath(appFolder).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        string manifest = Path.Combine(appFolder,"install-files.json");
        if (!File.Exists(manifest)) throw new InvalidDataException("缺少安装文件列表。");
        string[] files = new JavaScriptSerializer().Deserialize<string[]>(File.ReadAllText(manifest,Encoding.UTF8));
        foreach (string relative in files) {
            string file = Path.GetFullPath(Path.Combine(appFolder,relative));
            if (!file.StartsWith(prefix,StringComparison.OrdinalIgnoreCase) || HasReparsePoint(file,appFolder)) continue;
            if (File.Exists(file)) File.Delete(file);
        }
        // Delete only empty program directories. Never recurse into personal data.
        RemoveEmptyDirectories(appFolder);
        string menu = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs),"FoodTime");
        foreach (string file in new string[] {Path.Combine(menu,"饭点.lnk"),Path.Combine(menu,"卸载饭点.lnk"),Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory),"饭点.lnk")}) if(File.Exists(file)) File.Delete(file);
        if(Directory.Exists(menu) && Directory.GetFileSystemEntries(menu).Length==0) Directory.Delete(menu);
        if(Directory.Exists(Root) && Directory.GetFileSystemEntries(Root).Length==0) Directory.Delete(Root);
        Registry.CurrentUser.DeleteSubKeyTree(@"Software\Microsoft\Windows\CurrentVersion\Uninstall\FoodTime",false);
    }
    private static bool HasReparsePoint(string file,string boundary)
    {
        string current = file;
        while(!String.IsNullOrEmpty(current) && current.Length>=boundary.Length) {
            if((File.Exists(current)||Directory.Exists(current)) && (File.GetAttributes(current)&FileAttributes.ReparsePoint)!=0) return true;
            current=Path.GetDirectoryName(current);
        }
        return false;
    }
    private static void RemoveEmptyDirectories(string directory)
    {
        if(!Directory.Exists(directory) || (File.GetAttributes(directory)&FileAttributes.ReparsePoint)!=0) return;
        foreach(string child in Directory.GetDirectories(directory)) RemoveEmptyDirectories(child);
        if(Directory.GetFileSystemEntries(directory).Length==0) Directory.Delete(directory);
    }
}

using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace FoodTime.Desktop
{
    internal static class Program
    {
        internal static string DataDirectory;
        internal static uint ActivateMessage;
        private static readonly object LogSync = new object();

        [STAThread]
        private static void Main(string[] args)
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Mutex instanceMutex = null;
            bool ownsMutex = false;
            try
            {
                DataDirectory = ResolveDataDirectory(args);
                Directory.CreateDirectory(DataDirectory);
                string profileKey = HashDirectory(DataDirectory);
                ActivateMessage = RegisterWindowMessage("FoodTime.Activate." + profileKey);
                instanceMutex = new Mutex(true, "Local\\FoodTime." + profileKey, out ownsMutex);
                if (!ownsMutex)
                {
                    PostMessage(new IntPtr(0xffff), ActivateMessage, IntPtr.Zero, IntPtr.Zero);
                    return;
                }

                Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
                Application.ThreadException += delegate(object sender, ThreadExceptionEventArgs e)
                {
                    Log(e.Exception);
                    MessageBox.Show("刚才的操作没有完成。你的已保存数据会保留，请关闭后重新打开饭点。", "饭点", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                };
                AppDomain.CurrentDomain.UnhandledException += delegate(object sender, UnhandledExceptionEventArgs e)
                {
                    Log(e.ExceptionObject as Exception);
                };
                TaskScheduler.UnobservedTaskException += delegate(object sender, UnobservedTaskExceptionEventArgs e)
                {
                    Log(e.Exception);
                    e.SetObserved();
                };
                Application.Run(new MainWindow(DataDirectory));
            }
            catch (Exception error)
            {
                Log(error);
                MessageBox.Show("饭点暂时无法启动。\r\n\r\n" + error.Message, "饭点", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
            finally
            {
                if (instanceMutex != null)
                {
                    if (ownsMutex) instanceMutex.ReleaseMutex();
                    instanceMutex.Dispose();
                }
            }
        }

        private static string ResolveDataDirectory(string[] args)
        {
            string directory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "FoodTime");
            for (int i = 0; i < args.Length; i++)
            {
                if (args[i] != "--data-dir" || i + 1 >= args.Length)
                    throw new ArgumentException("启动参数无效。测试数据目录请使用 --data-dir 加绝对路径。");
                directory = args[++i];
                if (String.IsNullOrWhiteSpace(directory) || !Path.IsPathRooted(directory))
                    throw new ArgumentException("测试数据目录必须是绝对路径。");
            }
            return Path.GetFullPath(directory).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        }

        private static string HashDirectory(string directory)
        {
            using (SHA256 sha = SHA256.Create())
            {
                return BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(directory.ToUpperInvariant()))).Replace("-", "").Substring(0, 24);
            }
        }

        internal static void Log(Exception error)
        {
            if (error == null || String.IsNullOrEmpty(DataDirectory)) return;
            try
            {
                lock (LogSync)
                {
                    Directory.CreateDirectory(DataDirectory);
                    string file = Path.Combine(DataDirectory, "application.log");
                    if (File.Exists(file) && new FileInfo(file).Length > 1024 * 1024)
                    {
                        string previous = Path.Combine(DataDirectory, "application.previous.log");
                        File.Copy(file, previous, true);
                        File.WriteAllText(file, String.Empty, new UTF8Encoding(false));
                    }
                    File.AppendAllText(file, DateTimeOffset.Now.ToString("o") + Environment.NewLine + error.ToString() + Environment.NewLine + Environment.NewLine, new UTF8Encoding(false));
                }
            }
            catch { /* Logging must not hide the original failure. */ }
        }

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern uint RegisterWindowMessage(string message);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool PostMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
    }

    internal sealed class MainWindow : Form
    {
        private const int MaxBytes = 2 * 1024 * 1024;
        private const string AppHost = "foodtime.local";
        private const int DwmUseImmersiveDarkMode = 20;
        private const int DwmCaptionColor = 35;
        private const int DwmTextColor = 36;
        private static readonly Encoding StrictUtf8 = new UTF8Encoding(false, true);
        private readonly string dataDirectory;
        private readonly string statePath;
        private readonly string previousPath;
        private readonly NearbyService nearbyService;
        private WebView2 browser;
        private bool primaryDamaged;
        private bool initialBoundsApplied;

        internal MainWindow(string directory)
        {
            dataDirectory = directory;
            statePath = Path.Combine(directory, "state.json");
            previousPath = Path.Combine(directory, "state.previous.json");
            nearbyService = new NearbyService();
            Text = "饭点";
            Size = new Size(560, 900);
            MinimumSize = new Size(380, 650);
            StartPosition = FormStartPosition.CenterScreen;
            // The initial client size is converted from DIPs after the window has
            // a monitor and handle. Do not let WinForms scale those pixels again.
            AutoScaleMode = AutoScaleMode.None;
            Font = new Font("Microsoft YaHei UI", 9F, FontStyle.Regular, GraphicsUnit.Point);
            BackColor = Color.FromArgb(24, 35, 38);
            ForeColor = Color.FromArgb(240, 242, 232);
            try
            {
                string iconPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "assets", "app.ico");
                if (!File.Exists(iconPath)) iconPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "web", "assets", "app.ico");
                Icon = File.Exists(iconPath) ? new Icon(iconPath) : System.Drawing.Icon.ExtractAssociatedIcon(Application.ExecutablePath);
            }
            catch (Exception error) { Program.Log(error); }
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            if (SystemInformation.HighContrast) return;

            // Unsupported caption attributes leave the system frame in place.
            int darkMode = 1;
            int caption = ColorTranslator.ToWin32(BackColor);
            int text = ColorTranslator.ToWin32(ForeColor);
            DwmSetWindowAttribute(Handle, DwmUseImmersiveDarkMode, ref darkMode, sizeof(int));
            DwmSetWindowAttribute(Handle, DwmCaptionColor, ref caption, sizeof(int));
            DwmSetWindowAttribute(Handle, DwmTextColor, ref text, sizeof(int));
        }

        [DllImport("dwmapi.dll")]
        private static extern int DwmSetWindowAttribute(IntPtr window, int attribute, ref int value, int size);

        protected override async void OnShown(EventArgs e)
        {
            base.OnShown(e);
            ApplyInitialWindowBounds();
            await InitializeBrowser();
        }

        private void ApplyInitialWindowBounds()
        {
            if (initialBoundsApplied) return;
            initialBoundsApplied = true;

            double scale;
            using (Graphics graphics = CreateGraphics()) scale = graphics.DpiX / 96D;
            if (Double.IsNaN(scale) || Double.IsInfinity(scale) || scale <= 0) scale = 1D;
            Rectangle working = Screen.FromControl(this).WorkingArea;
            int frameWidth = Math.Max(0, Width - ClientSize.Width);
            int frameHeight = Math.Max(0, Height - ClientSize.Height);
            int margin = (int)Math.Round(16D * scale);

            int minimumWidth = Math.Min(working.Width, (int)Math.Round(380D * scale) + frameWidth);
            int minimumHeight = Math.Min(working.Height, (int)Math.Round(650D * scale) + frameHeight);
            int preferredWidth = Math.Min(working.Width, (int)Math.Round(480D * scale) + frameWidth);
            int width = Math.Min((int)Math.Round(520D * scale) + frameWidth, Math.Max(1, working.Width - margin * 2));
            int height = Math.Min((int)Math.Round(820D * scale) + frameHeight, Math.Max(1, working.Height - margin * 2));

            // Relax the decorative margin before shrinking the default CSS width
            // below 480 DIPs or the usable client height below the minimum.
            width = Math.Min(working.Width, Math.Max(width, Math.Max(minimumWidth, preferredWidth)));
            height = Math.Min(working.Height, Math.Max(height, minimumHeight));
            MinimumSize = new Size(minimumWidth, minimumHeight);
            Bounds = new Rectangle(
                working.Left + (working.Width - width) / 2,
                working.Top + (working.Height - height) / 2,
                width,
                height);
        }

        protected override void WndProc(ref Message message)
        {
            if (Program.ActivateMessage != 0 && message.Msg == Program.ActivateMessage)
            {
                if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
                Show();
                Activate();
            }
            base.WndProc(ref message);
        }

        private async Task InitializeBrowser()
        {
            try
            {
                string webDirectory = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "web");
                if (!File.Exists(Path.Combine(webDirectory, "index.html")))
                {
                    ShowStartupError("应用资源没有找到。请完整解压饭点文件夹后，再打开饭点.exe。", false);
                    return;
                }
                browser = new WebView2();
                browser.Dock = DockStyle.Fill;
                browser.DefaultBackgroundColor = BackColor;
                Controls.Add(browser);
                CoreWebView2Environment environment = await CoreWebView2Environment.CreateAsync(null, Path.Combine(dataDirectory, "WebView2"), null);
                if (IsDisposed) return;
                await browser.EnsureCoreWebView2Async(environment);
                if (IsDisposed) return;
                CoreWebView2 core = browser.CoreWebView2;
                core.Settings.AreDefaultContextMenusEnabled = false;
                core.Settings.AreDevToolsEnabled = false;
                core.Settings.AreBrowserAcceleratorKeysEnabled = false;
                core.Settings.AreHostObjectsAllowed = false;
                core.Settings.IsStatusBarEnabled = false;
                core.Settings.IsZoomControlEnabled = false;
                core.Settings.IsWebMessageEnabled = true;
                core.Settings.IsPasswordAutosaveEnabled = false;
                core.Settings.IsGeneralAutofillEnabled = false;
                core.NavigationStarting += delegate(object sender, CoreWebView2NavigationStartingEventArgs args) { args.Cancel = !IsAppUri(args.Uri); };
                core.FrameNavigationStarting += delegate(object sender, CoreWebView2NavigationStartingEventArgs args) { args.Cancel = !IsAppUri(args.Uri); };
                core.NewWindowRequested += OpenExternalMapLink;
                core.PermissionRequested += delegate(object sender, CoreWebView2PermissionRequestedEventArgs args)
                {
                    args.SavesInProfile = false;
                    if (args.PermissionKind != CoreWebView2PermissionKind.Geolocation || !args.IsUserInitiated || !IsAppUri(args.Uri))
                        args.State = CoreWebView2PermissionState.Deny;
                };
                core.DownloadStarting += delegate(object sender, CoreWebView2DownloadStartingEventArgs args) { args.Cancel = true; };
                core.WebMessageReceived += OnWebMessage;
                core.AddWebResourceRequestedFilter("*", CoreWebView2WebResourceContext.All);
                core.WebResourceRequested += delegate(object sender, CoreWebView2WebResourceRequestedEventArgs args)
                {
                    if (!IsAppUri(args.Request.Uri))
                        args.Response = environment.CreateWebResourceResponse(Stream.Null, 403, "Forbidden", "Content-Type: text/plain");
                };
                core.SetVirtualHostNameToFolderMapping(AppHost, webDirectory, CoreWebView2HostResourceAccessKind.DenyCors);
                await core.AddScriptToExecuteOnDocumentCreatedAsync("if (location.protocol === 'https:' && location.hostname === 'foodtime.local') { Object.defineProperty(window, 'FOOD_TIME_DESKTOP', { value: true, writable: false, configurable: false }); }");
                core.Navigate("https://" + AppHost + "/index.html");
            }
            catch (WebView2RuntimeNotFoundException error)
            {
                Program.Log(error);
                ShowStartupError("这台电脑缺少 Microsoft Edge WebView2 运行组件。\r\n请从 Microsoft 官方页面安装运行组件，然后重新打开饭点。", true);
            }
            catch (Exception error)
            {
                Program.Log(error);
                ShowStartupError("饭点没有成功打开，请关闭后重试。\r\n若仍有问题，可查看数据文件夹内的 application.log。\r\n\r\n" + error.Message, false);
            }
        }

        private static bool IsAppUri(string value)
        {
            Uri uri;
            return Uri.TryCreate(value, UriKind.Absolute, out uri) && uri.Scheme == Uri.UriSchemeHttps &&
                String.Equals(uri.Host, AppHost, StringComparison.OrdinalIgnoreCase) && uri.Port == 443 && String.IsNullOrEmpty(uri.UserInfo);
        }

        private void OpenExternalMapLink(object sender, CoreWebView2NewWindowRequestedEventArgs args)
        {
            args.Handled = true;
            Uri uri;
            if (!args.IsUserInitiated || !Uri.TryCreate(args.Uri, UriKind.Absolute, out uri) ||
                uri.Scheme != Uri.UriSchemeHttps || uri.Port != 443 || !String.IsNullOrEmpty(uri.UserInfo)) return;
            bool allowed = (uri.Host == "www.openstreetmap.org" && (uri.AbsolutePath == "/search" || uri.AbsolutePath == "/copyright" ||
                Regex.IsMatch(uri.AbsolutePath, @"^/(node|way|relation)/[0-9]{1,18}$"))) ||
                (uri.Host == "overpass.private.coffee" && uri.AbsolutePath == "/" && String.IsNullOrEmpty(uri.Query));
            if (!allowed) return;
            try { Process.Start(new ProcessStartInfo(uri.AbsoluteUri) { UseShellExecute = true }); }
            catch { MessageBox.Show(this, "没有打开浏览器，请稍后重试。", "饭点"); }
        }

        private void ShowStartupError(string message, bool offerRuntimeDownload)
        {
            if (IsDisposed) return;
            if (browser != null) { Controls.Remove(browser); browser.Dispose(); browser = null; }
            Panel panel = new Panel();
            panel.Dock = DockStyle.Fill;
            panel.Padding = new Padding(30);
            Label title = new Label();
            title.Text = "饭点";
            title.Font = new Font(Font.FontFamily, 22F, FontStyle.Bold);
            title.AutoSize = true;
            title.Location = new Point(30, 38);
            Label body = new Label();
            body.Text = message;
            body.AutoSize = false;
            body.Location = new Point(30, 100);
            body.Size = new Size(Math.Max(260, ClientSize.Width - 60), 200);
            body.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
            body.ForeColor = Color.FromArgb(175, 189, 183);
            panel.Controls.Add(title);
            panel.Controls.Add(body);
            if (offerRuntimeDownload)
            {
                LinkLabel link = new LinkLabel();
                link.Text = "打开 Microsoft WebView2 官方下载页面";
                link.LinkColor = Color.FromArgb(157, 180, 159);
                link.ActiveLinkColor = ForeColor;
                link.AutoSize = true;
                link.Location = new Point(30, 290);
                link.LinkClicked += delegate
                {
                    try { Process.Start(new ProcessStartInfo("https://developer.microsoft.com/microsoft-edge/webview2/") { UseShellExecute = true }); }
                    catch (Exception error) { Program.Log(error); MessageBox.Show("请在浏览器打开 https://developer.microsoft.com/microsoft-edge/webview2/", "饭点"); }
                };
                panel.Controls.Add(link);
            }
            Controls.Add(panel);
        }

        private static JavaScriptSerializer Json()
        {
            return new JavaScriptSerializer { MaxJsonLength = MaxBytes, RecursionLimit = 64 };
        }

        private async void OnWebMessage(object sender, CoreWebView2WebMessageReceivedEventArgs args)
        {
            if (!IsAppUri(args.Source)) return;
            object id = null;
            bool nearbyCommand = false;
            try
            {
                string raw = args.WebMessageAsJson;
                if (raw == null || raw.Length > MaxBytes || StrictUtf8.GetByteCount(raw) > MaxBytes)
                    throw new InvalidDataException("数据过大，最多支持 2 MB。");
                IDictionary<string, object> request = Json().DeserializeObject(raw) as IDictionary<string, object>;
                if (request == null) throw new InvalidDataException("请求格式无效。");
                object requestId;
                if (!request.TryGetValue("id", out requestId) || !(requestId is string) || ((string)requestId).Length == 0 || ((string)requestId).Length > 128)
                    throw new InvalidDataException("请求编号无效。");
                id = requestId;
                object commandValue;
                string command = request.TryGetValue("command", out commandValue) ? commandValue as string : null;
                nearbyCommand = command == "searchNearby";
                object payload;
                request.TryGetValue("payload", out payload);
                object result;
                switch (command)
                {
                    case "load": result = LoadState(); break;
                    case "save": SaveState(payload); result = true; break;
                    case "export": result = ExportBackup(payload); break;
                    case "import": result = ImportBackup(); break;
                    case "searchNearby":
                        IDictionary<string, object> position = payload as IDictionary<string, object>;
                        object latitudeValue, longitudeValue, radiusValue;
                        double latitude, longitude, radiusMeters;
                        if (position == null || !position.TryGetValue("latitude", out latitudeValue) ||
                            !position.TryGetValue("longitude", out longitudeValue) ||
                            !TryFiniteNumber(latitudeValue, out latitude) || !TryFiniteNumber(longitudeValue, out longitude) ||
                            Math.Abs(latitude) > 90 || Math.Abs(longitude) > 180)
                            throw new InvalidDataException("没有取得有效位置，请重新定位。");
                        if (!position.TryGetValue("radiusMeters", out radiusValue) || !TryFiniteNumber(radiusValue, out radiusMeters) ||
                            radiusMeters < 500 || radiusMeters > 5000 || Math.Floor(radiusMeters) != radiusMeters)
                            throw new InvalidDataException("搜索范围无效，请检查距离筛选。");
                        result = await nearbyService.SearchAsync(latitude, longitude, (int)radiusMeters);
                        break;
                    case "openDataDirectory":
                        Process.Start(new ProcessStartInfo(dataDirectory) { UseShellExecute = true, Verb = "open" });
                        result = true;
                        break;
                    default: throw new InvalidDataException("这个操作不受支持。");
                }
                Reply(id, true, result, null);
            }
            catch (Exception error)
            {
                if (!nearbyCommand) Program.Log(error);
                string fallback = nearbyCommand ? "附近搜店操作暂未完成，请稍后重试。" : "操作没有完成，请确认数据文件夹或所选文件可以正常读写。";
                Reply(id, false, null, error is InvalidDataException ? error.Message : fallback);
            }
        }

        private void Reply(object id, bool ok, object result, string error)
        {
            if (browser == null || IsDisposed || browser.CoreWebView2 == null) return;
            try { browser.CoreWebView2.PostWebMessageAsJson(Json().Serialize(new { id = id, ok = ok, result = result, error = error })); }
            catch (Exception failure) { Program.Log(failure); }
        }

        private object LoadState()
        {
            object saved;
            Exception primaryError;
            bool primaryExists = File.Exists(statePath);
            if (TryReadState(statePath, out saved, out primaryError))
            {
                primaryDamaged = false;
                return new { state = saved, warning = (string)null, dataDirectory = dataDirectory };
            }
            primaryDamaged = primaryExists;
            if (primaryError != null) Program.Log(primaryError);
            Exception backupError;
            if (TryReadState(previousPath, out saved, out backupError))
                return new { state = saved, warning = "上次的数据文件未能读取，已从上一份备份恢复。", dataDirectory = dataDirectory };
            if (backupError != null) Program.Log(backupError);
            return new
            {
                state = (object)null,
                warning = primaryExists || File.Exists(previousPath) ? "保存的数据未能读取，已打开初始清单；原来的文件会保留。" : null,
                dataDirectory = dataDirectory
            };
        }

        private static bool TryReadState(string file, out object state, out Exception error)
        {
            state = null;
            error = null;
            if (!File.Exists(file)) return false;
            try
            {
                if (new FileInfo(file).Length > MaxBytes) throw new InvalidDataException("保存的数据超过 2 MB。");
                object parsed = Json().DeserializeObject(File.ReadAllText(file, StrictUtf8));
                ValidateState(parsed);
                state = parsed;
                return true;
            }
            catch (Exception failure) { error = failure; return false; }
        }

        private static void ValidateState(object payload)
        {
            IDictionary<string, object> state = payload as IDictionary<string, object>;
            if (state == null) throw new InvalidDataException("保存的数据格式无效。");
            AssertSafeKeys(state);
            object version;
            double versionNumber;
            if (!state.TryGetValue("schemaVersion", out version) || !TryFiniteNumber(version, out versionNumber) || versionNumber != 1)
                throw new InvalidDataException("保存的数据版本不受支持。");
            object exportedAt;
            if (!state.TryGetValue("exportedAt", out exportedAt) || !(exportedAt is string) || !IsValidIsoTimestamp((string)exportedAt))
                throw new InvalidDataException("保存的数据导出时间无效。");
            object restaurantsValue;
            object filtersValue;
            object historyValue;
            state.TryGetValue("restaurants", out restaurantsValue);
            state.TryGetValue("filters", out filtersValue);
            state.TryGetValue("history", out historyValue);
            IList restaurants = restaurantsValue as IList;
            IList history = historyValue as IList;
            if (restaurants == null || restaurants.Count > 2000 || !(filtersValue is IDictionary<string, object>) || history == null || history.Count > 365)
                throw new InvalidDataException("数据格式不正确，或餐馆、记录数量超过上限。");
            for (int i = 0; i < restaurants.Count; i++) ValidateRestaurant(restaurants[i], "第 " + (i + 1) + " 家餐馆");
            for (int i = 0; i < history.Count; i++)
            {
                IDictionary<string, object> entry = history[i] as IDictionary<string, object>;
                object restaurant;
                object at;
                double timestamp;
                if (entry == null || !entry.TryGetValue("restaurant", out restaurant) || !entry.TryGetValue("at", out at) ||
                    !TryFiniteNumber(at, out timestamp) || timestamp < 0 || timestamp > 8640000000000000D)
                    throw new InvalidDataException("第 " + (i + 1) + " 条选择记录的时间或格式无效。");
                ValidateRestaurant(restaurant, "第 " + (i + 1) + " 条记录中的餐馆");
            }
        }

        private static void ValidateRestaurant(object payload, string label)
        {
            IDictionary<string, object> restaurant = payload as IDictionary<string, object>;
            if (restaurant == null) throw new InvalidDataException(label + "的格式不正确。");
            foreach (string field in new string[] { "id", "name", "category", "note" })
            {
                object value;
                if (!restaurant.TryGetValue(field, out value) || !(value is string))
                    throw new InvalidDataException(label + "的名称、标识、分类和备注必须是文字。");
                if (field == "name" && Regex.Replace((string)value, "[\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F\\x7F]", String.Empty).Trim().Length == 0)
                    throw new InvalidDataException(label + "缺少有效名称。");
            }
            object address;
            if (restaurant.TryGetValue("address", out address) && !(address is string))
                throw new InvalidDataException(label + "的地址必须是文字。");
            foreach (string field in new string[] { "distanceKm", "budget" })
            {
                object value;
                double number;
                if (!restaurant.TryGetValue(field, out value) || !TryFiniteNumber(value, out number) || number < 0)
                    throw new InvalidDataException(label + "的距离和人均预算必须是大于或等于 0 的有效数字。");
            }
            object enabled;
            if (!restaurant.TryGetValue("enabled", out enabled) || !(enabled is bool))
                throw new InvalidDataException(label + "的启用状态必须是 true 或 false。");
        }

        private static bool TryFiniteNumber(object value, out double number)
        {
            number = 0;
            if (value == null) return false;
            switch (Type.GetTypeCode(value.GetType()))
            {
                case TypeCode.Byte: case TypeCode.SByte: case TypeCode.Int16: case TypeCode.UInt16:
                case TypeCode.Int32: case TypeCode.UInt32: case TypeCode.Int64: case TypeCode.UInt64:
                case TypeCode.Single: case TypeCode.Double: case TypeCode.Decimal:
                    number = Convert.ToDouble(value, CultureInfo.InvariantCulture);
                    return !Double.IsNaN(number) && !Double.IsInfinity(number);
                default: return false;
            }
        }

        private static void AssertSafeKeys(object payload)
        {
            Stack<object> pending = new Stack<object>();
            pending.Push(payload);
            while (pending.Count != 0)
            {
                object value = pending.Pop();
                IDictionary<string, object> record = value as IDictionary<string, object>;
                if (record != null)
                {
                    foreach (KeyValuePair<string, object> item in record)
                    {
                        if (item.Key == "__proto__" || item.Key == "prototype" || item.Key == "constructor")
                            throw new InvalidDataException("保存的数据包含不安全字段。");
                        if (item.Value is IDictionary<string, object> || item.Value is IList) pending.Push(item.Value);
                    }
                    continue;
                }
                IList list = value as IList;
                if (list != null) foreach (object item in list)
                    if (item is IDictionary<string, object> || item is IList) pending.Push(item);
            }
        }

        private static bool IsValidIsoTimestamp(string value)
        {
            // Accept ISO timestamps over the same extended-year range as JS Date,
            // including the signed six-digit years produced by toISOString().
            Match match = Regex.Match(value, "\\A(?<year>[0-9]{4}|[+-][0-9]{6})-(?<month>[0-9]{2})-(?<day>[0-9]{2})[Tt](?<hour>[0-9]{2}):(?<minute>[0-9]{2}):(?<second>[0-9]{2})(?:\\.(?<fraction>[0-9]+))?(?<zone>[Zz]|[+-][0-9]{2}:[0-9]{2})\\z", RegexOptions.CultureInvariant);
            if (!match.Success) return false;
            if (match.Groups["year"].Value == "-000000") return false;
            int year = Int32.Parse(match.Groups["year"].Value, CultureInfo.InvariantCulture);
            int month = Int32.Parse(match.Groups["month"].Value, CultureInfo.InvariantCulture);
            int day = Int32.Parse(match.Groups["day"].Value, CultureInfo.InvariantCulture);
            int hour = Int32.Parse(match.Groups["hour"].Value, CultureInfo.InvariantCulture);
            int minute = Int32.Parse(match.Groups["minute"].Value, CultureInfo.InvariantCulture);
            int second = Int32.Parse(match.Groups["second"].Value, CultureInfo.InvariantCulture);
            if (month < 1 || month > 12 || day < 1 || hour > 24 || minute > 59 || second > 59) return false;
            bool leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
            int[] monthDays = new int[] { 31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31 };
            if (day > monthDays[month - 1]) return false;
            Group fraction = match.Groups["fraction"];
            int milliseconds = 0;
            for (int i = 0; i < Math.Min(3, fraction.Length); i++) milliseconds = milliseconds * 10 + (value[fraction.Index + i] - '0');
            for (int i = fraction.Length; i < 3; i++) milliseconds *= 10;
            if (hour == 24 && (minute != 0 || second != 0 || milliseconds != 0)) return false;
            string zone = match.Groups["zone"].Value;
            int offset = 0;
            if (zone.Length != 1)
            {
                int zoneHour = Int32.Parse(zone.Substring(1, 2), CultureInfo.InvariantCulture);
                int zoneMinute = Int32.Parse(zone.Substring(4, 2), CultureInfo.InvariantCulture);
                if (zoneHour > 23 || zoneMinute > 59) return false;
                offset = (zoneHour * 60 + zoneMinute) * (zone[0] == '+' ? 1 : -1);
            }
            long adjustedYear = year - (month <= 2 ? 1 : 0);
            long era = (adjustedYear >= 0 ? adjustedYear : adjustedYear - 399) / 400;
            long yearOfEra = adjustedYear - era * 400;
            long dayOfYear = (153 * (month + (month > 2 ? -3 : 9)) + 2) / 5 + day - 1;
            long dayOfEra = yearOfEra * 365 + yearOfEra / 4 - yearOfEra / 100 + dayOfYear;
            long days = era * 146097 + dayOfEra - 719468;
            double timestamp = days * 86400000D + hour * 3600000D + minute * 60000D + second * 1000D + milliseconds - offset * 60000D;
            return timestamp >= -8640000000000000D && timestamp <= 8640000000000000D;
        }

        private void SaveState(object payload)
        {
            ValidateState(payload);
            string json = Json().Serialize(payload);
            byte[] bytes = StrictUtf8.GetBytes(json);
            if (bytes.Length > MaxBytes) throw new InvalidDataException("数据过大，最多支持 2 MB。");
            Directory.CreateDirectory(dataDirectory);
            string temporary = Path.Combine(dataDirectory, "state.pending.json");
            try
            {
                using (FileStream stream = new FileStream(temporary, FileMode.Create, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough))
                {
                    stream.Write(bytes, 0, bytes.Length);
                    stream.Flush(true);
                }
                if (primaryDamaged && File.Exists(statePath))
                {
                    string damaged = Path.Combine(dataDirectory, "state.corrupt-" + DateTime.UtcNow.ToString("yyyyMMdd-HHmmss") + "-" + Guid.NewGuid().ToString("N").Substring(0, 6) + ".json");
                    File.Move(statePath, damaged);
                }
                if (File.Exists(statePath)) File.Replace(temporary, statePath, previousPath, true);
                else File.Move(temporary, statePath);
                primaryDamaged = false;
            }
            finally
            {
                try { if (File.Exists(temporary)) File.Delete(temporary); }
                catch (Exception error) { Program.Log(error); }
            }
        }

        private object ExportBackup(object payload)
        {
            IDictionary<string, object> request = payload as IDictionary<string, object>;
            object jsonValue;
            if (request == null || !request.TryGetValue("json", out jsonValue) || !(jsonValue is string))
                throw new InvalidDataException("备份内容无效。");
            string json = (string)jsonValue;
            if (StrictUtf8.GetByteCount(json) > MaxBytes) throw new InvalidDataException("备份文件超过 2 MB。");
            object parsed = Json().DeserializeObject(json);
            if (!(parsed is IDictionary<string, object>) && !(parsed is IList)) throw new InvalidDataException("备份内容不是有效的清单。");
            object filenameValue;
            string filename = request.TryGetValue("filename", out filenameValue) ? filenameValue as string : null;
            if (String.IsNullOrWhiteSpace(filename) || filename.Length > 128) filename = "饭点备份-" + DateTime.Now.ToString("yyyyMMdd") + ".json";
            filename = Path.GetFileName(filename);
            foreach (char character in Path.GetInvalidFileNameChars()) filename = filename.Replace(character, '_');
            if (!filename.EndsWith(".json", StringComparison.OrdinalIgnoreCase)) filename += ".json";
            using (SaveFileDialog dialog = new SaveFileDialog())
            {
                dialog.Title = "导出饭点备份";
                dialog.FileName = filename;
                dialog.DefaultExt = "json";
                dialog.Filter = "JSON 备份文件 (*.json)|*.json";
                dialog.AddExtension = true;
                dialog.OverwritePrompt = true;
                dialog.RestoreDirectory = true;
                if (dialog.ShowDialog(this) != DialogResult.OK) return new { saved = false };
                File.WriteAllText(dialog.FileName, json, new UTF8Encoding(false));
                return new { saved = true };
            }
        }

        private object ImportBackup()
        {
            using (OpenFileDialog dialog = new OpenFileDialog())
            {
                dialog.Title = "导入饭点备份或餐馆清单";
                dialog.Filter = "JSON 备份文件 (*.json)|*.json";
                dialog.CheckFileExists = true;
                dialog.Multiselect = false;
                dialog.RestoreDirectory = true;
                if (dialog.ShowDialog(this) != DialogResult.OK) return new { text = (string)null };
                if (new FileInfo(dialog.FileName).Length > MaxBytes) throw new InvalidDataException("备份文件超过 2 MB，请换一个文件。");
                return new { text = File.ReadAllText(dialog.FileName, StrictUtf8) };
            }
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing && browser != null) { browser.Dispose(); browser = null; }
            base.Dispose(disposing);
        }
    }
}

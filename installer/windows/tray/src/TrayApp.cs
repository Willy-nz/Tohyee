using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Net.Http;
using System.Runtime.InteropServices;
using System.ServiceProcess;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Win32;

namespace Tohyee.Tray
{
    /// <summary>What the tray shows about the server.</summary>
    internal enum ServerState
    {
        Checking,
        Running,
        Starting,
        Stopped,
        Problem,
    }

    /// <summary>
    /// The icon by the clock (like a media server's): green when Tohyee is
    /// running, amber while it starts, red when it's stopped or unwell. Its menu
    /// opens the books (in the browser) and the server settings (this app's own
    /// window), restarts the services, and turns starting with Windows on or off.
    /// </summary>
    internal sealed class TrayApp : ApplicationContext
    {
        public const string RunKeyPath = @"Software\Microsoft\Windows\CurrentVersion\Run";
        public const string RunValueName = "Tohyee";

        private readonly TraySettings _settings;
        private readonly NotifyIcon _icon;
        private readonly ToolStripMenuItem _statusItem;
        private readonly ToolStripMenuItem _startWithWindowsItem;
        private readonly Timer _timer;
        private readonly HttpClient _health = new HttpClient(new HttpClientHandler { UseProxy = false }) { Timeout = TimeSpan.FromSeconds(4) };
        private readonly TohyeeApi _api;
        private readonly AppServices _services;
        private ServerSettingsForm _settingsForm;
        private ServerState _state = ServerState.Checking;
        private string _version;
        private string _stateText;
        private TimeSpan? _uptime;
        private bool _checking;

        public TrayApp(TraySettings settings, bool openSettings, bool backUp = false)
        {
            _settings = settings;
            _api = new TohyeeApi(settings.AdminUrl);
            _services = new AppServices
            {
                Api = _api,
                Settings = settings,
                Tailscale = new TailscaleCli(),
                Cloudflare = new CloudflaredCli(settings),
                News = NewsFeed.ForThisUser(),
                Server = () => new ServerInfo { State = _state, Text = _stateText, Version = _version, Uptime = _uptime },
            };

            var menu = new ContextMenuStrip();
            _statusItem = new ToolStripMenuItem("Checking Tohyee…") { Enabled = false };
            menu.Items.Add(_statusItem);
            menu.Items.Add(new ToolStripSeparator());
            var openBooks = new ToolStripMenuItem("Open Tohyee", null, (s, e) => OpenBooks());
            openBooks.Font = new Font(openBooks.Font, FontStyle.Bold);
            menu.Items.Add(openBooks);
            menu.Items.Add(new ToolStripMenuItem("Server settings…", null, (s, e) => ShowSettings()));
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(new ToolStripMenuItem("Restart Tohyee", null, (s, e) => RestartServices()));
            menu.Items.Add(new ToolStripMenuItem("Back up now", null, (s, e) => BackUpNow()));
            menu.Items.Add(new ToolStripMenuItem("Open the logs folder", null, (s, e) => OpenFolder(_settings.LogsDir)));
            menu.Items.Add(new ToolStripSeparator());
            _startWithWindowsItem = new ToolStripMenuItem("Start when I sign in to Windows", null, (s, e) => ToggleStartWithWindows()) { Checked = StartsWithWindows() };
            menu.Items.Add(_startWithWindowsItem);
            menu.Items.Add(new ToolStripMenuItem("Quit the tray icon", null, (s, e) => Quit()));

            _icon = new NotifyIcon
            {
                ContextMenuStrip = menu,
                Icon = MakeIcon(ServerState.Checking),
                Text = "Tohyee",
                Visible = true,
            };
            _icon.MouseClick += (s, e) =>
            {
                if (e.Button == MouseButtons.Left) ShowSettings();
            };

            _timer = new Timer { Interval = 10000 };
            _timer.Tick += async (s, e) => await Check();
            _timer.Start();
            Forget(Check());
            if (backUp) BackUpNow();
            else if (openSettings) ShowSettings();
        }

        // ------------------------------------------------------------ status

        private static string ServiceStatus(string name)
        {
            try
            {
                using (var service = new ServiceController(name))
                {
                    return service.Status.ToString();
                }
            }
            catch (InvalidOperationException)
            {
                return "Missing";
            }
            catch (Exception)
            {
                return "Unknown";
            }
        }

        private async Task Check()
        {
            if (_checking) return;
            _checking = true;
            try
            {
                var server = ServiceStatus("Tohyee");
                var database = ServiceStatus("TohyeePostgres");
                ServerState state;
                string detail = null;
                bool answering = false;
                try
                {
                    using (var response = await _health.GetAsync("http://127.0.0.1:" + _settings.Port + "/api/health"))
                    {
                        answering = response.IsSuccessStatusCode;
                        var body = await response.Content.ReadAsStringAsync();
                        var parsed = new System.Web.Script.Serialization.JavaScriptSerializer().DeserializeObject(body) as System.Collections.Generic.Dictionary<string, object>;
                        _version = J.Str(parsed, "version") ?? _version;
                        if (!answering) detail = "its database isn't answering";
                    }
                }
                catch (Exception)
                {
                    answering = false;
                }

                if (answering) state = ServerState.Running;
                else if (server == "Missing") { state = ServerState.Problem; detail = "the Tohyee service isn't installed"; }
                else if (server == "Stopped" || database == "Stopped") { state = ServerState.Stopped; detail = server == "Stopped" ? "the Tohyee service is stopped" : "its database service is stopped"; }
                else if (server == "StartPending" || server == "Running") { state = detail == null ? ServerState.Starting : ServerState.Problem; }
                else state = ServerState.Problem;

                var text = state == ServerState.Running ? "Tohyee is running" + (_version != null ? " (" + _version + ")" : "")
                    : state == ServerState.Starting ? "Tohyee is starting…"
                    : state == ServerState.Stopped ? "Tohyee is stopped: " + detail
                    : "Tohyee has a problem" + (detail != null ? ": " + detail : "");
                _stateText = text;
                _uptime = state == ServerState.Running ? ServiceUptime("Tohyee") : null;
                _statusItem.Text = text;
                _icon.Text = text.Length > 63 ? text.Substring(0, 63) : text;
                if (state != _state)
                {
                    var previous = _state;
                    _state = state;
                    var oldIcon = _icon.Icon;
                    _icon.Icon = MakeIcon(state);
                    if (oldIcon != null) DestroyIcon(oldIcon);
                    if (previous == ServerState.Running && (state == ServerState.Stopped || state == ServerState.Problem))
                    {
                        _icon.ShowBalloonTip(8000, "Tohyee", text + ". People can't use the books until it's running again.", ToolTipIcon.Warning);
                    }
                }
            }
            finally
            {
                _checking = false;
            }
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct ServiceStatusProcess
        {
            public int ServiceType;
            public int CurrentState;
            public int ControlsAccepted;
            public int Win32ExitCode;
            public int ServiceSpecificExitCode;
            public int CheckPoint;
            public int WaitHint;
            public int ProcessId;
            public int ServiceFlags;
        }

        [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern IntPtr OpenSCManager(string machine, string database, int access);

        [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern IntPtr OpenService(IntPtr manager, string name, int access);

        [DllImport("advapi32.dll", SetLastError = true)]
        private static extern bool QueryServiceStatusEx(IntPtr service, int level, ref ServiceStatusProcess status, int size, out int needed);

        [DllImport("advapi32.dll", SetLastError = true)]
        private static extern bool CloseServiceHandle(IntPtr handle);

        /// <summary>
        /// How long a service's process has been running, if Windows lets this
        /// user see it (SERVICE_QUERY_STATUS is open to everyone; the process's
        /// start time may not be). Null when it can't tell.
        /// </summary>
        private static TimeSpan? ServiceUptime(string name)
        {
            if (Environment.OSVersion.Platform != PlatformID.Win32NT) return null;
            var manager = IntPtr.Zero;
            var service = IntPtr.Zero;
            try
            {
                manager = OpenSCManager(null, null, 0x0001); // SC_MANAGER_CONNECT
                if (manager == IntPtr.Zero) return null;
                service = OpenService(manager, name, 0x0004); // SERVICE_QUERY_STATUS
                if (service == IntPtr.Zero) return null;
                var status = new ServiceStatusProcess();
                int needed;
                if (!QueryServiceStatusEx(service, 0, ref status, Marshal.SizeOf(typeof(ServiceStatusProcess)), out needed) || status.ProcessId == 0) return null;
                using (var process = Process.GetProcessById(status.ProcessId))
                {
                    return DateTime.Now - process.StartTime;
                }
            }
            catch (Exception)
            {
                return null;
            }
            finally
            {
                if (service != IntPtr.Zero) CloseServiceHandle(service);
                if (manager != IntPtr.Zero) CloseServiceHandle(manager);
            }
        }

        /// <summary>Lets background work run without waiting, and without unobserved errors.</summary>
        private static void Forget(Task task)
        {
            task.ContinueWith(t => { var unused = t.Exception; }, TaskContinuationOptions.OnlyOnFaulted);
        }

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool DestroyIcon(IntPtr handle);

        private static void DestroyIcon(Icon icon)
        {
            try
            {
                DestroyIcon(icon.Handle);
                icon.Dispose();
            }
            catch (Exception)
            {
                // Nothing to tidy.
            }
        }

        private static Image _trayLogo;

        /// <summary>
        /// The Tohyee logo with a status dot: green when running, amber while
        /// starting, red when stopped or unwell. Drawn at 32 px; Windows scales it.
        /// </summary>
        internal static Icon MakeIcon(ServerState state)
        {
            using (var bitmap = new Bitmap(32, 32))
            using (var g = Graphics.FromImage(bitmap))
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                g.Clear(Color.Transparent);
                if (_trayLogo == null) _trayLogo = Theme.LoadImage("logo-32.png");
                if (_trayLogo != null)
                {
                    g.DrawImage(_trayLogo, new Rectangle(0, 0, 30, 30));
                }
                else
                {
                    using (var path = Theme.Rounded(new RectangleF(1, 1, 28, 28), 7))
                    using (var brush = new SolidBrush(Theme.Accent))
                    {
                        g.FillPath(brush, path);
                    }
                }
                var dot = state == ServerState.Running ? Color.FromArgb(34, 197, 94)
                    : state == ServerState.Starting || state == ServerState.Checking ? Color.FromArgb(245, 158, 11)
                    : Color.FromArgb(239, 68, 68);
                // A big dot with a dark ring, so the colour reads even at 16 px on a light or dark taskbar.
                using (var ring = new SolidBrush(Color.FromArgb(17, 24, 39)))
                using (var brush = new SolidBrush(dot))
                {
                    g.FillEllipse(ring, 16, 16, 16, 16);
                    g.FillEllipse(brush, 18.5f, 18.5f, 11, 11);
                }
                return Icon.FromHandle(bitmap.GetHicon());
            }
        }

        // ------------------------------------------------------------ actions

        private void OpenBooks()
        {
            Open(_settings.BooksUrl);
        }

        public void ShowSettings()
        {
            if (_settingsForm == null || _settingsForm.IsDisposed)
            {
                _settingsForm = new ServerSettingsForm(_services);
            }
            _settingsForm.Show();
            if (_settingsForm.WindowState == FormWindowState.Minimized) _settingsForm.WindowState = FormWindowState.Normal;
            _settingsForm.Activate();
        }

        private void RestartServices()
        {
            var answer = MessageBox.Show(
                "Restart Tohyee? Anyone using the books will be disconnected for a minute. Windows will ask for permission.",
                "Tohyee", MessageBoxButtons.OKCancel, MessageBoxIcon.Question);
            if (answer != DialogResult.OK) return;
            RunElevated("-NoProfile -Command \"Restart-Service -Name TohyeePostgres -Force; Restart-Service -Name Tohyee -Force\"");
        }

        /// <summary>Encrypted backups of every organisation now, in the server settings window (after signing in).</summary>
        public void BackUpNow()
        {
            ShowSettings();
            _settingsForm.BackUpNow();
        }

        internal static void RunElevated(string powershellArguments)
        {
            try
            {
                Process.Start(new ProcessStartInfo
                {
                    FileName = Path.Combine(Environment.SystemDirectory, @"WindowsPowerShell\v1.0\powershell.exe"),
                    Arguments = powershellArguments,
                    Verb = "runas",
                    UseShellExecute = true,
                });
            }
            catch (System.ComponentModel.Win32Exception)
            {
                // Permission was declined.
            }
        }

        internal static void OpenFolder(string path)
        {
            try
            {
                Directory.CreateDirectory(path);
                Process.Start(new ProcessStartInfo { FileName = path, UseShellExecute = true });
            }
            catch (Exception error)
            {
                MessageBox.Show("Couldn't open " + path + ": " + error.Message, "Tohyee", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
        }

        public static void Open(string url)
        {
            try
            {
                Process.Start(new ProcessStartInfo { FileName = url, UseShellExecute = true });
            }
            catch (Exception error)
            {
                MessageBox.Show("Couldn't open " + url + ": " + error.Message, "Tohyee", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
        }

        // ------------------------------------------------------------ start with Windows

        public static bool StartsWithWindows()
        {
            using (var key = Registry.CurrentUser.OpenSubKey(RunKeyPath, false))
            {
                return key != null && key.GetValue(RunValueName) != null;
            }
        }

        public static void SetStartWithWindows(bool on)
        {
            using (var key = Registry.CurrentUser.CreateSubKey(RunKeyPath))
            {
                if (key == null) return;
                if (on) key.SetValue(RunValueName, "\"" + Application.ExecutablePath + "\"");
                else if (key.GetValue(RunValueName) != null) key.DeleteValue(RunValueName, false);
            }
        }

        private void ToggleStartWithWindows()
        {
            var on = !StartsWithWindows();
            SetStartWithWindows(on);
            _startWithWindowsItem.Checked = StartsWithWindows();
        }

        private void Quit()
        {
            _timer.Stop();
            _icon.Visible = false;
            if (_settingsForm != null && !_settingsForm.IsDisposed) _settingsForm.Close();
            Forget(_api.SignOut());
            ExitThread();
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                _timer.Dispose();
                _icon.Dispose();
                _health.Dispose();
                _api.Dispose();
            }
            base.Dispose(disposing);
        }
    }
}

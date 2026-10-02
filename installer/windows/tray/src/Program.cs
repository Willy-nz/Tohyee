using System;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace Tohyee.Tray
{
    internal static class Program
    {
        private const string MutexName = @"Local\TohyeeTray";
        private const string ShowEventName = @"Local\TohyeeTray.ShowSettings";
        private const string BackUpEventName = @"Local\TohyeeTray.BackUpNow";

        /// <summary>
        ///   TohyeeTray.exe               the tray icon (started when you sign in to Windows)
        ///   TohyeeTray.exe --settings    the tray icon, with the server settings window open
        ///   TohyeeTray.exe --back-up     the same, backing up every organisation now (Start menu: Back up Tohyee)
        ///   TohyeeTray.exe --after-update   the tray icon, started by the installer after Install on the Updates
        ///                                   page; it reports how the update went (from the note Install left)
        ///   TohyeeTray.exe --self-test &lt;file&gt;   checks it can reach Tohyee (used by the installer test)
        ///   TohyeeTray.exe --demo-screenshots &lt;folder&gt;   saves pictures of each page with sample data (no server, no network)
        /// </summary>
        [STAThread]
        private static int Main(string[] args)
        {
            // GitHub (news) and Tailscale's package server need TLS 1.2; older
            // Windows 10 builds don't offer it to .NET Framework apps by default.
            System.Net.ServicePointManager.SecurityProtocol |= System.Net.SecurityProtocolType.Tls12;
            if (args.Length >= 2 && args[0] == "--demo-screenshots")
            {
                return DemoData.Screenshots(args[1]);
            }
            var settings = TraySettings.Load();
            if (args.Length >= 1 && args[0] == "--self-test")
            {
                return SelfTest(settings, args.Length >= 2 ? args[1] : null);
            }
            var openSettings = args.Contains("--settings");
            var backUp = args.Contains("--back-up");

            bool first;
            using (var mutex = new Mutex(true, MutexName, out first))
            using (var showEvent = new EventWaitHandle(false, EventResetMode.AutoReset, ShowEventName))
            using (var backUpEvent = new EventWaitHandle(false, EventResetMode.AutoReset, BackUpEventName))
            {
                if (!first)
                {
                    // Already running: ask it to open the settings window (and back up).
                    if (backUp) backUpEvent.Set();
                    else if (openSettings) showEvent.Set();
                    return 0;
                }

                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                using (var app = new TrayApp(settings, openSettings, backUp))
                {
                    var context = SynchronizationContext.Current ?? new WindowsFormsSynchronizationContext();
                    var listener = new Thread(() =>
                    {
                        while (showEvent.WaitOne())
                        {
                            context.Post(_ => app.ShowSettings(), null);
                        }
                    })
                    { IsBackground = true };
                    listener.Start();
                    var backUpListener = new Thread(() =>
                    {
                        while (backUpEvent.WaitOne())
                        {
                            context.Post(_ => app.BackUpNow(), null);
                        }
                    })
                    { IsBackground = true };
                    backUpListener.Start();
                    Application.Run(app);
                }
                GC.KeepAlive(mutex);
            }
            return 0;
        }

        /// <summary>
        /// Checks the app can reach Tohyee on this computer: the books answer, and
        /// the server settings address answers (and asks for a sign-in). With
        /// TOHYEE_TRAY_TEST_EMAIL, _PASSWORD and _CODE set, it also signs in and
        /// lists the organisations. Writes what it found to the file.
        /// </summary>
        private static int SelfTest(TraySettings settings, string resultFile)
        {
            var report = new StringBuilder();
            var ok = true;
            try
            {
                ok = RunSelfTest(settings, report).GetAwaiter().GetResult();
            }
            catch (Exception error)
            {
                report.AppendLine("FAILED: " + error.Message);
                ok = false;
            }
            report.AppendLine(ok ? "OK" : "FAILED");
            if (resultFile != null) File.WriteAllText(resultFile, report.ToString());
            return ok ? 0 : 1;
        }

        private static async Task<bool> RunSelfTest(TraySettings settings, StringBuilder report)
        {
            report.AppendLine("Books: " + settings.BooksUrl + "; server settings: " + settings.AdminUrl);
            using (var books = new TohyeeApi("http://127.0.0.1:" + settings.Port))
            {
                var health = await books.Get("/api/health");
                report.AppendLine("Health: " + J.Str(health, "status") + ", version " + J.Str(health, "version"));
            }
            using (var api = new TohyeeApi(settings.AdminUrl))
            {
                try
                {
                    await api.Get("/api/admin/users");
                    report.AppendLine("Server settings answered without a sign-in: that's wrong.");
                    return false;
                }
                catch (ApiException error)
                {
                    report.AppendLine("Server settings without a sign-in: " + error.Status + " (" + error.Message + ")");
                    if (error.Status != 401) return false;
                }

                var email = Environment.GetEnvironmentVariable("TOHYEE_TRAY_TEST_EMAIL");
                var password = Environment.GetEnvironmentVariable("TOHYEE_TRAY_TEST_PASSWORD");
                var code = Environment.GetEnvironmentVariable("TOHYEE_TRAY_TEST_CODE");
                if (string.IsNullOrEmpty(email) || string.IsNullOrEmpty(password)) return true;
                var stage = await api.SignIn(email, password);
                report.AppendLine("Signed in: stage " + stage);
                if (stage == "verify")
                {
                    if (string.IsNullOrEmpty(code)) return false;
                    await api.Verify(email, code);
                }
                else if (stage != "full")
                {
                    return false;
                }
                var organisations = J.List(await api.Get("/api/admin/organisations"), "organisations");
                report.AppendLine("Organisations: " + string.Join(", ", organisations.Select(o => J.Str(o, "id"))));
                var users = J.List(await api.Get("/api/admin/users"), "users");
                report.AppendLine("Users: " + users.Count);
                await api.SignOut();
                return organisations.Count > 0;
            }
        }
    }
}

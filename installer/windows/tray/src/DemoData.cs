using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace Tohyee.Tray
{
    /// <summary>
    /// TohyeeTray.exe --demo-screenshots &lt;folder&gt;: opens the window with sample
    /// data (no server, no network) and saves a picture of each page, for
    /// checking the look. Not for everyday use.
    /// </summary>
    internal static class DemoData
    {
        public static int Screenshots(string folder)
        {
            Directory.CreateDirectory(folder);
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            var tailscale = new DemoTailscale { State = PhoneState.NotInstalled };
            var services = new AppServices
            {
                Api = TohyeeApi.Demo("jess@example.nz", Answer),
                Settings = TraySettings.Load(),
                Tailscale = tailscale,
                Cloudflare = new DemoCloudflare(),
                News = NewsFeed.Sample(SampleNews()),
                Server = () => new ServerInfo { State = ServerState.Running, Version = "0.2.1", Uptime = TimeSpan.FromHours(77) },
            };
            Remote = TohyeeOn;
            using (var form = new ServerSettingsForm(services))
            {
                form.Show();
                Pump();
                Save(form, folder, "0-sign-in");
                form.ShowSettings();
                foreach (var page in new[] { "home", "organisations", "users", "backups", "analytics", "email", "stats", "updates", "signins" })
                {
                    if (Transitions)
                    {
                        form.Activate();
                        Pump();
                    }
                    Clock.Restart();
                    form.Navigate(page);
                    if (Transitions)
                    {
                        // What the window shows while the page is being made and its data arrives:
                        // copied straight away, with the real time since the click written down (#198).
                        Frame(form, folder, Name(page) + "-t0");
                        PumpFor(1);
                        Frame(form, folder, Name(page) + "-t1");
                        PumpFor(4);
                        Frame(form, folder, Name(page) + "-t2");
                    }
                    Pump();
                    if (Transitions) PumpFor(20);
                    Save(form, folder, Name(page));
                    // Where every control ended up, to find blank cards like Home's news (#198).
                    if (Transitions) File.WriteAllText(Path.Combine(folder, "layout-" + Name(page) + ".txt"), Layout(form, 0));
                }
                // Home in a narrow window: the quick looks two to a row.
                var wide = form.ClientSize;
                form.ClientSize = new Size(Theme.S(900), Theme.S(700));
                form.Navigate("home");
                Pump();
                Save(form, folder, "1-home-narrow");
                form.ClientSize = wide;
                Pump();

                if (Transitions)
                {
                    // Coming back to a page that's already made.
                    form.Navigate("home");
                    Pump();
                    Clock.Restart();
                    form.Navigate("organisations");
                    Frame(form, folder, "again-organisations-t0");
                    PumpFor(1);
                    Frame(form, folder, "again-organisations-t1");
                    // A selected row, to check it reads clearly.
                    var list = FindList(form);
                    if (list != null && list.Items.Count > 2)
                    {
                        list.Items[2].Selected = true;
                        Pump();
                        Save(form, folder, "organisations-selected");
                    }
                }

                // Remote access: the chooser, then each way on or part-way through.
                Phone(form, services, folder, "1-choose", Off, PhoneState.NotInstalled, RemoteAccessPage.DemoStage.None, true, null);
                Phone(form, services, folder, "2-tohyee-on", TohyeeOn, PhoneState.NotInstalled, RemoteAccessPage.DemoStage.None, true, null);
                Phone(form, services, folder, "3-tohyee-not-available", Off, PhoneState.NotInstalled, RemoteAccessPage.DemoStage.None, false, null);
                Phone(form, services, folder, "4-cloudflare-sign-in", Off, PhoneState.NotInstalled, RemoteAccessPage.DemoStage.CloudflareSignIn, true, "cloudflare");
                Phone(form, services, folder, "5-cloudflare-address", Off, PhoneState.NotInstalled, RemoteAccessPage.DemoStage.CloudflareChoose, true, "cloudflare");
                Phone(form, services, folder, "6-cloudflare-on", CloudflareOn, PhoneState.NotInstalled, RemoteAccessPage.DemoStage.None, true, "cloudflare");
                Phone(form, services, folder, "7-tailscale-on", TailscaleOn, PhoneState.On, RemoteAccessPage.DemoStage.None, true, "tailscale");
                form.Close();
            }
            Console.WriteLine("Saved screenshots to " + folder);
            return 0;
        }

        private static void Phone(ServerSettingsForm form, AppServices services, string folder, string name, string remote, PhoneState tailscale, RemoteAccessPage.DemoStage stage, bool serviceAvailable, string scrollTo)
        {
            Remote = remote;
            ServiceAvailable = serviceAvailable;
            ((DemoTailscale)services.Tailscale).State = tailscale;
            var phone = new RemoteAccessPage(services.Api, services.Settings, services.Tailscale, services.Cloudflare);
            form.ShowPage("phone", phone);
            Pump();
            phone.ShowForDemo(stage, serviceAvailable, scrollTo);
            Pump();
            Save(form, folder, Name("phone") + "-" + name);
        }

        private static string Remote;
        private static bool ServiceAvailable = true;

        private const string Tunnel = "'tunnel':{'status':'connected','message':null,'log':['2026-09-30T08:12:01Z INF Registered tunnel connection connIndex=0 location=akl01 protocol=quic']}";
        private const string Common = "'localService':'http://127.0.0.1:3000','twoStepRequired':true,'secretsAvailable':true,'addressService':'https://relay.tohyee.example'";
        private static readonly string Off = "{'remoteAccess':{'method':'cloudflare','enabled':false,'publicUrl':null,'hasToken':false,'tunnelId':null,'tohyeeAddress':null," + Common + ",'tunnel':{'status':'off','message':null,'log':[]}}}";
        private static readonly string TohyeeOn = "{'remoteAccess':{'method':'tohyee','enabled':true,'publicUrl':'https://k7m2q9.tohyee.example','hasToken':false,'tunnelId':null,'tohyeeAddress':'https://k7m2q9.tohyee.example'," + Common + "," + Tunnel + "}}";
        private static readonly string CloudflareOn = "{'remoteAccess':{'method':'cloudflare','enabled':true,'publicUrl':'https://books.example.nz','hasToken':true,'tunnelId':'6ff42ae2-765d-4adf-8112-31c55c1551ef','tohyeeAddress':null," + Common + "," + Tunnel + "}}";
        private static readonly string TailscaleOn = "{'remoteAccess':{'method':'tailscale','enabled':true,'publicUrl':'https://tohyee-pc.tail1a2b3c.ts.net','hasToken':false,'tunnelId':null,'tohyeeAddress':null," + Common + ",'tunnel':{'status':'off','message':null,'log':[]}}}";

        private static string Name(string page)
        {
            var order = new[] { "home", "organisations", "users", "phone", "backups", "analytics", "email", "stats", "updates", "signins" };
            return (Array.IndexOf(order, page) + 1) + "-" + page;
        }

        private static ListView FindList(Control root)
        {
            foreach (Control child in root.Controls)
            {
                if (child is ListView && child.Visible) return (ListView)child;
                var found = FindList(child);
                if (found != null) return found;
            }
            return null;
        }

        /// <summary>TOHYEE_DEMO_TRANSITIONS=1: also saves pictures while each page appears (needs a real screen).</summary>
        private static readonly bool Transitions = Environment.GetEnvironmentVariable("TOHYEE_DEMO_TRANSITIONS") == "1";

        private static void PumpFor(int rounds)
        {
            for (var i = 0; i < rounds; i++)
            {
                Application.DoEvents();
                Thread.Sleep(15);
            }
        }

        private static void Pump()
        {
            for (var i = 0; i < 40; i++)
            {
                Application.DoEvents();
                Thread.Sleep(15);
            }
        }

        /// <summary>Each visible control's type, bounds, visibility and text, indented by depth.</summary>
        private static string Layout(Control control, int depth)
        {
            var text = control.Text ?? "";
            if (text.Length > 40) text = text.Substring(0, 40) + "…";
            var line = new string(' ', depth * 2) + control.GetType().Name + " " + control.Bounds + (control.Visible ? "" : " hidden")
                + (control.AutoSize ? " auto" : "") + (text.Length > 0 ? " \"" + text.Replace("\n", " ") + "\"" : "") + Environment.NewLine;
            var sb = new System.Text.StringBuilder(line);
            if (depth < 14)
            {
                foreach (Control child in control.Controls)
                {
                    if (child.Visible || depth < 3) sb.Append(Layout(child, depth + 1));
                }
            }
            return sb.ToString();
        }

        /// <summary>Time since the last page was asked for, for the transition frames.</summary>
        private static readonly System.Diagnostics.Stopwatch Clock = new System.Diagnostics.Stopwatch();

        /// <summary>
        /// A transition frame: the screen copied at once, without waiting for painting to settle
        /// (Save waits about 600 ms first, so its "-t0" pictures were never the first frame, #198),
        /// with the milliseconds since the page was asked for kept in timings.txt.
        /// </summary>
        private static void Frame(Form form, string folder, string name)
        {
            var elapsed = Clock.Elapsed.TotalMilliseconds;
            using (var bitmap = new Bitmap(form.ClientSize.Width, form.ClientSize.Height))
            {
                using (var g = Graphics.FromImage(bitmap)) g.CopyFromScreen(form.PointToScreen(Point.Empty), Point.Empty, bitmap.Size);
                bitmap.Save(Path.Combine(folder, name + ".png"), ImageFormat.Png);
            }
            File.AppendAllText(Path.Combine(folder, "timings.txt"), name + ": " + elapsed.ToString("0") + " ms after the page was asked for" + Environment.NewLine);
        }

        private static void Save(Form form, string folder, string name)
        {
            using (var bitmap = new Bitmap(form.ClientSize.Width, form.ClientSize.Height))
            {
                if (Type.GetType("Mono.Runtime") != null || Transitions)
                {
                    // Mono's DrawToBitmap leaves out child controls, so copy the window off the screen.
                    form.Activate();
                    Pump();
                    using (var g = Graphics.FromImage(bitmap)) g.CopyFromScreen(form.PointToScreen(Point.Empty), Point.Empty, bitmap.Size);
                }
                else
                {
                    form.DrawToBitmap(bitmap, new Rectangle(0, 0, bitmap.Width, bitmap.Height));
                }
                bitmap.Save(Path.Combine(folder, name + ".png"), ImageFormat.Png);
            }
        }

        private static List<NewsItem> SampleNews()
        {
            return new List<NewsItem>
            {
                new NewsItem { Kind = "release", Date = "2026-09-29", Title = "Tohyee 0.2.1", Body = "Bank reconciliation with one-click OK, bulk coding and split transactions, plus foreign-currency bank accounts.", Link = NewsFeed.ReleasesPage },
                new NewsItem { Kind = "announcement", Date = "2026-09-20", Title = "Remote access is getting easier", Body = "The next server app gives you three ways to use Tohyee from your phone, including a Tohyee address in one click. Then scan a QR code." },
                new NewsItem { Kind = "release", Date = "2026-09-02", Title = "Tohyee 0.2.0", Body = "Encrypted nightly backups with OneDrive copies, restore as a copy, and the backup key check.", Link = NewsFeed.ReleasesPage },
                NewsFeed.DefaultConference,
            };
        }

        private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();

        private static Dictionary<string, object> Parse(string json)
        {
            return (Dictionary<string, object>)Json.DeserializeObject(json.Replace('\'', '"'));
        }

        private static string Ago(double hours)
        {
            return DateTime.UtcNow.AddHours(-hours).ToString("yyyy-MM-ddTHH:mm:ssZ");
        }

        /// <summary>What the server would say, for each page.</summary>
        private static Dictionary<string, object> Answer(string method, string path, object body)
        {
            if (path.StartsWith("/api/admin/organisations"))
            {
                return Parse("{'organisations':[" +
                    "{'id':'harbour-bowls','displayName':'Harbour Bowling Club','baseCurrency':'NZD','isActive':true,'provisioningStatus':'ready','migrationStatus':'ready','memberCount':4,'createdAt':'" + Ago(24 * 200) + "'}," +
                    "{'id':'kowhai-kindy','displayName':'Kōwhai Kindergarten Inc','baseCurrency':'NZD','isActive':true,'provisioningStatus':'ready','migrationStatus':'ready','memberCount':3,'createdAt':'" + Ago(24 * 120) + "'}," +
                    "{'id':'southern-paws','displayName':'Southern Paws Ltd','baseCurrency':'NZD','isActive':true,'provisioningStatus':'ready','migrationStatus':'ready','memberCount':2,'createdAt':'" + Ago(24 * 60) + "'}," +
                    "{'id':'farm-trust','displayName':'Coastal Farm Trust','baseCurrency':'NZD','isActive':true,'provisioningStatus':'ready','migrationStatus':'ready','memberCount':2,'createdAt':'" + Ago(24 * 20) + "'}," +
                    "{'id':'old-test','displayName':'Old test organisation','baseCurrency':'AUD','isActive':false,'provisioningStatus':'ready','migrationStatus':'ready','memberCount':1,'createdAt':'" + Ago(24 * 300) + "'}]}");
            }
            if (path.StartsWith("/api/admin/users"))
            {
                return Parse("{'users':[" +
                    "{'id':'1','displayName':'Jess','email':'jess@example.nz','isServerAdmin':true,'twoStepEnabled':true,'isActive':true,'organisationCount':4,'lastLoginAt':'" + Ago(0.2) + "'}," +
                    "{'id':'2','displayName':'Will','email':'will@example.nz','isServerAdmin':true,'twoStepEnabled':true,'isActive':true,'organisationCount':2,'lastLoginAt':'" + Ago(30) + "'}," +
                    "{'id':'3','displayName':'Kim (treasurer)','email':'kim@example.nz','isServerAdmin':false,'twoStepEnabled':true,'isActive':true,'organisationCount':1,'lastLoginAt':'" + Ago(100) + "'}," +
                    "{'id':'4','displayName':'Sam','email':'sam@example.nz','isServerAdmin':false,'twoStepEnabled':false,'isActive':true,'organisationCount':1,'lastLoginAt':null}," +
                    "{'id':'5','displayName':'Old login','email':'old@example.nz','isServerAdmin':false,'twoStepEnabled':true,'isActive':false,'organisationCount':0,'lastLoginAt':'" + Ago(24 * 90) + "'}]}");
            }
            if (path.StartsWith("/api/admin/backups"))
            {
                var ok = "'status':'ok'";
                return Parse("{'settings':{'enabled':true,'time':'02:00','folder':'C:\\\\Users\\\\Jess\\\\OneDrive\\\\Tohyee backups','defaultFolder':'C:\\\\ProgramData\\\\Tohyee\\\\backups','keySet':true}," +
                    "'status':[" +
                    "{'displayName':null,'lastGood':{'finishedAt':'" + Ago(7) + "','sizeBytes':81920},'latest':{" + ok + "}}," +
                    "{'displayName':'Harbour Bowling Club','lastGood':{'finishedAt':'" + Ago(7) + "','sizeBytes':2411724},'latest':{" + ok + "}}," +
                    "{'displayName':'Kōwhai Kindergarten Inc','lastGood':{'finishedAt':'" + Ago(7) + "','sizeBytes':3984588},'latest':{" + ok + "}}," +
                    "{'displayName':'Southern Paws Ltd','lastGood':{'finishedAt':'" + Ago(7) + "','sizeBytes':1258291},'latest':{" + ok + "}}]," +
                    "'files':[" +
                    "{'name':'harbour-bowls-2026-09-30.tohyee-backup','sizeBytes':2411724,'header':{'kind':'organisation','displayName':'Harbour Bowling Club','createdAt':'" + Ago(7) + "'}}," +
                    "{'name':'kowhai-kindy-2026-09-30.tohyee-backup','sizeBytes':3984588,'header':{'kind':'organisation','displayName':'Kōwhai Kindergarten Inc','createdAt':'" + Ago(7) + "'}}," +
                    "{'name':'southern-paws-2026-09-30.tohyee-backup','sizeBytes':1258291,'header':{'kind':'organisation','displayName':'Southern Paws Ltd','createdAt':'" + Ago(7) + "'}}," +
                    "{'name':'server-2026-09-30.tohyee-backup','sizeBytes':81920,'header':{'kind':'core','displayName':null,'createdAt':'" + Ago(7) + "'}}]," +
                    "'keyStatus':{'keySet':true,'savedCopyCheckedAt':'" + Ago(24 * 10) + "','savedCopyCheckedByEmail':'jess@example.nz'}}");
            }
            if (path.StartsWith("/api/admin/email"))
            {
                return Parse("{'email':{'configured':true,'host':'smtp.gmail.com','port':465,'username':'tohyee.alerts@gmail.com','hasPassword':true,'fromAddress':'tohyee.alerts@gmail.com','fromName':'Tohyee','secretsAvailable':true,'updatedAt':'" + Ago(24 * 30) + "'}}");
            }
            if (path == "/api/admin/analytics-folders")
            {
                return Parse("{'folders':[" +
                    "{'organisationId':'harbour-bowls','displayName':'Harbour Bowling Club','folder':'D:\\\\Reports\\\\Harbour','readable':true}," +
                    "{'organisationId':'kowhai-kindy','displayName':'Kōwhai Kindergarten Inc','folder':null,'readable':false}]}");
            }
            if (path.StartsWith("/api/admin/remote-access/tohyee-address") && method == "GET")
            {
                return Parse(ServiceAvailable
                    ? "{'addressService':{'url':'https://relay.tohyee.example','available':true,'message':null}}"
                    : "{'addressService':{'url':'https://relay.tohyee.example','available':false,'message':'" + RemoteAccessPage.NotAvailableYet.Replace("'", "\\u0027") + "'}}");
            }
            if (path.StartsWith("/api/admin/remote-access"))
            {
                return Parse(Remote);
            }
            if (path.StartsWith("/api/admin/updates"))
            {
                return Parse("{'currentVersion':'0.2.1','latestVersion':'0.3.0','updateAvailable':true,'releaseName':'Tohyee v0.3.0','publishedAt':'" + Ago(20) + "','releaseNotesUrl':'https://github.com/Willy-nz/Tohyee/releases/tag/v0.3.0','checkedAt':'" + Ago(3) + "','nextCheckAt':'" + Ago(-21) + "','checkError':null,"
                    + "'lastStart':{'version':'0.2.1','previousVersion':'0.2.0','startedAt':'" + Ago(77) + "','organisationsChecked':3,'organisationsUpgraded':3,'organisationsBlocked':0},"
                    + "'lastUpdate':{'version':'0.2.1','previousVersion':'0.2.0','startedAt':'" + Ago(77) + "','organisationsChecked':3,'organisationsUpgraded':3,'organisationsBlocked':[]},'blockedOrganisations':[],'platform':'win32'}");
            }
            if (path.StartsWith("/api/admin/sign-ins"))
            {
                return Parse("{'unseen':{'count':1,'reviewedAt':null},'events':[" +
                    "{'id':'5','at':'" + Ago(0.3) + "','email':'jess@example.nz','step':'code','outcome':'signed_in','detail':null,'address':'127.0.0.1','userAgent':'TohyeeTray/1.0','remote':false,'flag':null}," +
                    "{'id':'4','at':'" + Ago(5) + "','email':'kim@example.nz','step':'code','outcome':'signed_in','detail':null,'address':'203.0.113.9','userAgent':'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)','remote':true,'flag':'A new device or browser for this login'}," +
                    "{'id':'3','at':'" + Ago(26) + "','email':'sam@example.nz','step':'password','outcome':'failed','detail':null,'address':'198.51.100.4','userAgent':'Mozilla/5.0','remote':true,'flag':null}]}");
            }
            if (path.StartsWith("/api/admin/stats"))
            {
                return Stats();
            }
            if (path.StartsWith("/api/updates/latest-release"))
            {
                return Parse("{'currentVersion':'0.2.1','latestVersion':'0.2.1','updateAvailable':false,'release':{'name':'Tohyee 0.2.1','tagName':'v0.2.1','publishedAt':'" + Ago(26) + "','htmlUrl':'https://github.com/Willy-nz/Tohyee/releases/tag/v0.2.1','assets':[]}}");
            }
            return new Dictionary<string, object>();
        }

        /// <summary>A day of made-up readings for the Stats page: busy in working hours, quiet at night.</summary>
        internal static Dictionary<string, object> Stats()
        {
            var history = new List<object>();
            var now = DateTime.UtcNow;
            var random = new Random(7);
            for (var i = 24 * 60 - 1; i >= 0; i--)
            {
                var at = now.AddMinutes(-i);
                var hour = at.ToLocalTime().Hour;
                var busy = hour >= 8 && hour < 18 ? 1.0 : 0.15;
                var requests = (int)(busy * (20 + random.Next(40)));
                history.Add(new Dictionary<string, object>
                {
                    { "at", at.ToString("o") },
                    { "cpuPercent", Math.Round(busy * 18 + random.NextDouble() * 6, 1) },
                    { "tohyeeCpuPercent", Math.Round(busy * 4 + random.NextDouble(), 1) },
                    { "memoryUsedBytes", 9.1e9 + busy * 1.2e9 + random.Next(200000000) },
                    { "memoryTotalBytes", 16e9 },
                    { "tohyeeMemoryBytes", 3.4e8 + busy * 6e7 },
                    { "requests", requests },
                    { "serverErrors", random.Next(400) == 0 ? 1 : 0 },
                    { "averageMs", requests > 0 ? (object)(35 + random.Next(30)) : null },
                    { "slowestMs", requests > 0 ? (object)(120 + random.Next(300)) : null },
                    { "activeUsers", (int)(busy * 4) },
                    { "databaseConnections", 6 + (int)(busy * 4) },
                });
            }
            Func<string, string, double, Dictionary<string, object>> database = (id, name, size) => new Dictionary<string, object> { { "organisationId", id }, { "name", name }, { "sizeBytes", size } };
            return new Dictionary<string, object>
            {
                { "version", "0.2.1" },
                { "startedAt", now.AddHours(-77).ToString("o") },
                { "uptimeSeconds", 77 * 3600 },
                { "computer", new Dictionary<string, object> { { "platform", "Windows_NT 10.0.26100" }, { "cpuModel", "Intel(R) Core(TM) i5-12400" }, { "cores", 12 }, { "memoryTotalBytes", 16e9 }, { "computerUptimeSeconds", 9 * 86400 } } },
                { "nodeVersion", "v22.22.0" },
                { "postgresVersion", "17.6" },
                { "sampleEverySeconds", 60 },
                { "current", history[history.Count - 1] },
                { "history", history },
                { "disks", new List<object> { new Dictionary<string, object> { { "label", "Tohyee's program and backups" }, { "path", @"C:\ProgramData\Tohyee\backups" }, { "freeBytes", 212e9 }, { "totalBytes", 476e9 } } } },
                { "databases", new Dictionary<string, object> { { "at", now.AddMinutes(-6).ToString("o") }, { "totalBytes", 251e6 }, { "list", new List<object> { database(null, "Server (users and settings)", 9e6), database("kelly-farm", "Kelly Farm Ltd", 168e6), database("jess-consulting", "Jess Consulting", 74e6) } } } },
                { "people", new Dictionary<string, object> { { "activeNow", 3 }, { "activeLast24Hours", 5 }, { "signedIn", 6 }, { "users", 8 } } },
                { "organisations", new Dictionary<string, object> { { "ready", 2 }, { "blocked", 0 } } },
            };
        }
    }

    /// <summary>Tailscale for the screenshots: a fixed state, nothing run.</summary>
    internal sealed class DemoTailscale : ITailscale
    {
        public PhoneState State;

        public Task<TailscaleStatus> GetStatus(int port)
        {
            return Task.FromResult(new TailscaleStatus
            {
                State = State,
                Version = State == PhoneState.NotInstalled ? null : "1.102.4",
                DnsName = State == PhoneState.NotInstalled ? null : "tohyee-pc.tail1a2b3c.ts.net",
            });
        }

        public Task Install(Action<string> progress) { return Task.FromResult(0); }
        public Task LogIn(Action<string> openUrl) { return Task.FromResult(0); }
        public Task FunnelOn(int port, Action<string> openUrl) { return Task.FromResult(0); }
        public Task FunnelOff() { return Task.FromResult(0); }
    }

    /// <summary>Cloudflare for the screenshots: nothing run.</summary>
    internal sealed class DemoCloudflare : ICloudflare
    {
        public Task LogIn(Action<string, bool> onUrl, CancellationToken cancel) { return Task.FromResult(0); }
        public Task<string> SignedInDomain() { return Task.FromResult("example.nz"); }

        public Task<CloudflareTunnel> Connect(string tunnelName, string hostname, Action<string> progress, CancellationToken cancel)
        {
            return Task.FromResult(new CloudflareTunnel { TunnelId = "6ff42ae2-765d-4adf-8112-31c55c1551ef", Token = "eyJ…", Hostname = hostname });
        }

        public void Forget() { }
    }
}

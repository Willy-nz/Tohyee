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
                foreach (var page in new[] { "home", "organisations", "users", "backups", "email", "updates" })
                {
                    form.Navigate(page);
                    Pump();
                    Save(form, folder, Name(page));
                }

                // Phone access: the chooser, then each way on or part-way through.
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
            var order = new[] { "home", "organisations", "users", "phone", "backups", "email", "updates" };
            return (Array.IndexOf(order, page) + 1) + "-" + page;
        }

        private static void Pump()
        {
            for (var i = 0; i < 40; i++)
            {
                Application.DoEvents();
                Thread.Sleep(15);
            }
        }

        private static void Save(Form form, string folder, string name)
        {
            using (var bitmap = new Bitmap(form.ClientSize.Width, form.ClientSize.Height))
            {
                if (Type.GetType("Mono.Runtime") != null)
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
                new NewsItem { Kind = "announcement", Date = "2026-09-20", Title = "Phone access is getting easier", Body = "The next server app gives you three ways to use Tohyee from your phone, including a Tohyee address in one click. Then scan a QR code." },
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
            if (path.StartsWith("/api/updates/latest-release"))
            {
                return Parse("{'currentVersion':'0.2.1','latestVersion':'0.2.1','updateAvailable':false,'release':{'name':'Tohyee 0.2.1','tagName':'v0.2.1','publishedAt':'" + Ago(26) + "','htmlUrl':'https://github.com/Willy-nz/Tohyee/releases/tag/v0.2.1','assets':[]}}");
            }
            return new Dictionary<string, object>();
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

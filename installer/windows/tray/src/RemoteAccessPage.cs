using System;
using System.Collections.Generic;
using System.Drawing;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace Tohyee.Tray
{
    /// <summary>
    /// Remote access: use Tohyee from anywhere. Three ways, in this order, and
    /// only one on at a time (switching asks first and turns the other off):
    ///
    /// 1. A Tohyee address (recommended for most): one click, no sign-up. The
    ///    server asks the Tohyee address service for an address and a Cloudflare
    ///    tunnel token, and runs Cloudflare's connector with it.
    /// 2. Your own domain (Cloudflare): Connect to Cloudflare signs in to
    ///    Cloudflare in the browser, makes a tunnel, adds the address to the
    ///    domain's DNS and gives the tunnel's token to the server, which runs the
    ///    connector. Pasting a tunnel token is kept as a fallback.
    /// 3. Tailscale Funnel: set up here (installing Tailscale if needed).
    ///    Businesses need a paid Tailscale plan.
    ///
    /// Each shows the address big with a QR code, Copy, Open and Turn off. All
    /// need two-step sign-in in force on the server (the server enforces it).
    /// Network and program calls run off the UI thread with time limits.
    /// </summary>
    internal sealed class RemoteAccessPage : UserControl
    {
        private enum Way
        {
            None,
            Tohyee,
            Cloudflare,
            Tailscale,
        }

        private enum CloudStage
        {
            Idle,
            SigningIn,
            Choose,
            Working,
        }

        private static readonly Dictionary<string, string> StatusLabels = new Dictionary<string, string>
        {
            { "off", "Off" },
            { "starting", "Starting…" },
            { "connected", "On" },
            { "reconnecting", "Reconnecting…" },
            { "error", "Not working" },
            { "missing_program", "cloudflared is missing" },
        };

        private const string TwoStepMessage = "Remote access can't be turned on until two-step sign-in is in force, and that needs TOHYEE_SECRET_KEY set on the server. The Windows installer sets it when you update Tohyee.";
        internal const string NotAvailableYet = "The Tohyee address service isn't available yet.";

        private readonly TohyeeApi _api;
        private readonly TraySettings _settings;
        private readonly ITailscale _tailscale;
        private readonly ICloudflare _cloudflare;
        private readonly PageFlow _page;
        private readonly System.Windows.Forms.Timer _refresh = new System.Windows.Forms.Timer { Interval = 5000 };
        private Dictionary<string, object> _remote;
        private TailscaleStatus _tailscaleStatus = new TailscaleStatus { State = PhoneState.Checking };
        private bool? _serviceAvailable;
        private string _serviceMessage;
        private bool _working;

        private readonly Section _tohyee;
        private readonly Section _cloud;
        private readonly Section _ts;

        // Tohyee address
        private readonly FlowLayoutPanel _tohyeeButtons = Ui.Row();
        private readonly Button _tohyeeGet;
        private readonly Button _tohyeeRelease;
        private readonly Button _tohyeeCheck;

        // Your own domain (Cloudflare)
        private CloudStage _stage = CloudStage.Idle;
        private CancellationTokenSource _cloudCancel;
        private string _signInUrl;
        private readonly FlowLayoutPanel _cloudIdle = Ui.Row();
        private readonly Button _connect;
        private readonly Button _turnBackOn;
        private readonly FlowLayoutPanel _cloudSignIn = Ui.Row();
        private readonly FlowLayoutPanel _cloudChoose = Stack();
        private readonly TextBox _name = new TextBox { Text = "books" };
        private readonly TextBox _domain = new TextBox();
        private readonly Label _preview = new Label { Font = Theme.F("Segoe UI Semibold", 15f), ForeColor = Theme.AccentText, AutoSize = true, Margin = new Padding(0, 2, 0, 4) };
        private readonly Label _previewHint = new Label { ForeColor = Theme.Muted, AutoSize = true, Tag = "wrap", Margin = new Padding(0, 0, 0, 8) };
        private readonly Button _useAddress;
        private readonly FlowLayoutPanel _cloudOnExtras = Ui.Row();
        private readonly TextBox _log = new TextBox { Multiline = true, ReadOnly = true, ScrollBars = ScrollBars.Vertical, Height = Theme.S(140), Font = Theme.F("Consolas", 8.5f), Visible = false, Tag = "stretch" };
        private readonly FlowLayoutPanel _paste = Stack();
        private readonly Button _pasteToggle;
        private readonly TextBox _token = new TextBox { Multiline = true, Height = Theme.S(60), Font = Theme.Mono };
        private readonly Label _tokenHint = new Label { AutoSize = true, ForeColor = Theme.Muted, MaximumSize = new Size(Theme.S(420), 0) };
        private readonly TextBox _publicUrl = new TextBox();
        private readonly Label _steps = new Label { AutoSize = true, Tag = "wrap", ForeColor = Theme.Muted, Margin = new Padding(0, 4, 0, 10) };
        private bool _hasToken;

        // Tailscale Funnel
        private readonly FlowLayoutPanel _tsButtons = Ui.Row();
        private readonly Button _tsSetUp;

        public RemoteAccessPage(TohyeeApi api, TraySettings settings, ITailscale tailscale, ICloudflare cloudflare)
        {
            _api = api;
            _settings = settings;
            _tailscale = tailscale;
            _cloudflare = cloudflare;
            BackColor = Theme.Bg;
            _page = Ui.Page("Remote access", "Use Tohyee from your phone or laptop anywhere, with a proper https address and nothing to change on your router. Choose one of three ways. Everyone still signs in with their password and authenticator app.");

            // ---- 1. Tohyee address
            _tohyee = new Section(_page, "RECOMMENDED FOR MOST", Theme.AccentText, "Tohyee address", (s, e) => CopyAddress(_tohyee), async (s, e) => await TurnOffTohyee());
            _tohyeeGet = Ui.Primary("Get a Tohyee address", async (s, e) => await TurnOnTohyee());
            _tohyeeButtons.Controls.Add(_tohyeeGet);
            _tohyeeCheck = Ui.Btn("Check again", async (s, e) => await CheckService());
            _tohyeeButtons.Controls.Add(_tohyeeCheck);
            _tohyeeRelease = Ui.Btn("Give this address back", async (s, e) => await ReleaseTohyee());
            _tohyeeButtons.Controls.Add(_tohyeeRelease);
            _tohyee.Body.Controls.Add(_tohyeeButtons);
            _tohyee.AddStatusAndNote("Run by the Tohyee project. Your books stay on this computer, but the traffic passes through Cloudflare's network, where Cloudflare can read it (under Cloudflare's privacy policy), and whoever runs the Tohyee address's Cloudflare account decides where the address points.");

            // ---- 2. Your own domain (Cloudflare)
            _cloud = new Section(_page, "FREE FOR BUSINESSES", Theme.Muted, "Your own domain (Cloudflare)", (s, e) => CopyAddress(_cloud), async (s, e) => await TurnOffCloudflare());
            _connect = Ui.Primary("Connect to Cloudflare", async (s, e) => await ConnectCloudflare());
            _turnBackOn = Ui.Btn("Turn back on", async (s, e) => await TurnBackOnCloudflare());
            _cloudIdle.Controls.Add(_connect);
            _cloudIdle.Controls.Add(_turnBackOn);
            _pasteToggle = Ui.Btn("Paste a tunnel token instead", (s, e) => TogglePaste());
            _cloudIdle.Controls.Add(_pasteToggle);
            _cloud.Body.Controls.Add(_cloudIdle);

            _cloudSignIn.Controls.Add(Ui.Btn("Open the sign-in page again", (s, e) => { if (_signInUrl != null) TrayApp.Open(_signInUrl); }));
            _cloudSignIn.Controls.Add(Ui.Btn("Cancel", (s, e) => CancelCloudflare()));
            _cloud.Body.Controls.Add(_cloudSignIn);

            var nameRow = new FlowLayoutPanel { AutoSize = true, WrapContents = false, BackColor = Theme.Card, Margin = new Padding(0, 0, 0, 6) };
            _name.Width = Theme.S(150);
            _domain.Width = Theme.S(240);
            nameRow.Controls.Add(Labelled("Name", Ui.Input(_name)));
            nameRow.Controls.Add(new Label { Text = ".", Font = Theme.CardTitle, ForeColor = Theme.Muted, AutoSize = true, Margin = new Padding(Theme.S(4), Theme.S(26), Theme.S(4), 0) });
            nameRow.Controls.Add(Labelled("Your domain on Cloudflare", Ui.Input(_domain)));
            _cloudChoose.Controls.Add(nameRow);
            _cloudChoose.Controls.Add(new Label { Text = "YOUR PHONE ADDRESS WILL BE", Font = Theme.SmallCaps, ForeColor = Theme.Muted, AutoSize = true, Margin = new Padding(0, 6, 0, 2) });
            _cloudChoose.Controls.Add(_preview);
            _cloudChoose.Controls.Add(_previewHint);
            var chooseButtons = Ui.Row();
            _useAddress = Ui.Primary("Use this address", async (s, e) => await CreateCloudflare());
            chooseButtons.Controls.Add(_useAddress);
            chooseButtons.Controls.Add(Ui.Btn("Cancel", (s, e) => CancelCloudflare()));
            _cloudChoose.Controls.Add(chooseButtons);
            _cloud.Body.Controls.Add(_cloudChoose);
            _name.TextChanged += (s, e) => UpdatePreview();
            _domain.TextChanged += (s, e) => UpdatePreview();

            _cloudOnExtras.Controls.Add(Ui.Btn("Restart connector", async (s, e) => await Restart()));
            _cloudOnExtras.Controls.Add(Ui.Btn("Show connector log", (s, e) => { _log.Visible = !_log.Visible; _cloud.Card.Refit(); }));
            _cloud.Body.Controls.Add(_cloudOnExtras);
            _cloud.Body.Controls.Add(Ui.Input(_log));

            _paste.Controls.Add(new Label { Text = "Paste a tunnel token", Font = Theme.Strong, ForeColor = Theme.Text, AutoSize = true, Margin = new Padding(0, 12, 0, 2) });
            _paste.Controls.Add(_steps);
            var form = Ui.Form();
            Ui.Field(form, "Tunnel token", _token);
            form.RowCount += 1;
            form.Controls.Add(new Label());
            form.Controls.Add(_tokenHint);
            Ui.Field(form, "Public address", _publicUrl);
            _paste.Controls.Add(form);
            var save = Ui.Row();
            save.Controls.Add(Ui.Primary("Save and turn on", async (s, e) => await SavePasted()));
            _paste.Controls.Add(save);
            _paste.Visible = false;
            _cloud.Body.Controls.Add(_paste);
            _cloud.AddStatusAndNote("Tohyee keeps the tunnel's key (encrypted), never your Cloudflare login. The traffic passes through Cloudflare's network, where Cloudflare can read it (under Cloudflare's privacy policy); your books stay on this computer.");

            // ---- 3. Tailscale Funnel
            _ts = new Section(_page, "PAID PLAN FOR BUSINESSES", Theme.Warning, "Tailscale Funnel", (s, e) => CopyAddress(_ts), async (s, e) => await TurnOffTailscale());
            _tsSetUp = Ui.Primary("Set up Tailscale Funnel", async (s, e) => await TurnOnTailscale());
            _tsButtons.Controls.Add(_tsSetUp);
            _tsButtons.Controls.Add(Ui.Btn("Check again", async (s, e) => await ReloadTailscale()));
            _ts.Body.Controls.Add(_tsButtons);
            _ts.AddStatusAndNote("Tailscale gives this computer an address like https://your-computer.your-tailnet.ts.net. You sign in to Tailscale once in your browser; Tohyee never sees or keeps that login. The traffic stays encrypted until it reaches this computer: Tailscale's relay doesn't decrypt it.");
            var pricing = new LinkLabel
            {
                Text = "The simplest set-up, but Tailscale's free plan is for non-commercial use only; businesses need a paid Tailscale plan (from US$8 per user a month). See tailscale.com/pricing",
                AutoSize = true,
                Tag = "wrap",
                ForeColor = Theme.Text,
                LinkColor = Theme.AccentText,
                ActiveLinkColor = Theme.AccentHover,
                VisitedLinkColor = Theme.AccentText,
                LinkBehavior = LinkBehavior.HoverUnderline,
                Margin = new Padding(0, 0, 0, 10),
            };
            pricing.LinkArea = new LinkArea(pricing.Text.IndexOf("tailscale.com/pricing", StringComparison.Ordinal), "tailscale.com/pricing".Length);
            pricing.LinkClicked += (s, e) => TrayApp.Open("https://tailscale.com/pricing");
            _ts.Body.Controls.Add(pricing);
            _ts.Body.Controls.SetChildIndex(pricing, _ts.Body.Controls.IndexOf(_ts.Detail) + 1);

            Controls.Add(_page);
            ShowAll();
            Load += async (s, e) =>
            {
                await Reload();
                await Task.WhenAll(CheckService(), ReloadTailscale());
            };
            _refresh.Tick += async (s, e) => await RefreshQuietly();
            VisibleChanged += (s, e) => _refresh.Enabled = Visible && !_api.IsDemo;
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                _refresh.Dispose();
                if (_cloudCancel != null) _cloudCancel.Cancel();
            }
            base.Dispose(disposing);
        }

        private static FlowLayoutPanel Stack()
        {
            return new FlowLayoutPanel { FlowDirection = FlowDirection.TopDown, WrapContents = false, AutoSize = true, BackColor = Theme.Card, Margin = new Padding(0), Tag = "stretch" };
        }

        private static Control Labelled(string label, Control field)
        {
            var box = new FlowLayoutPanel { FlowDirection = FlowDirection.TopDown, WrapContents = false, AutoSize = true, BackColor = Theme.Card, Margin = new Padding(0) };
            box.Controls.Add(new Label { Text = label, ForeColor = Theme.Muted, AutoSize = true, Margin = new Padding(0, 0, 0, 4) });
            field.Margin = new Padding(0);
            box.Controls.Add(field);
            return box;
        }

        private int Port
        {
            get { return _settings.Port; }
        }

        private bool TwoStepInForce
        {
            get { return _remote != null && J.Bool(_remote, "twoStepRequired"); }
        }

        private string Method
        {
            get { return J.Str(_remote, "method") ?? "cloudflare"; }
        }

        private string TunnelStatus
        {
            get { return J.Str(J.Obj(_remote, "tunnel"), "status") ?? "off"; }
        }

        /// <summary>Which way is on: what the server has saved, or Tailscale Funnel if it's on for Tohyee's port.</summary>
        private Way ActiveWay
        {
            get
            {
                if (_remote != null && J.Bool(_remote, "enabled"))
                {
                    if (Method == "tohyee") return Way.Tohyee;
                    if (Method == "tailscale") return Way.Tailscale;
                    if (J.Bool(_remote, "hasToken")) return Way.Cloudflare;
                }
                return _tailscaleStatus.State == PhoneState.On ? Way.Tailscale : Way.None;
            }
        }

        private static string WayName(Way way)
        {
            switch (way)
            {
                case Way.Tohyee: return "your Tohyee address";
                case Way.Cloudflare: return "your own domain (Cloudflare)";
                case Way.Tailscale: return "Tailscale Funnel";
                default: return "nothing";
            }
        }

        // ------------------------------------------------------------ showing

        private void ShowAll()
        {
            ShowTohyee();
            ShowCloudflare();
            ShowTailscale();
        }

        private void ShowTunnelState(Section section, string address)
        {
            var status = TunnelStatus;
            string label;
            if (!StatusLabels.TryGetValue(status, out label)) label = status;
            var colour = status == "connected" ? Theme.Success : status == "error" || status == "missing_program" ? Theme.Danger : Theme.Warning;
            var message = J.Str(J.Obj(_remote, "tunnel"), "message");
            section.ShowOn(label, colour, address,
                status == "connected" ? "Tohyee is reachable from anywhere at this address, while this computer is on. It stays on when the computer restarts."
                : message ?? "Cloudflare's connector is starting. This takes a few seconds.");
        }

        private void ShowTohyee()
        {
            var address = J.Str(_remote, "tohyeeAddress");
            var active = ActiveWay;
            if (active == Way.Tohyee)
            {
                ShowTunnelState(_tohyee, J.Str(_remote, "publicUrl") ?? address);
                _tohyeeButtons.Visible = false;
            }
            else
            {
                _tohyeeButtons.Visible = true;
                _tohyeeRelease.Visible = address != null;
                _tohyeeGet.Text = active != Way.None ? "Switch to a Tohyee address" : address != null ? "Turn on " + Host(address) : "Get a Tohyee address";
                Section.Emphasise(_tohyeeGet, active == Way.None);
                _tohyeeCheck.Visible = _serviceAvailable == false && address == null;
                string state = "Off";
                string detail = "One click, no sign-up: Tohyee gets an address like https://k7m2q9.tohyee.example and connects it to this computer through Cloudflare's network.";
                var colour = Theme.Muted;
                if (address != null) detail = "This computer's Tohyee address is " + address + ". Turn it on to use it again.";
                if (_serviceAvailable == false && address == null)
                {
                    state = "Not available yet";
                    detail = (_serviceMessage ?? NotAvailableYet) + " Use one of the other ways for now, or check again later.";
                    colour = Theme.Warning;
                }
                _tohyeeGet.Enabled = !_working && (_serviceAvailable != false || address != null);
                if (_remote != null && !TwoStepInForce)
                {
                    detail = TwoStepMessage;
                    colour = Theme.Danger;
                }
                _tohyee.ShowOff(state, colour, detail);
            }
            _tohyee.Refit(active == Way.Tohyee);
        }

        private void ShowCloudflare()
        {
            var active = ActiveWay;
            var on = active == Way.Cloudflare;
            _cloudIdle.Visible = !on && _stage == CloudStage.Idle;
            _cloudSignIn.Visible = !on && _stage == CloudStage.SigningIn;
            _cloudChoose.Visible = !on && _stage == CloudStage.Choose;
            _cloudOnExtras.Visible = on;
            _log.Visible = _log.Visible && on;
            _paste.Visible = _paste.Visible && _stage == CloudStage.Idle;
            _pasteToggle.Text = _paste.Visible ? "Hide the tunnel token form" : "Paste a tunnel token instead";

            var publicUrl = J.Str(_remote, "publicUrl");
            _hasToken = J.Bool(_remote, "hasToken");
            _turnBackOn.Visible = !on && _hasToken && Method == "cloudflare" && publicUrl != null;
            if (_turnBackOn.Visible) _turnBackOn.Text = "Turn back on " + Host(publicUrl);
            _connect.Text = active != Way.None && !on ? "Switch to your own domain" : "Connect to Cloudflare";
            Section.Emphasise(_connect, active == Way.None);
            _log.Text = string.Join("\r\n", J.Strings(J.Obj(_remote, "tunnel"), "log"));
            _tokenHint.Text = _hasToken
                ? "Saved (tunnel " + (J.Str(_remote, "tunnelId") ?? "unknown") + "). Leave blank to keep it."
                : "Paste the install command Cloudflare shows, or just the long code starting eyJ.";
            var localService = J.Str(_remote, "localService") ?? "http://127.0.0.1:" + Port;
            _steps.Text =
                "In Cloudflare's dashboard: Networking → Tunnels (older accounts: Zero Trust → Networks → Tunnels) → Create a tunnel, pick Windows, and copy the install command (don't run it: Tohyee runs the connector). " +
                "On the tunnel's Routes tab, add a published application on your domain with the service URL " + localService + ". Paste the command below with that address.";

            if (on)
            {
                ShowTunnelState(_cloud, publicUrl);
            }
            else
            {
                string state = "Off";
                string detail = "Use an address on your own domain, like https://books.example.nz. You need a domain on Cloudflare (Cloudflare's free plan is enough). Connect to Cloudflare signs you in, makes the tunnel and adds the address for you.";
                var colour = Theme.Muted;
                switch (_stage)
                {
                    case CloudStage.SigningIn:
                        state = "Waiting for you to sign in to Cloudflare…";
                        detail = "Your browser opened Cloudflare. Sign in, click the domain to use for Tohyee, then press Authorise. This page carries on by itself.";
                        colour = Theme.Warning;
                        break;
                    case CloudStage.Choose:
                        state = "Signed in to Cloudflare";
                        detail = "Choose the address. The name can be anything not already used on your domain.";
                        colour = Theme.Success;
                        break;
                    case CloudStage.Working:
                        colour = Theme.Warning;
                        state = _cloud.StateText;
                        detail = "Setting up " + _preview.Text + " on your Cloudflare account.";
                        break;
                }
                if (_stage == CloudStage.Idle && _remote != null && !TwoStepInForce)
                {
                    detail = TwoStepMessage;
                    colour = Theme.Danger;
                }
                _cloud.ShowOff(state, colour, detail);
            }
            _cloud.Refit(on);
        }

        private void ShowTailscale()
        {
            var status = _tailscaleStatus;
            var on = status.State == PhoneState.On;
            _tsButtons.Visible = !on;
            string state;
            string detail;
            var colour = Theme.Muted;
            var switching = ActiveWay != Way.None && ActiveWay != Way.Tailscale;
            _tsSetUp.Text = switching ? "Switch to Tailscale Funnel" : "Set up Tailscale Funnel";
            Section.Emphasise(_tsSetUp, !switching);
            switch (status.State)
            {
                case PhoneState.Checking:
                    state = "Checking…";
                    detail = "Asking Tailscale how things are.";
                    break;
                case PhoneState.NotInstalled:
                    state = "Off";
                    detail = "Set up installs Tailscale on this computer (Windows asks for permission), signs you in to Tailscale in your browser, and turns on Funnel for Tohyee. It takes a couple of minutes.";
                    break;
                case PhoneState.NotRunning:
                    state = "Tailscale isn't running";
                    detail = "Tailscale is installed, but its Windows service isn't answering. Set up tries to start it (Windows asks for permission).";
                    colour = Theme.Warning;
                    break;
                case PhoneState.SignedOut:
                    state = "Off: Tailscale isn't signed in";
                    detail = status.Problem ?? "Set up opens Tailscale's sign-in page in your browser, then turns on Funnel for Tohyee.";
                    break;
                case PhoneState.Off:
                    state = "Off";
                    detail = "Tailscale is ready" + (status.DnsName != null ? " (this computer is " + status.DnsName + ")" : "") + ". Turning on Funnel makes Tohyee reachable at that address from anywhere.";
                    if (!switching) _tsSetUp.Text = "Turn on Tailscale Funnel";
                    break;
                case PhoneState.OtherFunnel:
                    state = "Funnel is on for something else";
                    detail = "Tailscale Funnel on this computer points at a different program, not Tohyee on port " + Port + ". Turning it on points it at Tohyee instead.";
                    colour = Theme.Warning;
                    break;
                case PhoneState.On:
                    state = "On";
                    detail = "Tohyee is reachable from anywhere through Tailscale Funnel. It stays on when the computer restarts.";
                    break;
                default:
                    state = "Tailscale has a problem";
                    detail = status.Problem ?? "Tailscale didn't answer as expected.";
                    colour = Theme.Danger;
                    break;
            }
            if (on)
            {
                _ts.ShowOn(state, Theme.Success, status.Address, detail + (status.Version != null ? " Tailscale " + status.Version + "." : ""));
            }
            else
            {
                if (_remote != null && !TwoStepInForce)
                {
                    detail = TwoStepMessage;
                    colour = Theme.Danger;
                }
                _ts.ShowOff(state, colour, detail);
            }
            _ts.Refit(on);
        }

        private static string Host(string url)
        {
            if (url == null) return "";
            return Regex.Replace(url, "^https?://", "");
        }

        // ------------------------------------------------------------ loading

        private async Task Reload()
        {
            try
            {
                _remote = J.Obj(await _api.Get("/api/admin/remote-access"), "remoteAccess");
                ShowAll();
            }
            catch (ApiException error)
            {
                Ui.Show(_tohyee.Status, error.Message, true);
            }
        }

        private async Task RefreshQuietly()
        {
            if (_working || _stage != CloudStage.Idle || !Visible) return;
            var way = ActiveWay;
            // Only while a connector is starting or unwell, so the status catches up.
            if ((way != Way.Tohyee && way != Way.Cloudflare) || TunnelStatus == "connected") return;
            try
            {
                _remote = J.Obj(await _api.Get("/api/admin/remote-access"), "remoteAccess");
                ShowTohyee();
                ShowCloudflare();
            }
            catch (ApiException)
            {
                // Shown on the next deliberate reload.
            }
        }

        private async Task CheckService()
        {
            try
            {
                var health = J.Obj(await _api.Get("/api/admin/remote-access/tohyee-address"), "addressService");
                _serviceAvailable = J.Bool(health, "available");
                _serviceMessage = J.Str(health, "message");
            }
            catch (ApiException error)
            {
                _serviceAvailable = null;
                _serviceMessage = error.Message;
            }
            ShowTohyee();
        }

        private async Task ReloadTailscale()
        {
            if (_working) return;
            try
            {
                _tailscaleStatus = await _tailscale.GetStatus(Port);
            }
            catch (Exception error)
            {
                _tailscaleStatus = new TailscaleStatus { State = PhoneState.Problem, Problem = error.Message };
            }
            ShowAll();
        }

        /// <summary>
        /// Before turning a way on: the server's two-step rule (checked here too, so
        /// nothing is set up for nothing), and asking before switching from another way.
        /// Returns the way that was on (to turn off afterwards), or null to stop.
        /// </summary>
        private async Task<Way?> ReadyToTurnOn(Way way, Section section)
        {
            section.Status.Text = "";
            try
            {
                _remote = J.Obj(await _api.Get("/api/admin/remote-access"), "remoteAccess");
            }
            catch (ApiException error)
            {
                Ui.Show(section.Status, error.Message, true);
                return null;
            }
            if (!TwoStepInForce)
            {
                ShowAll();
                Ui.Show(section.Status, TwoStepMessage, true);
                return null;
            }
            var active = ActiveWay;
            if (active != Way.None && active != way)
            {
                if (!Ui.Confirm(FindForm(), "Switch remote access from " + WayName(active) + " to " + WayName(way) + "? Only one way can be on, so " + WayName(active) + " is turned off (its settings are kept, so you can switch back).")) return null;
            }
            return active;
        }

        /// <summary>After switching: Tailscale Funnel is Tailscale's, so the server can't turn it off; this does.</summary>
        private async Task TurnOffPrevious(Way previous, Way now)
        {
            if (previous != Way.Tailscale || now == Way.Tailscale) return;
            try
            {
                await _tailscale.FunnelOff();
            }
            catch (TailscaleException error)
            {
                Ui.Show(_ts.Status, "Tailscale Funnel is still on: " + error.Message, true);
            }
            await ReloadTailscale();
        }

        private void CopyAddress(Section section)
        {
            try
            {
                Clipboard.SetText(section.AddressText);
                Ui.Show(section.Status, "Copied " + section.AddressText + ".", false);
            }
            catch (Exception)
            {
                Ui.Show(section.Status, "The clipboard was busy. Try again.", true);
            }
        }

        private async Task Put(Dictionary<string, object> body)
        {
            _remote = J.Obj(await _api.Put("/api/admin/remote-access", body), "remoteAccess");
        }

        // ------------------------------------------------------------ 1. Tohyee address

        private async Task TurnOnTohyee()
        {
            if (_working) return;
            var previous = await ReadyToTurnOn(Way.Tohyee, _tohyee);
            if (previous == null) return;
            _working = true;
            _tohyeeGet.Enabled = false;
            _tohyee.Working(J.Str(_remote, "tohyeeAddress") != null ? "Turning on…" : "Getting your address…");
            try
            {
                _remote = J.Obj(await _api.Post("/api/admin/remote-access/tohyee-address", null), "remoteAccess");
                _serviceAvailable = true;
                _working = false;
                ShowAll();
                Ui.Show(_tohyee.Status, "Remote access is on. Scan the code with your phone.", false);
                await TurnOffPrevious(previous.Value, Way.Tohyee);
            }
            catch (ApiException error)
            {
                _working = false;
                if (error.Message == NotAvailableYet) _serviceAvailable = false;
                ShowAll();
                Ui.Show(_tohyee.Status, error.Message, true);
            }
            finally
            {
                _working = false;
                ShowTohyee();
            }
        }

        private async Task TurnOffTohyee()
        {
            if (_working) return;
            if (!Ui.Confirm(FindForm(), "Turn off remote access? Tohyee stops being reachable at " + _tohyee.AddressText + ". It keeps working on this computer and your network, and the address is kept for next time.")) return;
            await Ui.Busy(_tohyee.Card, _tohyee.Status, async () =>
            {
                await Put(new Dictionary<string, object> { { "method", "tohyee" }, { "enabled", false } });
                ShowAll();
                Ui.Show(_tohyee.Status, "Remote access is off.", false);
            });
        }

        private async Task ReleaseTohyee()
        {
            if (_working) return;
            if (!Ui.Confirm(FindForm(), "Give this Tohyee address back? It stops working, and if you want one again later it may be different.")) return;
            await Ui.Busy(_tohyee.Card, _tohyee.Status, async () =>
            {
                _remote = J.Obj(await _api.Delete("/api/admin/remote-access/tohyee-address"), "remoteAccess");
                ShowAll();
                Ui.Show(_tohyee.Status, "The address was given back.", false);
            });
        }

        // ------------------------------------------------------------ 2. Your own domain (Cloudflare)

        private void TogglePaste()
        {
            _paste.Visible = !_paste.Visible;
            ShowCloudflare();
        }

        private void UpdatePreview()
        {
            var host = PreviewHost();
            _preview.Text = host != null ? "https://" + host : "https://" + (_name.Text.Trim().Length > 0 ? _name.Text.Trim().ToLowerInvariant() : "name") + "." + (_domain.Text.Trim().Length > 0 ? _domain.Text.Trim().ToLowerInvariant() : "your-domain");
            _preview.ForeColor = host != null ? Theme.AccentText : Theme.Muted;
            _previewHint.Text = host != null
                ? "Tohyee makes a tunnel called tohyee-" + NameOf() + " on your Cloudflare account and adds " + host + " to your domain's DNS. It never changes records you already have."
                : "The name is letters, numbers and dashes; the domain is the one you clicked when signing in (like example.nz).";
            _useAddress.Enabled = host != null && !_working;
        }

        private string NameOf()
        {
            return _name.Text.Trim().ToLowerInvariant();
        }

        /// <summary>name.domain if both look right, else null.</summary>
        private string PreviewHost()
        {
            var name = NameOf();
            var domain = _domain.Text.Trim().ToLowerInvariant().TrimEnd('.');
            if (domain.StartsWith("https://")) domain = domain.Substring(8);
            if (!Regex.IsMatch(name, "^[a-z0-9]([a-z0-9-]{0,40}[a-z0-9])?$")) return null;
            if (!Regex.IsMatch(domain, @"^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$")) return null;
            return name + "." + domain;
        }

        private void SetStage(CloudStage stage)
        {
            _stage = stage;
            ShowCloudflare();
        }

        private async Task ConnectCloudflare()
        {
            if (_working) return;
            var previous = await ReadyToTurnOn(Way.Cloudflare, _cloud);
            if (previous == null) return;
            _paste.Visible = false;
            _cloudCancel = new CancellationTokenSource();
            var cancel = _cloudCancel.Token;
            _signInUrl = null;
            SetStage(CloudStage.SigningIn);
            try
            {
                await _cloudflare.LogIn((url, opened) =>
                {
                    if (IsDisposed || !IsHandleCreated) return;
                    BeginInvoke((Action)(() =>
                    {
                        _signInUrl = url;
                        if (!opened) TrayApp.Open(url);
                    }));
                }, cancel);
                var domain = await _cloudflare.SignedInDomain();
                if (domain != null) _domain.Text = domain;
                UpdatePreview();
                SetStage(CloudStage.Choose);
                _pendingPrevious = previous.Value;
            }
            catch (OperationCanceledException)
            {
                SetStage(CloudStage.Idle);
            }
            catch (CloudflareException error)
            {
                SetStage(CloudStage.Idle);
                Ui.Show(_cloud.Status, error.Message, true);
            }
        }

        private Way _pendingPrevious = Way.None;

        private void CancelCloudflare()
        {
            if (_cloudCancel != null) _cloudCancel.Cancel();
            _cloudflare.Forget();
            SetStage(CloudStage.Idle);
            Ui.Show(_cloud.Status, "Cancelled. Nothing was changed on Cloudflare.", false);
        }

        private async Task CreateCloudflare()
        {
            var host = PreviewHost();
            if (host == null || _working) return;
            _working = true;
            _useAddress.Enabled = false;
            _cloud.Status.Text = "";
            var cancel = (_cloudCancel ?? new CancellationTokenSource()).Token;
            _stage = CloudStage.Working;
            try
            {
                var tunnel = await _cloudflare.Connect("tohyee-" + NameOf(), host, text => BeginInvoke((Action)(() =>
                {
                    _cloud.StateText = text;
                    ShowCloudflare();
                })), cancel);
                _cloud.StateText = "Starting the connector…";
                ShowCloudflare();
                // The server stores the token encrypted, refuses without two-step
                // sign-in, and runs the connector (sending the address to Tohyee's port).
                await Put(new Dictionary<string, object>
                {
                    { "method", "cloudflare" },
                    { "enabled", true },
                    { "tunnelToken", tunnel.Token },
                    { "publicUrl", "https://" + tunnel.Hostname },
                });
                _cloudflare.Forget();
                _stage = CloudStage.Idle;
                _working = false;
                ShowAll();
                Ui.Show(_cloud.Status, "Remote access is on at https://" + tunnel.Hostname + ". New addresses can take a minute or two to work everywhere.", false);
                await TurnOffPrevious(_pendingPrevious, Way.Cloudflare);
            }
            catch (OperationCanceledException)
            {
                _stage = CloudStage.Idle;
            }
            catch (CloudflareException error)
            {
                // Still signed in: fix the name and try again.
                _stage = CloudStage.Choose;
                Ui.Show(_cloud.Status, error.Message, true);
            }
            catch (ApiException error)
            {
                _stage = CloudStage.Choose;
                Ui.Show(_cloud.Status, error.Message, true);
            }
            finally
            {
                _working = false;
                ShowCloudflare();
                UpdatePreview();
            }
        }

        private async Task TurnBackOnCloudflare()
        {
            if (_working) return;
            var previous = await ReadyToTurnOn(Way.Cloudflare, _cloud);
            if (previous == null) return;
            var ok = await Ui.Busy(_cloud.Card, _cloud.Status, async () =>
            {
                await Put(new Dictionary<string, object> { { "method", "cloudflare" }, { "enabled", true } });
                ShowAll();
                Ui.Show(_cloud.Status, "Remote access is on.", false);
            });
            if (ok) await TurnOffPrevious(previous.Value, Way.Cloudflare);
        }

        private async Task SavePasted()
        {
            _cloud.Status.Text = "";
            var body = new Dictionary<string, object>
            {
                { "method", "cloudflare" },
                { "enabled", true },
                { "publicUrl", _publicUrl.Text.Trim() },
            };
            if (_token.Text.Trim().Length > 0) body["tunnelToken"] = _token.Text.Trim();
            else if (!_hasToken)
            {
                Ui.Show(_cloud.Status, "Paste the tunnel token from Cloudflare first.", true);
                return;
            }
            var previous = await ReadyToTurnOn(Way.Cloudflare, _cloud);
            if (previous == null) return;
            var ok = await Ui.Busy(_cloud.Card, _cloud.Status, async () =>
            {
                await Put(body);
                _token.Text = "";
                _paste.Visible = false;
                ShowAll();
                Ui.Show(_cloud.Status, "Saved. Remote access is on.", false);
            });
            if (ok) await TurnOffPrevious(previous.Value, Way.Cloudflare);
        }

        private async Task TurnOffCloudflare()
        {
            if (_working) return;
            if (!Ui.Confirm(FindForm(), "Turn off remote access? Tohyee stops being reachable at " + _cloud.AddressText + ". The tunnel stays on your Cloudflare account, so you can turn it back on.")) return;
            await Ui.Busy(_cloud.Card, _cloud.Status, async () =>
            {
                await Put(new Dictionary<string, object> { { "method", "cloudflare" }, { "enabled", false } });
                ShowAll();
                Ui.Show(_cloud.Status, "Remote access is off.", false);
            });
        }

        private async Task Restart()
        {
            await Ui.Busy(_cloud.Card, _cloud.Status, async () =>
            {
                _remote = J.Obj(await _api.Post("/api/admin/remote-access", null), "remoteAccess");
                ShowAll();
                Ui.Show(_cloud.Status, "The connector was restarted.", false);
            });
        }

        // ------------------------------------------------------------ 3. Tailscale Funnel

        /// <summary>Opens Tailscale's sign-in or approval page in the browser (from the CLI's output thread).</summary>
        private void OpenFromTailscale(string url, string waiting)
        {
            if (IsDisposed || !IsHandleCreated) return;
            BeginInvoke((Action)(() =>
            {
                _ts.Working(waiting);
                Ui.Show(_ts.Status, "Your browser opened " + url + ". Finish there; this page carries on by itself.", false);
                TrayApp.Open(url);
            }));
        }

        private async Task TurnOnTailscale()
        {
            if (_working) return;
            var previous = await ReadyToTurnOn(Way.Tailscale, _ts);
            if (previous == null) return;
            _working = true;
            _tsSetUp.Enabled = false;
            try
            {
                _ts.Working("Checking Tailscale…");
                var status = await _tailscale.GetStatus(Port);
                if (status.State == PhoneState.NotInstalled)
                {
                    if (!Ui.Confirm(FindForm(), "Install Tailscale?\n\nTohyee downloads the official Tailscale installer from pkgs.tailscale.com and installs it. Windows will ask for permission.\n\nTailscale's free plan is for non-commercial use only; businesses need a paid Tailscale plan."))
                    {
                        _working = false;
                        await ReloadTailscale();
                        return;
                    }
                    await _tailscale.Install(text => BeginInvoke((Action)(() => _ts.Working(text))));
                    status = await _tailscale.GetStatus(Port);
                }
                if (status.State == PhoneState.NotRunning)
                {
                    _ts.Working("Starting Tailscale. Windows will ask for permission…");
                    TrayApp.RunElevated("-NoProfile -Command \"Start-Service -Name Tailscale\"");
                    for (var i = 0; i < 15 && status.State == PhoneState.NotRunning; i++)
                    {
                        await Task.Delay(2000);
                        status = await _tailscale.GetStatus(Port);
                    }
                    if (status.State == PhoneState.NotRunning) throw new TailscaleException("Tailscale still isn't running. Open Tailscale from the Start menu (or restart the computer), then try again.");
                }
                if (status.State == PhoneState.SignedOut)
                {
                    _ts.Working("Signing in to Tailscale…");
                    await _tailscale.LogIn(url => OpenFromTailscale(url, "Waiting for you to sign in to Tailscale in your browser…"));
                    status = await _tailscale.GetStatus(Port);
                }
                if (status.State == PhoneState.Problem || status.State == PhoneState.SignedOut || status.DnsName == null)
                {
                    throw new TailscaleException(status.Problem ?? "Tailscale isn't signed in yet. Press Set up Tailscale Funnel to try again.");
                }

                // The server records the address (so emailed links use it), stops a
                // Cloudflare connector, and refuses if two-step sign-in isn't in
                // force; only then is Funnel turned on.
                await Put(new Dictionary<string, object>
                {
                    { "method", "tailscale" },
                    { "enabled", true },
                    { "publicUrl", status.Address },
                });

                _ts.Working("Turning on Funnel…");
                await _tailscale.FunnelOn(Port, url => OpenFromTailscale(url, "Waiting for you to approve Funnel in your browser…"));
                _tailscaleStatus = await _tailscale.GetStatus(Port);
                _working = false;
                ShowAll();
                if (_tailscaleStatus.State == PhoneState.On)
                {
                    Ui.Show(_ts.Status, "Remote access is on. Scan the code with your phone.", false);
                }
                else
                {
                    Ui.Show(_ts.Status, "Funnel isn't on yet. If Tailscale opened a page asking to enable HTTPS or Funnel, approve it there, then press Turn on Tailscale Funnel again.", true);
                }
            }
            catch (TailscaleException error)
            {
                await ReloadAfterFailure(error.Message);
            }
            catch (ApiException error)
            {
                await ReloadAfterFailure(error.Message);
            }
            finally
            {
                _working = false;
                if (!_tsSetUp.IsDisposed) _tsSetUp.Enabled = true;
            }
        }

        private async Task ReloadAfterFailure(string message)
        {
            _working = false;
            await ReloadTailscale();
            Ui.Show(_ts.Status, message, true);
        }

        private async Task TurnOffTailscale()
        {
            if (_working) return;
            if (!Ui.Confirm(FindForm(), "Turn off remote access? Tohyee stops being reachable at " + _ts.AddressText + ". It keeps working on this computer and your network.")) return;
            _working = true;
            try
            {
                _ts.Working("Turning off Funnel…");
                await _tailscale.FunnelOff();
                if (Method == "tailscale")
                {
                    await Put(new Dictionary<string, object> { { "method", "tailscale" }, { "enabled", false }, { "publicUrl", "" } });
                }
                _working = false;
                await ReloadTailscale();
                Ui.Show(_ts.Status, "Remote access is off.", false);
            }
            catch (TailscaleException error)
            {
                await ReloadAfterFailure(error.Message);
            }
            catch (ApiException error)
            {
                await ReloadAfterFailure(error.Message);
            }
            finally
            {
                _working = false;
            }
        }

        // ------------------------------------------------------------ the screenshots mode

        internal enum DemoStage
        {
            None,
            CloudflareSignIn,
            CloudflareChoose,
        }

        /// <summary>The screenshots mode: shows a set-up stage and scrolls to the way it's about.</summary>
        internal void ShowForDemo(DemoStage stage, bool? serviceAvailable, string scrollTo)
        {
            if (serviceAvailable.HasValue)
            {
                _serviceAvailable = serviceAvailable;
                _serviceMessage = serviceAvailable.Value ? null : NotAvailableYet;
            }
            if (stage == DemoStage.CloudflareSignIn)
            {
                _signInUrl = "https://dash.cloudflare.com/argotunnel?callback=…";
                _stage = CloudStage.SigningIn;
            }
            else if (stage == DemoStage.CloudflareChoose)
            {
                _domain.Text = "example.nz";
                _name.Text = "books";
                UpdatePreview();
                _stage = CloudStage.Choose;
            }
            ShowAll();
            var target = scrollTo == "cloudflare" ? _cloud.Card : scrollTo == "tailscale" ? _ts.Card : null;
            _page.PerformLayout();
            if (target != null) _page.ScrollControlIntoView(target);
            else _page.AutoScrollPosition = new Point(0, 0);
        }

        // ------------------------------------------------------------ one way's card

        /// <summary>
        /// One way's card: a badge, the title with a status dot, a line about it,
        /// then either its set-up (added by the page) or, when on, the address
        /// big with a QR code, Copy address, Open and Turn off.
        /// </summary>
        private sealed class Section
        {
            public readonly Card Card;
            public readonly Label Detail = new Label { ForeColor = Theme.Muted, AutoSize = true, Tag = "wrap", Margin = new Padding(0, 4, 0, 12) };
            public readonly Label Status = Ui.Status();
            private readonly Dot _dot = new Dot { Size = new Size(Theme.S(12), Theme.S(12)), Margin = new Padding(Theme.S(12), Theme.S(8), Theme.S(6), 0) };
            private readonly Label _state = new Label { Font = Theme.Strong, ForeColor = Theme.Muted, AutoSize = true, Margin = new Padding(0, Theme.S(4), 0, 0) };
            private readonly TableLayoutPanel _on = new TableLayoutPanel { ColumnCount = 2, RowCount = 1, AutoSize = true, BackColor = Theme.Card, Margin = new Padding(0, 0, 0, 4), Tag = "stretch", Visible = false };
            private readonly Label _address = new Label { Font = Theme.F("Segoe UI Semibold", 16f), ForeColor = Theme.AccentText, AutoSize = true, Margin = new Padding(0, 0, 0, 6) };
            private readonly QrView _qr = new QrView { Margin = new Padding(Theme.S(20), 0, 0, 0), Size = new Size(Theme.S(168), Theme.S(168)) };

            public Section(Control page, string badge, Color badgeColour, string title, EventHandler copy, EventHandler turnOff)
            {
                Card = Ui.Card(page, null, null);
                var titleRow = new FlowLayoutPanel { AutoSize = true, WrapContents = false, BackColor = Theme.Card, Margin = new Padding(0) };
                titleRow.Controls.Add(Ui.Title(title));
                titleRow.Controls.Add(new Pill(badge, badgeColour) { Margin = new Padding(Theme.S(10), Theme.S(3), 0, 0) });
                titleRow.Controls.Add(_dot);
                titleRow.Controls.Add(_state);
                Card.Body.Controls.Add(titleRow);
                Card.Body.Controls.Add(Detail);

                _on.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
                _on.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
                var words = new FlowLayoutPanel { FlowDirection = FlowDirection.TopDown, WrapContents = false, AutoSize = true, BackColor = Theme.Card, Margin = new Padding(0) };
                words.Controls.Add(new Label { Text = "YOUR PHONE ADDRESS", Font = Theme.SmallCaps, ForeColor = Theme.Muted, AutoSize = true, Margin = new Padding(0, 4, 0, 4) });
                words.Controls.Add(_address);
                words.Controls.Add(new Label { Text = "Scan the code with your phone's camera, or type the address into its browser. Add it to your home screen to open Tohyee like an app.", ForeColor = Theme.Muted, AutoSize = true, MaximumSize = new Size(Theme.S(440), 0), Margin = new Padding(0, 0, 0, 12) });
                var buttons = new FlowLayoutPanel { FlowDirection = FlowDirection.LeftToRight, AutoSize = true, WrapContents = true, Margin = new Padding(0, 6, 0, 2), BackColor = Theme.Card };
                buttons.Controls.Add(Ui.Primary("Copy address", copy));
                buttons.Controls.Add(Ui.Btn("Open", (s, e) => { if (_address.Text.Length > 0) TrayApp.Open(_address.Text); }));
                buttons.Controls.Add(Ui.DangerBtn("Turn off", turnOff));
                words.Controls.Add(buttons);
                _on.Controls.Add(words, 0, 0);
                _on.Controls.Add(_qr, 1, 0);
                Card.Body.Controls.Add(_on);
            }

            /// <summary>Adds the status line and the small print, after the page's own controls.</summary>
            public void AddStatusAndNote(string note)
            {
                Card.Body.Controls.Add(Status);
                Card.Body.Controls.Add(new Label { Text = note, ForeColor = Theme.Muted, Font = Theme.Small, AutoSize = true, Tag = "wrap", Margin = new Padding(0, 10, 0, 0) });
            }

            public string AddressText
            {
                get { return _address.Text; }
            }

            public string StateText
            {
                get { return _state.Text; }
                set { _state.Text = value; }
            }

            public Control Body
            {
                get { return Card.Body; }
            }

            public void ShowOn(string state, Color colour, string address, string detail)
            {
                _on.Visible = true;
                _address.Text = address ?? "";
                _qr.Value = address;
                _state.Text = state;
                _state.ForeColor = colour == Theme.Success ? Theme.Success : colour;
                _dot.Colour = colour;
                Detail.Text = detail;
            }

            public void ShowOff(string state, Color colour, string detail)
            {
                _on.Visible = false;
                _state.Text = state;
                _state.ForeColor = colour == Theme.Muted ? Theme.Muted : colour;
                _dot.Colour = colour;
                Detail.Text = detail;
            }

            public void Working(string text)
            {
                _dot.Colour = Theme.Warning;
                _state.ForeColor = Theme.Warning;
                _state.Text = text;
                Status.Text = "";
            }

            /// <summary>The main button: blue while choosing, grey when another way is already on.</summary>
            public static void Emphasise(Button button, bool main)
            {
                var flat = button as FlatButton;
                if (flat == null) return;
                flat.Kind = main ? ButtonKind.Primary : ButtonKind.Secondary;
                flat.Font = main ? Theme.F("Segoe UI Semibold", 9.75f) : Theme.Body;
                flat.Invalidate();
            }

            /// <summary>The way that's on gets a green edge.</summary>
            public void Refit(bool on)
            {
                Card.Strip = on ? Theme.Success : Color.Empty;
                Card.Invalidate();
                Card.Refit();
            }
        }
    
        /// <summary>A small rounded label beside a card's title (e.g. RECOMMENDED FOR MOST).</summary>
        private sealed class Pill : Control
        {
            private readonly Color _colour;

            public Pill(string text, Color colour)
            {
                Text = text;
                _colour = colour;
                Font = Theme.SmallCaps;
                SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
                var size = TextRenderer.MeasureText(text, Font);
                Size = new Size(size.Width + Theme.S(14), size.Height + Theme.S(6));
            }

            protected override void OnPaint(PaintEventArgs e)
            {
                var g = e.Graphics;
                g.Clear(Theme.BackOf(this));
                g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
                using (var path = Theme.Rounded(new RectangleF(0.5f, 0.5f, Width - 1.5f, Height - 1.5f), Height / 2f))
                using (var fill = new SolidBrush(Color.FromArgb(28, _colour)))
                using (var pen = new Pen(Color.FromArgb(110, _colour)))
                {
                    g.FillPath(fill, path);
                    g.DrawPath(pen, path);
                }
                TextRenderer.DrawText(g, Text, Font, ClientRectangle, _colour, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine);
            }
        }
    }
}

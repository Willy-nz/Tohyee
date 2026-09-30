using System;
using System.Collections.Generic;
using System.Drawing;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace Tohyee.Tray
{
    /// <summary>
    /// Phone access: use Tohyee from anywhere. The easy way is Tailscale Funnel,
    /// which this page sets up (installing Tailscale if needed) and shows as an
    /// address and a QR code. The advanced way, your own domain through a
    /// Cloudflare Tunnel, is below it: Tohyee runs Cloudflare's connector; this
    /// saves the tunnel token and public address and shows how it's doing.
    /// Either way, turning it on needs two-step sign-in in force on the server.
    /// </summary>
    internal sealed class RemoteAccessPage : UserControl
    {
        private static readonly Dictionary<string, string> StatusLabels = new Dictionary<string, string>
        {
            { "off", "Off" },
            { "starting", "Starting" },
            { "connected", "Connected" },
            { "reconnecting", "Reconnecting" },
            { "error", "Not working" },
            { "missing_program", "cloudflared is missing" },
        };

        private const string TwoStepMessage = "Phone access can't be turned on until two-step sign-in is in force, and that needs TOHYEE_SECRET_KEY set on the server. The Windows installer sets it when you update Tohyee.";

        private readonly TohyeeApi _api;
        private readonly TraySettings _settings;
        private readonly ITailscale _tailscale;
        private Dictionary<string, object> _remote;

        // Tailscale Funnel
        private readonly Card _phoneCard;
        private readonly Dot _phoneDot = new Dot { Size = new Size(Theme.S(14), Theme.S(14)), Margin = new Padding(0, Theme.S(6), Theme.S(10), 0) };
        private readonly Label _phoneState = new Label { Font = Theme.CardTitle, ForeColor = Theme.Text, AutoSize = true, Margin = new Padding(0) };
        private readonly Label _phoneDetail = new Label { ForeColor = Theme.Muted, AutoSize = true, Tag = "wrap", Margin = new Padding(0, 6, 0, 12) };
        private readonly TableLayoutPanel _onPanel = new TableLayoutPanel { ColumnCount = 2, RowCount = 1, AutoSize = true, BackColor = Theme.Card, Margin = new Padding(0, 4, 0, 8), Tag = "stretch" };
        private readonly Label _address = new Label { Font = Theme.F("Segoe UI Semibold", 16f), ForeColor = Theme.AccentText, AutoSize = true, Margin = new Padding(0, 0, 0, 6) };
        private readonly QrView _qr = new QrView { Margin = new Padding(Theme.S(20), 0, 0, 0), Size = new Size(Theme.S(176), Theme.S(176)) };
        private readonly FlowLayoutPanel _onButtons = Ui.Row();
        private readonly FlowLayoutPanel _offButtons = Ui.Row();
        private readonly Button _setUp;
        private readonly Label _phoneStatus = Ui.Status();
        private Label _about;
        private string _aboutText;
        private bool _working;

        // Cloudflare Tunnel (advanced)
        private readonly Card _cloudCard;
        private readonly FlowLayoutPanel _cloudBody = new FlowLayoutPanel { FlowDirection = FlowDirection.TopDown, WrapContents = false, AutoSize = true, BackColor = Theme.Card, Margin = new Padding(0), Tag = "stretch", Visible = false };
        private readonly Button _cloudToggle;
        private readonly Label _state = new Label { AutoSize = true, Font = Theme.Strong, ForeColor = Theme.Text, Margin = new Padding(0, 0, 0, 4), Tag = "wrap" };
        private readonly Label _message = new Label { AutoSize = true, Tag = "wrap", ForeColor = Theme.Muted, Margin = new Padding(0, 0, 0, 8) };
        private readonly TextBox _token = new TextBox { Multiline = true, Height = Theme.S(60), Font = Theme.Mono };
        private readonly Label _tokenHint = new Label { AutoSize = true, ForeColor = Theme.Muted, MaximumSize = new Size(Theme.S(420), 0) };
        private readonly TextBox _publicUrl = new TextBox();
        private readonly CheckBox _enabled = new CheckBox { Text = "Remote access on (Tohyee runs the Cloudflare connector while the server is running)", AutoSize = true, Tag = "wrap" };
        private readonly Label _steps = new Label { AutoSize = true, Tag = "wrap", ForeColor = Theme.Text, Margin = new Padding(0, 4, 0, 10) };
        private readonly TextBox _log = new TextBox { Multiline = true, ReadOnly = true, ScrollBars = ScrollBars.Vertical, Height = Theme.S(140), Font = Theme.F("Consolas", 8.5f), Visible = false, Tag = "stretch" };
        private readonly Label _status = Ui.Status();
        private bool _hasToken;

        public RemoteAccessPage(TohyeeApi api, TraySettings settings, ITailscale tailscale)
        {
            _api = api;
            _settings = settings;
            _tailscale = tailscale;
            BackColor = Theme.Bg;
            var page = Ui.Page("Phone access", "Use Tohyee from your phone or laptop anywhere, with a proper https address and nothing to change on your router. Everyone still signs in with their password and authenticator app.");

            // ---- Tailscale Funnel: the easy way
            _phoneCard = Ui.Card(page, null, null);
            var badge = new Label { Text = "THE EASY WAY  ·  TAILSCALE FUNNEL", Font = Theme.SmallCaps, ForeColor = Theme.AccentText, AutoSize = true, Margin = new Padding(0, 0, 0, 10) };
            _phoneCard.Body.Controls.Add(badge);
            var stateRow = new FlowLayoutPanel { AutoSize = true, WrapContents = false, BackColor = Theme.Card, Margin = new Padding(0) };
            stateRow.Controls.Add(_phoneDot);
            stateRow.Controls.Add(_phoneState);
            _phoneCard.Body.Controls.Add(stateRow);
            _phoneCard.Body.Controls.Add(_phoneDetail);

            _onPanel.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            _onPanel.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
            var onWords = new FlowLayoutPanel { FlowDirection = FlowDirection.TopDown, WrapContents = false, AutoSize = true, BackColor = Theme.Card, Margin = new Padding(0) };
            onWords.Controls.Add(new Label { Text = "YOUR PHONE ADDRESS", Font = Theme.SmallCaps, ForeColor = Theme.Muted, AutoSize = true, Margin = new Padding(0, 4, 0, 4) });
            onWords.Controls.Add(_address);
            onWords.Controls.Add(new Label { Text = "Scan the code with your phone's camera, or type the address into its browser. Add it to your home screen to open Tohyee like an app.", ForeColor = Theme.Muted, AutoSize = true, MaximumSize = new Size(Theme.S(440), 0), Margin = new Padding(0, 0, 0, 12) });
            _onButtons.Controls.Add(Ui.Primary("Copy address", (s, e) => CopyAddress()));
            _onButtons.Controls.Add(Ui.Btn("Open", (s, e) => { if (_address.Text.Length > 0) TrayApp.Open(_address.Text); }));
            _onButtons.Controls.Add(Ui.DangerBtn("Turn off phone access", async (s, e) => await TurnOff()));
            _onButtons.Tag = null;
            onWords.Controls.Add(_onButtons);
            _onPanel.Controls.Add(onWords, 0, 0);
            _onPanel.Controls.Add(_qr, 1, 0);
            _phoneCard.Body.Controls.Add(_onPanel);

            _setUp = Ui.Primary("Set up phone access", async (s, e) => await TurnOn());
            _offButtons.Controls.Add(_setUp);
            _offButtons.Controls.Add(Ui.Btn("Check again", async (s, e) => await ReloadPhone()));
            _phoneCard.Body.Controls.Add(_offButtons);
            _phoneCard.Body.Controls.Add(_phoneStatus);
            _phoneCard.Body.Controls.Add(_about = new Label
            {
                Text = "Tailscale is a free service for personal use that gives this computer an address like https://your-computer.your-tailnet.ts.net and forwards it to Tohyee. You sign in to Tailscale once in your browser (a Google, Microsoft or GitHub account works); Tohyee never sees or keeps that login.",
                ForeColor = Theme.Muted,
                Font = Theme.Small,
                AutoSize = true,
                Tag = "wrap",
                Margin = new Padding(0, 14, 0, 0),
            });

            // ---- Cloudflare Tunnel: the advanced way
            _cloudCard = Ui.Card(page, null, null);
            _cloudCard.Body.Controls.Add(new Label { Text = "ADVANCED  ·  YOUR OWN DOMAIN", Font = Theme.SmallCaps, ForeColor = Theme.Muted, AutoSize = true, Margin = new Padding(0, 0, 0, 10) });
            _cloudCard.Body.Controls.Add(Ui.Title("Cloudflare Tunnel"));
            _cloudCard.Body.Controls.Add(Ui.Note("Use an address on your own domain (like https://books.example.nz) instead. It needs a domain on Cloudflare and a few steps in Cloudflare's dashboard."));
            _cloudCard.Body.Controls.Add(_state);
            _cloudToggle = Ui.Btn("Show Cloudflare set-up", (s, e) => ToggleCloudflare());
            var toggleRow = Ui.Row();
            toggleRow.Controls.Add(_cloudToggle);
            _cloudCard.Body.Controls.Add(toggleRow);

            _cloudBody.Controls.Add(_message);
            var top = Ui.Row();
            top.Controls.Add(Ui.Btn("Refresh", async (s, e) => await Reload()));
            top.Controls.Add(Ui.Btn("Restart connector", async (s, e) => await Restart()));
            top.Controls.Add(Ui.Btn("Show connector log", (s, e) => _log.Visible = !_log.Visible));
            top.Controls.Add(Ui.DangerBtn("Remove remote access", async (s, e) => await Remove()));
            _cloudBody.Controls.Add(top);
            _cloudBody.Controls.Add(Ui.Input(_log));
            _cloudBody.Controls.Add(new Label { Text = "Set up (once)", Font = Theme.Strong, ForeColor = Theme.Text, AutoSize = true, Margin = new Padding(0, 12, 0, 2) });
            _cloudBody.Controls.Add(_steps);
            var form = Ui.Form();
            Ui.Field(form, "Tunnel token", _token);
            form.RowCount += 1;
            form.Controls.Add(new Label());
            form.Controls.Add(_tokenHint);
            Ui.Field(form, "Public address", _publicUrl);
            _cloudBody.Controls.Add(form);
            _cloudBody.Controls.Add(Ui.Input(_enabled));
            var save = Ui.Row();
            save.Controls.Add(Ui.Primary("Save", async (s, e) => await Save()));
            _cloudBody.Controls.Add(save);
            _cloudBody.Controls.Add(_status);
            _cloudCard.Body.Controls.Add(_cloudBody);

            Controls.Add(page);
            ShowPhone(new TailscaleStatus { State = PhoneState.Checking });
            Load += async (s, e) =>
            {
                await Reload();
                await ReloadPhone();
            };
        }

        private int Port
        {
            get { return _settings.Port; }
        }

        private bool TwoStepInForce
        {
            get { return _remote != null && J.Bool(_remote, "twoStepRequired"); }
        }

        // ------------------------------------------------------------ Tailscale Funnel

        private void ShowPhone(TailscaleStatus status)
        {
            var on = status.State == PhoneState.On;
            _onPanel.Visible = on;
            _offButtons.Visible = !on;
            string state;
            string detail;
            var colour = Theme.Muted;
            _setUp.Text = "Set up phone access";
            switch (status.State)
            {
                case PhoneState.Checking:
                    state = "Checking…";
                    detail = "Asking Tailscale how things are.";
                    break;
                case PhoneState.NotInstalled:
                    state = "Off";
                    detail = "Set up phone access installs Tailscale on this computer (Windows asks for permission), signs you in to Tailscale in your browser, and turns on Funnel for Tohyee. It takes a couple of minutes.";
                    break;
                case PhoneState.NotRunning:
                    state = "Tailscale isn't running";
                    detail = "Tailscale is installed, but its Windows service isn't answering. Set up phone access tries to start it (Windows asks for permission).";
                    colour = Theme.Warning;
                    break;
                case PhoneState.SignedOut:
                    state = "Off: Tailscale isn't signed in";
                    detail = status.Problem ?? "Set up phone access opens Tailscale's sign-in page in your browser, then turns on Funnel for Tohyee.";
                    break;
                case PhoneState.Off:
                    state = "Off";
                    detail = "Tailscale is ready" + (status.DnsName != null ? " (this computer is " + status.DnsName + ")" : "") + ". Turning on phone access makes Tohyee reachable at that address from anywhere.";
                    _setUp.Text = "Turn on phone access";
                    break;
                case PhoneState.OtherFunnel:
                    state = "Funnel is on for something else";
                    detail = "Tailscale Funnel on this computer points at a different program, not Tohyee on port " + Port + ". Turn on phone access to point it at Tohyee instead.";
                    colour = Theme.Warning;
                    _setUp.Text = "Turn on phone access";
                    break;
                case PhoneState.On:
                    state = "On";
                    detail = "Tohyee is reachable from anywhere through Tailscale Funnel. It stays on when the computer restarts.";
                    colour = Theme.Success;
                    _address.Text = status.Address ?? "";
                    _qr.Value = status.Address;
                    break;
                default:
                    state = "Tailscale has a problem";
                    detail = status.Problem ?? "Tailscale didn't answer as expected.";
                    colour = Theme.Danger;
                    break;
            }
            if (!on && !TwoStepInForce && _remote != null)
            {
                detail = TwoStepMessage;
                colour = Theme.Danger;
            }
            if (_aboutText == null) _aboutText = _about.Text;
            _about.Text = _aboutText + (status.Version != null && status.State != PhoneState.NotInstalled ? " Tailscale " + status.Version + " is installed." : "");
            _phoneState.Text = state;
            _phoneDetail.Text = detail;
            _phoneDot.Colour = colour;
            _phoneCard.Refit();
        }

        private void Working(string text)
        {
            _phoneDot.Colour = Theme.Warning;
            _phoneState.Text = text;
            _phoneStatus.Text = "";
        }

        private async Task ReloadPhone()
        {
            if (_working) return;
            try
            {
                ShowPhone(await _tailscale.GetStatus(Port));
            }
            catch (Exception error)
            {
                ShowPhone(new TailscaleStatus { State = PhoneState.Problem, Problem = error.Message });
            }
        }

        /// <summary>Opens Tailscale's sign-in or approval page in the browser (from the CLI's output thread).</summary>
        private void OpenFromTailscale(string url, string waiting)
        {
            if (IsDisposed || !IsHandleCreated) return;
            BeginInvoke((Action)(() =>
            {
                Working(waiting);
                Ui.Show(_phoneStatus, "Your browser opened " + url + ". Finish there; this page carries on by itself.", false);
                TrayApp.Open(url);
            }));
        }

        private async Task TurnOn()
        {
            if (_working) return;
            _phoneStatus.Text = "";
            // The server's rule, checked here too so nothing is installed for nothing.
            try
            {
                _remote = J.Obj(await _api.Get("/api/admin/remote-access"), "remoteAccess");
            }
            catch (ApiException error)
            {
                Ui.Show(_phoneStatus, error.Message, true);
                return;
            }
            if (!TwoStepInForce)
            {
                Ui.Show(_phoneStatus, TwoStepMessage, true);
                return;
            }
            if (J.Str(_remote, "method") != "tailscale" && J.Bool(_remote, "enabled") && J.Bool(_remote, "hasToken"))
            {
                if (!Ui.Confirm(FindForm(), "Switch phone access from your Cloudflare Tunnel to Tailscale Funnel? Tohyee stops the Cloudflare connector but keeps its token, so you can switch back.")) return;
            }

            _working = true;
            _setUp.Enabled = false;
            try
            {
                Working("Checking Tailscale…");
                var status = await _tailscale.GetStatus(Port);
                if (status.State == PhoneState.NotInstalled)
                {
                    if (!Ui.Confirm(FindForm(), "Install Tailscale?\n\nTohyee downloads the official Tailscale installer from pkgs.tailscale.com and installs it. Windows will ask for permission."))
                    {
                        _working = false;
                        await ReloadPhone();
                        return;
                    }
                    await _tailscale.Install(text => BeginInvoke((Action)(() => Working(text))));
                    status = await _tailscale.GetStatus(Port);
                }
                if (status.State == PhoneState.NotRunning)
                {
                    Working("Starting Tailscale. Windows will ask for permission…");
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
                    Working("Signing in to Tailscale…");
                    await _tailscale.LogIn(url => OpenFromTailscale(url, "Waiting for you to sign in to Tailscale in your browser…"));
                    status = await _tailscale.GetStatus(Port);
                }
                if (status.State == PhoneState.Problem || status.State == PhoneState.SignedOut || status.DnsName == null)
                {
                    throw new TailscaleException(status.Problem ?? "Tailscale isn't signed in yet. Press Set up phone access to try again.");
                }

                // The server records the address (so emailed links use it) and
                // refuses if two-step sign-in isn't in force; only then is Funnel turned on.
                _remote = J.Obj(await _api.Put("/api/admin/remote-access", new Dictionary<string, object>
                {
                    { "method", "tailscale" },
                    { "enabled", true },
                    { "publicUrl", status.Address },
                }), "remoteAccess");

                Working("Turning on Funnel…");
                await _tailscale.FunnelOn(Port, url => OpenFromTailscale(url, "Waiting for you to approve Funnel in your browser…"));
                status = await _tailscale.GetStatus(Port);
                ShowPhone(status);
                if (status.State == PhoneState.On)
                {
                    Ui.Show(_phoneStatus, "Phone access is on. Scan the code with your phone.", false);
                }
                else
                {
                    Ui.Show(_phoneStatus, "Funnel isn't on yet. If Tailscale opened a page asking to enable HTTPS or Funnel, approve it there, then press Turn on phone access again.", true);
                }
                ShowCloudflare(_remote);
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
                if (!_setUp.IsDisposed) _setUp.Enabled = true;
            }
        }

        private async Task ReloadAfterFailure(string message)
        {
            _working = false;
            await ReloadPhone();
            Ui.Show(_phoneStatus, message, true);
        }

        private async Task TurnOff()
        {
            if (_working) return;
            if (!Ui.Confirm(FindForm(), "Turn off phone access? Tohyee stops being reachable at " + _address.Text + ". It keeps working on this computer and your network.")) return;
            _working = true;
            try
            {
                Working("Turning off Funnel…");
                await _tailscale.FunnelOff();
                _remote = J.Obj(await _api.Put("/api/admin/remote-access", new Dictionary<string, object>
                {
                    { "method", "tailscale" },
                    { "enabled", false },
                    { "publicUrl", "" },
                }), "remoteAccess");
                _working = false;
                await ReloadPhone();
                Ui.Show(_phoneStatus, "Phone access is off.", false);
                ShowCloudflare(_remote);
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

        private void CopyAddress()
        {
            try
            {
                Clipboard.SetText(_address.Text);
                Ui.Show(_phoneStatus, "Copied " + _address.Text + ".", false);
            }
            catch (Exception)
            {
                Ui.Show(_phoneStatus, "The clipboard was busy. Try again.", true);
            }
        }

        // ------------------------------------------------------------ Cloudflare Tunnel

        /// <summary>The screenshots mode: opens the Cloudflare set-up and scrolls to it.</summary>
        internal void ShowCloudflareSetUpForDemo()
        {
            if (!_cloudBody.Visible) ToggleCloudflare();
            var page = _cloudCard.Parent as ScrollableControl;
            if (page != null)
            {
                page.PerformLayout();
                page.AutoScrollPosition = new Point(0, 100000);
            }
        }

        private void ToggleCloudflare()
        {
            _cloudBody.Visible = !_cloudBody.Visible;
            _cloudToggle.Text = _cloudBody.Visible ? "Hide Cloudflare set-up" : "Show Cloudflare set-up";
            _cloudCard.Refit();
        }

        private void ShowCloudflare(Dictionary<string, object> remote)
        {
            _remote = remote;
            var tunnel = J.Obj(remote, "tunnel");
            var status = J.Str(tunnel, "status") ?? "off";
            string label;
            if (!StatusLabels.TryGetValue(status, out label)) label = status;
            var publicUrl = J.Str(remote, "publicUrl");
            var method = J.Str(remote, "method") ?? "cloudflare";
            if (method == "tailscale")
            {
                _state.Text = "Not in use: phone access " + (J.Bool(remote, "enabled") ? "goes through Tailscale Funnel." : "is off.") + (J.Bool(remote, "hasToken") ? " Your tunnel token is kept." : "");
                _state.ForeColor = Theme.Muted;
            }
            else
            {
                _state.Text = "Status: " + label + (status == "connected" && publicUrl != null ? " · " + publicUrl : "");
                _state.ForeColor = status == "connected" ? Ui.Success : status == "error" || status == "missing_program" ? Ui.Danger : Theme.Text;
            }
            var message = J.Str(tunnel, "message");
            if (!J.Bool(remote, "twoStepRequired")) message = TwoStepMessage;
            _message.Text = message ?? (status == "connected" ? "Open the public address on your phone to check." : "");
            _message.Visible = _message.Text.Length > 0;
            _log.Text = string.Join("\r\n", J.Strings(tunnel, "log"));
            _hasToken = J.Bool(remote, "hasToken");
            _tokenHint.Text = _hasToken
                ? "Saved (tunnel " + (J.Str(remote, "tunnelId") ?? "unknown") + "). Leave blank to keep it."
                : "Paste the install command Cloudflare shows, or just the long code starting eyJ.";
            _token.Text = "";
            _publicUrl.Text = method == "cloudflare" ? publicUrl ?? "" : "";
            _enabled.Checked = (method == "cloudflare" && J.Bool(remote, "enabled")) || !_hasToken;
            var localService = J.Str(remote, "localService") ?? "http://127.0.0.1:3000";
            _steps.Text =
                "1. You need a domain (web address) on Cloudflare, e.g. example.nz. Cloudflare's free plan is enough.\r\n" +
                "2. In the Cloudflare dashboard, go to Networking → Tunnels (older accounts: Zero Trust → Networks → Tunnels), choose Create a tunnel, name it (e.g. tohyee) and pick Windows.\r\n" +
                "3. Cloudflare shows an install command. Don't run it: copy it (or just the code starting eyJ) into Tunnel token below. Tohyee runs the connector itself.\r\n" +
                "4. On the tunnel's Routes tab, add a published application: a subdomain such as books on your domain, with the service URL " + localService + " (use 127.0.0.1, not localhost).\r\n" +
                "5. Enter that address (e.g. https://books.example.nz) as the public address, turn remote access on and save.";
            // Someone using Cloudflare sees its settings straight away.
            if (method == "cloudflare" && J.Bool(remote, "enabled") && !_cloudBody.Visible) ToggleCloudflare();
            _cloudCard.Refit();
        }

        private async Task Reload()
        {
            await Ui.Busy(_cloudCard, _status, async () => ShowCloudflare(J.Obj(await _api.Get("/api/admin/remote-access"), "remoteAccess")));
        }

        private async Task Save()
        {
            _status.Text = "";
            var body = new Dictionary<string, object>
            {
                { "method", "cloudflare" },
                { "enabled", _enabled.Checked },
                { "publicUrl", _publicUrl.Text.Trim() },
            };
            if (_token.Text.Trim().Length > 0) body["tunnelToken"] = _token.Text.Trim();
            else if (!_hasToken)
            {
                Ui.Show(_status, "Paste the tunnel token from Cloudflare first.", true);
                return;
            }
            if (J.Str(_remote, "method") == "tailscale" && J.Bool(_remote, "enabled"))
            {
                if (!Ui.Confirm(FindForm(), "Switch phone access to your Cloudflare Tunnel? Turn off Tailscale Funnel above too, so Tohyee isn't reachable two ways.")) return;
            }
            await Ui.Busy(_cloudCard, _status, async () =>
            {
                ShowCloudflare(J.Obj(await _api.Put("/api/admin/remote-access", body), "remoteAccess"));
                Ui.Show(_status, "Saved.", false);
            });
        }

        private async Task Restart()
        {
            await Ui.Busy(_cloudCard, _status, async () =>
            {
                ShowCloudflare(J.Obj(await _api.Post("/api/admin/remote-access", null), "remoteAccess"));
                Ui.Show(_status, "The connector was restarted.", false);
            });
        }

        private async Task Remove()
        {
            if (J.Str(_remote, "method") == "tailscale" && J.Bool(_remote, "enabled"))
            {
                Ui.Show(_status, "Phone access goes through Tailscale Funnel at the moment. Turn it off above first.", true);
                return;
            }
            if (!Ui.Confirm(FindForm(), "Remove remote access? Tohyee stops the connector and forgets the tunnel token. It stays reachable on this computer.")) return;
            await Ui.Busy(_cloudCard, _status, async () =>
            {
                ShowCloudflare(J.Obj(await _api.Put("/api/admin/remote-access", new Dictionary<string, object> { { "clear", true } }), "remoteAccess"));
                Ui.Show(_status, "Remote access removed.", false);
            });
        }
    }
}

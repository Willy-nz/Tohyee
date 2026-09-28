using System.Collections.Generic;
using System.Drawing;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace Tohyee.Tray
{
    /// <summary>
    /// Remote access: use Tohyee from anywhere through a Cloudflare Tunnel. Tohyee
    /// runs Cloudflare's connector itself; this saves the tunnel token and public
    /// address, and shows how the connector is doing.
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

        private readonly TohyeeApi _api;
        private readonly Label _state = new Label { AutoSize = true, Font = new Font("Segoe UI Semibold", 10.5f), Margin = new Padding(0, 0, 0, 4) };
        private readonly Label _message = new Label { AutoSize = true, MaximumSize = new Size(700, 0), ForeColor = Ui.Muted, Margin = new Padding(0, 0, 0, 8) };
        private readonly TextBox _token = new TextBox { Multiline = true, Height = 60, Font = new Font("Consolas", 9f) };
        private readonly Label _tokenHint = new Label { AutoSize = true, ForeColor = Ui.Muted, MaximumSize = new Size(700, 0) };
        private readonly TextBox _publicUrl = new TextBox();
        private readonly CheckBox _enabled = new CheckBox { Text = "Remote access on (Tohyee runs the Cloudflare connector while the server is running)", AutoSize = true };
        private readonly Label _steps = new Label { AutoSize = true, MaximumSize = new Size(720, 0), Margin = new Padding(0, 4, 0, 10) };
        private readonly TextBox _log = new TextBox { Multiline = true, ReadOnly = true, ScrollBars = ScrollBars.Vertical, Width = 760, Height = 140, Font = new Font("Consolas", 8.5f), Visible = false };
        private readonly Label _status = Ui.Status();
        private bool _hasToken;

        public RemoteAccessPage(TohyeeApi api)
        {
            _api = api;
            var page = Ui.Page();
            page.Controls.Add(Ui.Title("Remote access"));
            page.Controls.Add(Ui.Note("Use Tohyee from anywhere (phone or laptop) through a Cloudflare Tunnel: nothing to open on your router, and a proper https address. Everyone signs in with their password and authenticator app."));
            page.Controls.Add(_state);
            page.Controls.Add(_message);
            var top = Ui.Row();
            top.Controls.Add(Ui.Btn("Refresh", async (s, e) => await Reload()));
            top.Controls.Add(Ui.Btn("Restart connector", async (s, e) => await Restart()));
            top.Controls.Add(Ui.Btn("Show connector log", (s, e) => _log.Visible = !_log.Visible));
            top.Controls.Add(Ui.Btn("Remove remote access", async (s, e) => await Remove()));
            page.Controls.Add(top);
            page.Controls.Add(_log);

            page.Controls.Add(new Label { Text = "Set up (once)", Font = new Font("Segoe UI Semibold", 10.5f), AutoSize = true, Margin = new Padding(0, 12, 0, 2) });
            page.Controls.Add(_steps);

            var form = Ui.Form();
            Ui.Field(form, "Tunnel token", _token);
            form.RowCount += 1;
            form.Controls.Add(new Label());
            form.Controls.Add(_tokenHint);
            Ui.Field(form, "Public address", _publicUrl);
            page.Controls.Add(form);
            page.Controls.Add(_enabled);
            var save = Ui.Row();
            save.Controls.Add(Ui.Btn("Save", async (s, e) => await Save()));
            page.Controls.Add(save);
            page.Controls.Add(_status);
            Controls.Add(page);
            Load += async (s, e) => await Reload();
        }

        private void Show(Dictionary<string, object> remote)
        {
            var tunnel = J.Obj(remote, "tunnel");
            var status = J.Str(tunnel, "status") ?? "off";
            string label;
            if (!StatusLabels.TryGetValue(status, out label)) label = status;
            var publicUrl = J.Str(remote, "publicUrl");
            _state.Text = "Status: " + label + (status == "connected" && publicUrl != null ? " · " + publicUrl : "");
            _state.ForeColor = status == "connected" ? Ui.Success : status == "error" || status == "missing_program" ? Ui.Danger : Color.Black;
            var message = J.Str(tunnel, "message");
            if (!J.Bool(remote, "twoStepRequired"))
            {
                message = "Remote access can't be turned on until two-step sign-in is in force, and that needs TOHYEE_SECRET_KEY set on the server. The Windows installer sets it when you update Tohyee.";
            }
            _message.Text = message ?? (status == "connected" ? "Open the public address on your phone to check." : "");
            _log.Text = string.Join("\r\n", J.Strings(tunnel, "log"));
            _hasToken = J.Bool(remote, "hasToken");
            _tokenHint.Text = _hasToken
                ? "Saved (tunnel " + (J.Str(remote, "tunnelId") ?? "unknown") + "). Leave blank to keep it."
                : "Paste the install command Cloudflare shows, or just the long code starting eyJ.";
            _token.Text = "";
            _publicUrl.Text = publicUrl ?? "";
            _enabled.Checked = J.Bool(remote, "enabled") || !_hasToken;
            var localService = J.Str(remote, "localService") ?? "http://127.0.0.1:3000";
            _steps.Text =
                "1. You need a domain (web address) on Cloudflare, e.g. example.nz. Cloudflare's free plan is enough.\r\n" +
                "2. In the Cloudflare dashboard, go to Networking → Tunnels (older accounts: Zero Trust → Networks → Tunnels), choose Create a tunnel, name it (e.g. tohyee) and pick Windows.\r\n" +
                "3. Cloudflare shows an install command. Don't run it: copy it (or just the code starting eyJ) into Tunnel token below. Tohyee runs the connector itself.\r\n" +
                "4. On the tunnel's Routes tab, add a published application: a subdomain such as books on your domain, with the service URL " + localService + " (use 127.0.0.1, not localhost).\r\n" +
                "5. Enter that address (e.g. https://books.example.nz) as the public address, turn remote access on and save.";
        }

        private async Task Reload()
        {
            await Ui.Busy(this, _status, async () => Show(J.Obj(await _api.Get("/api/admin/remote-access"), "remoteAccess")));
        }

        private async Task Save()
        {
            _status.Text = "";
            var body = new Dictionary<string, object>
            {
                { "enabled", _enabled.Checked },
                { "publicUrl", _publicUrl.Text.Trim() },
            };
            if (_token.Text.Trim().Length > 0) body["tunnelToken"] = _token.Text.Trim();
            else if (!_hasToken)
            {
                Ui.Show(_status, "Paste the tunnel token from Cloudflare first.", true);
                return;
            }
            await Ui.Busy(this, _status, async () =>
            {
                Show(J.Obj(await _api.Put("/api/admin/remote-access", body), "remoteAccess"));
                Ui.Show(_status, "Saved.", false);
            });
        }

        private async Task Restart()
        {
            await Ui.Busy(this, _status, async () =>
            {
                Show(J.Obj(await _api.Post("/api/admin/remote-access", null), "remoteAccess"));
                Ui.Show(_status, "The connector was restarted.", false);
            });
        }

        private async Task Remove()
        {
            if (!Ui.Confirm(FindForm(), "Remove remote access? Tohyee stops the connector and forgets the tunnel token. It stays reachable on this computer.")) return;
            await Ui.Busy(this, _status, async () =>
            {
                Show(J.Obj(await _api.Put("/api/admin/remote-access", new Dictionary<string, object> { { "clear", true } }), "remoteAccess"));
                Ui.Show(_status, "Remote access removed.", false);
            });
        }
    }
}

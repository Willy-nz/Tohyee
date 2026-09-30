using System.Collections.Generic;
using System.Drawing;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace Tohyee.Tray
{
    /// <summary>
    /// Email: the account this server sends security alerts and two-step
    /// sign-in reset links from (Gmail with an app password, or any SMTP server).
    /// </summary>
    internal sealed class EmailPage : UserControl
    {
        private readonly TohyeeApi _api;
        private readonly Label _state = Ui.State();
        private readonly ComboBox _provider = new ComboBox { DropDownStyle = ComboBoxStyle.DropDownList };
        private readonly Label _providerNote = new Label { AutoSize = true, ForeColor = Ui.Muted, MaximumSize = new Size(Theme.S(420), 0), Margin = new Padding(0, 2, 0, 6) };
        private readonly TextBox _host = new TextBox();
        private readonly TextBox _port = new TextBox();
        private readonly TextBox _username = new TextBox();
        private readonly TextBox _password = new TextBox { UseSystemPasswordChar = true };
        private readonly Label _passwordHint = new Label { AutoSize = true, ForeColor = Ui.Muted };
        private readonly TextBox _fromAddress = new TextBox();
        private readonly TextBox _fromName = new TextBox();
        private readonly Label _status = Ui.Status();

        public EmailPage(TohyeeApi api)
        {
            _api = api;
            BackColor = Theme.Bg;
            var page = Ui.Page("Email", "The email account this server sends from: security alerts (two-step sign-in changes, backup codes used, locked accounts) and links to reset two-step sign-in when someone loses their phone.");
            var card = Ui.Card(page, null, null);
            card.Body.Controls.Add(_state);
            var form = Ui.Form();
            Ui.Field(form, "Email provider", _provider);
            form.RowCount += 1;
            form.Controls.Add(new Label());
            form.Controls.Add(_providerNote);
            Ui.Field(form, "SMTP server", _host);
            Ui.Field(form, "Port (465 or 587)", _port);
            Ui.Field(form, "Email account", _username);
            Ui.Field(form, "Password", _password);
            form.RowCount += 1;
            form.Controls.Add(new Label());
            form.Controls.Add(_passwordHint);
            Ui.Field(form, "Send from", _fromAddress);
            Ui.Field(form, "From name", _fromName);
            card.Body.Controls.Add(form);
            var buttons = Ui.Row();
            buttons.Controls.Add(Ui.Primary("Save", async (s, e) => await Save()));
            buttons.Controls.Add(Ui.Btn("Send a test email", async (s, e) => await Test()));
            buttons.Controls.Add(Ui.DangerBtn("Remove", async (s, e) => await Remove()));
            card.Body.Controls.Add(buttons);
            card.Body.Controls.Add(_status);
            Controls.Add(page);

            _provider.Items.AddRange(new object[] { "Gmail", "Outlook / Microsoft 365", "Other (SMTP)" });
            _provider.SelectedIndexChanged += (s, e) => ChooseProvider();
            Load += async (s, e) => await Reload();
        }

        private void ChooseProvider()
        {
            switch (_provider.SelectedIndex)
            {
                case 0:
                    _host.Text = "smtp.gmail.com";
                    _port.Text = "465";
                    _providerNote.Text = "Gmail needs an app password, not your normal password: turn on 2-Step Verification for the Google account, then create an app password at myaccount.google.com → Security → App passwords.";
                    break;
                case 1:
                    _host.Text = "smtp.office365.com";
                    _port.Text = "587";
                    _providerNote.Text = "Microsoft has been switching off password sign-in for sending email (SMTP), so this may not work. If the test email fails, use a Gmail account or an email service's SMTP details.";
                    break;
                default:
                    _providerNote.Text = "Use the SMTP details from your email service.";
                    break;
            }
        }

        private void Show(Dictionary<string, object> email)
        {
            var configured = J.Bool(email, "configured");
            _state.Text = configured
                ? "Set up: sending as " + J.Str(email, "fromAddress") + " through " + J.Str(email, "host") + (J.Str(email, "updatedAt") != null ? " · saved " + J.When(J.Str(email, "updatedAt")) : "")
                : "Not set up yet.";
            _state.ForeColor = configured ? Ui.Success : Theme.Text;
            var host = J.Str(email, "host");
            _provider.SelectedIndex = host == null || host == "smtp.gmail.com" ? 0 : host == "smtp.office365.com" ? 1 : 2;
            if (host != null) _host.Text = host;
            if (J.Int(email, "port") > 0) _port.Text = J.Int(email, "port").ToString();
            _username.Text = J.Str(email, "username") ?? "";
            _password.Text = "";
            _passwordHint.Text = J.Bool(email, "hasPassword") ? "Saved. Leave blank to keep it." : "";
            _fromAddress.Text = J.Str(email, "fromAddress") ?? "";
            _fromName.Text = J.Str(email, "fromName") ?? "Tohyee";
            if (!J.Bool(email, "secretsAvailable"))
            {
                Ui.Show(_status, "This server has no TOHYEE_SECRET_KEY, so the email password can't be stored. The Windows installer sets it when you update Tohyee.", true);
            }
        }

        private async Task Reload()
        {
            await Ui.Busy(this, _status, async () => Show(J.Obj(await _api.Get("/api/admin/email"), "email")));
        }

        private async Task Save()
        {
            int port;
            if (!int.TryParse(_port.Text.Trim(), out port))
            {
                Ui.Show(_status, "The port is a number, usually 465 or 587.", true);
                return;
            }
            var body = new Dictionary<string, object>
            {
                { "host", _host.Text.Trim() },
                { "port", port },
                { "username", _username.Text.Trim() },
                { "fromName", _fromName.Text.Trim() },
            };
            if (_password.Text.Length > 0) body["password"] = _password.Text;
            if (_fromAddress.Text.Trim().Length > 0) body["fromAddress"] = _fromAddress.Text.Trim();
            await Ui.Busy(this, _status, async () =>
            {
                Show(J.Obj(await _api.Put("/api/admin/email", body), "email"));
                Ui.Show(_status, "Saved. Send a test email to check it works.", false);
            });
        }

        private async Task Test()
        {
            await Ui.Busy(this, _status, async () =>
            {
                var result = await _api.Post("/api/admin/email/test", null);
                Ui.Show(_status, "Test email sent to " + J.Str(result, "to") + ". Check your inbox (and spam).", false);
            });
        }

        private async Task Remove()
        {
            if (!Ui.Confirm(FindForm(), "Remove the email settings? Security alerts and reset links stop being sent.")) return;
            await Ui.Busy(this, _status, async () =>
            {
                Show(J.Obj(await _api.Put("/api/admin/email", new Dictionary<string, object> { { "clear", true } }), "email"));
                Ui.Show(_status, "Email settings removed.", false);
            });
        }
    }
}

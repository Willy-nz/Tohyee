using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace Tohyee.Tray
{
    /// <summary>
    /// Users: logins for this server. Add someone (they get a setup link, #208),
    /// set a new password, make them a server admin or not, reset their two-step
    /// sign-in (lost phone) or send a new setup link, or turn their login off.
    /// </summary>
    internal sealed class UsersPage : UserControl
    {
        private readonly TohyeeApi _api;
        private readonly ListView _list = Ui.List("Name", "Email", "Server admin", "Two-step", "Login", "Organisations", "Last sign-in");
        private readonly Label _status = Ui.Status();
        /// <summary>The server has two-step sign-in on, so new logins get a setup link, not a password (#208).</summary>
        private bool _setupLinks = true;

        public UsersPage(TohyeeApi api)
        {
            _api = api;
            BackColor = Theme.Bg;
            var page = Ui.Page("Users", "Logins for this server. To give someone access to an organisation's books, its owner or an admin adds them under People and roles in Tohyee.");
            var card = Ui.Card(page, null, null);
            var buttons = Ui.Row();
            buttons.Margin = new Padding(0, 0, 0, 8);
            buttons.Controls.Add(Ui.Primary("New user…", async (s, e) => await Create()));
            buttons.Controls.Add(Ui.Btn("Set password…", async (s, e) => await SetPassword()));
            buttons.Controls.Add(Ui.Btn("Server admin on/off", async (s, e) => await ToggleAdmin()));
            buttons.Controls.Add(Ui.Btn("Reset two-step", async (s, e) => await ResetTwoStep()));
            buttons.Controls.Add(Ui.Btn("Send setup link", async (s, e) => await SendSetupLink()));
            buttons.Controls.Add(Ui.Btn("Login on/off", async (s, e) => await ToggleActive()));
            buttons.Controls.Add(Ui.Btn("Refresh", async (s, e) => await Reload()));
            card.Body.Controls.Add(buttons);
            _list.Height = Theme.S(320);
            card.Body.Controls.Add(_list);
            card.Body.Controls.Add(_status);
            Controls.Add(page);
            // Again when shown after a minute away (#198); the selected row stays selected.
            Ui.LoadWhenShown(this, Reload, TimeSpan.FromMinutes(1));
        }

        private async Task Reload()
        {
            await Ui.Busy(this, _status, async () =>
            {
                var answer = await _api.Get("/api/admin/users");
                var users = J.List(answer, "users");
                if (IsDisposed) return;
                _setupLinks = !answer.ContainsKey("twoStepRequired") || J.Bool(answer, "twoStepRequired");
                var selected = Ui.SelectedKey(_list, tag => J.Str((Dictionary<string, object>)tag, "id"));
                _list.BeginUpdate();
                _list.Items.Clear();
                foreach (var user in users)
                {
                    var item = new ListViewItem(new[]
                    {
                        J.Str(user, "displayName"),
                        J.Str(user, "email"),
                        J.Bool(user, "isServerAdmin") ? "Yes" : "",
                        J.Bool(user, "twoStepEnabled") ? "On" : J.Str(user, "setupLinkExpiresAt") != null ? "Setup link sent" : "Not set up",
                        J.Bool(user, "isActive") ? "On" : "Off",
                        J.Int(user, "organisationCount").ToString(),
                        J.When(J.Str(user, "lastLoginAt")),
                    })
                    { Tag = user };
                    if (!J.Bool(user, "isActive")) item.ForeColor = Ui.Muted;
                    _list.Items.Add(item);
                }
                Ui.FitColumns(_list);
                _list.EndUpdate();
                Ui.Reselect(_list, selected, tag => J.Str((Dictionary<string, object>)tag, "id"));
            });
        }

        private Dictionary<string, object> Selected()
        {
            if (_list.SelectedItems.Count == 0)
            {
                Ui.Show(_status, "Choose a user in the list first.", true);
                return null;
            }
            return (Dictionary<string, object>)_list.SelectedItems[0].Tag;
        }

        private string UserPath(Dictionary<string, object> user)
        {
            return "/api/admin/users/" + Uri.EscapeDataString(J.Str(user, "id"));
        }

        private async Task Change(Dictionary<string, object> user, Dictionary<string, object> body, string done)
        {
            if (await Ui.Busy(this, _status, async () =>
            {
                await _api.Patch(UserPath(user), body);
                Ui.Show(_status, done, false);
            }))
            {
                await Reload();
            }
        }

        private async Task Create()
        {
            using (var dialog = new NewUserDialog(_setupLinks))
            {
                if (dialog.ShowDialog(FindForm()) != DialogResult.OK) return;
                Dictionary<string, object> created = null;
                if (await Ui.Busy(this, _status, async () =>
                {
                    var body = new Dictionary<string, object>
                    {
                        { "displayName", dialog.DisplayName },
                        { "email", dialog.Email },
                        { "isServerAdmin", dialog.IsServerAdmin },
                    };
                    if (!_setupLinks) body["password"] = dialog.Password;
                    created = await _api.Post("/api/admin/users", body);
                    Ui.Show(_status, "Added " + dialog.Email + ".", false);
                }))
                {
                    ShowSetupLink(dialog.Email, J.Obj(created, "setupLink"));
                    await Reload();
                }
            }
        }

        /// <summary>The setup link to send (#208): the person chooses their password and sets up two-step with it.</summary>
        private void ShowSetupLink(string email, Dictionary<string, object> link)
        {
            if (link == null) return;
            using (var dialog = new SetupLinkDialog(email, J.Str(link, "url"), J.When(J.Str(link, "expiresAt")), J.Bool(link, "emailed"), J.Bool(link, "localOnly")))
            {
                dialog.ShowDialog(FindForm());
            }
        }

        private async Task SendSetupLink()
        {
            var user = Selected();
            if (user == null) return;
            if (J.Bool(user, "twoStepEnabled"))
            {
                Ui.Show(_status, J.Str(user, "email") + " has already set up two-step sign-in. If they've lost their phone, use Reset two-step.", true);
                return;
            }
            Dictionary<string, object> answer = null;
            if (await Ui.Busy(this, _status, async () =>
            {
                answer = await _api.Post(UserPath(user) + "/setup-link", new Dictionary<string, object>());
                Ui.Show(_status, "New setup link for " + J.Str(user, "email") + "; any earlier one stopped working.", false);
            }))
            {
                ShowSetupLink(J.Str(user, "email"), J.Obj(answer, "setupLink"));
                await Reload();
            }
        }

        private async Task SetPassword()
        {
            var user = Selected();
            if (user == null) return;
            using (var dialog = new PasswordDialog(J.Str(user, "email")))
            {
                if (dialog.ShowDialog(FindForm()) != DialogResult.OK) return;
                await Change(user, new Dictionary<string, object> { { "newPassword", dialog.Password } }, "Set a new password for " + J.Str(user, "email") + ".");
            }
        }

        private async Task ToggleAdmin()
        {
            var user = Selected();
            if (user == null) return;
            var on = !J.Bool(user, "isServerAdmin");
            if (!Ui.Confirm(FindForm(), on ? "Make " + J.Str(user, "email") + " a server admin? They'll be able to change these settings on this computer." : J.Str(user, "email") + " will no longer be a server admin.")) return;
            await Change(user, new Dictionary<string, object> { { "isServerAdmin", on } }, J.Str(user, "email") + (on ? " is now a server admin." : " is no longer a server admin."));
        }

        private async Task ToggleActive()
        {
            var user = Selected();
            if (user == null) return;
            var on = !J.Bool(user, "isActive");
            if (!Ui.Confirm(FindForm(), on ? "Turn " + J.Str(user, "email") + "'s login back on?" : "Turn off " + J.Str(user, "email") + "'s login? They're signed out and can't sign in until it's turned back on.")) return;
            await Change(user, new Dictionary<string, object> { { "isActive", on } }, J.Str(user, "email") + (on ? " can sign in again." : " can no longer sign in."));
        }

        private async Task ResetTwoStep()
        {
            var user = Selected();
            if (user == null) return;
            if (!Ui.Confirm(FindForm(), "Reset two-step sign-in for " + J.Str(user, "email") + "? Do this if they've lost their phone, and only if you're sure it's really them asking. They're signed out everywhere and get a setup link to set it up again.")) return;
            Dictionary<string, object> answer = null;
            if (await Ui.Busy(this, _status, async () =>
            {
                answer = await _api.Delete(UserPath(user) + "/two-step");
                Ui.Show(_status, "Two-step sign-in reset for " + J.Str(user, "email") + ".", false);
            }))
            {
                ShowSetupLink(J.Str(user, "email"), answer != null ? J.Obj(answer, "setupLink") : null);
                await Reload();
            }
        }
    }

    internal sealed class NewUserDialog : Form
    {
        private readonly TextBox _name = new TextBox();
        private readonly TextBox _email = new TextBox();
        private readonly TextBox _password = new TextBox { UseSystemPasswordChar = true };
        private readonly CheckBox _admin = new DarkCheckBox { Text = "Server admin (can change these server settings)", AutoSize = true };
        private readonly Label _error = Ui.Status();

        public string DisplayName { get { return _name.Text.Trim(); } }
        public string Email { get { return _email.Text.Trim(); } }
        public string Password { get { return _password.Text; } }
        public bool IsServerAdmin { get { return _admin.Checked; } }

        public NewUserDialog(bool setupLinks)
        {
            Text = "New user";
            Font = Ui.Body;
            FormBorderStyle = FormBorderStyle.FixedDialog;
            StartPosition = FormStartPosition.CenterParent;
            MinimizeBox = false;
            MaximizeBox = false;
            AutoSize = true;
            AutoSizeMode = AutoSizeMode.GrowAndShrink;
            var page = new FlowLayoutPanel { FlowDirection = FlowDirection.TopDown, AutoSize = true, Padding = new Padding(20), WrapContents = false };
            var form = Ui.Form();
            Ui.Field(form, "Name", _name);
            Ui.Field(form, "Email", _email);
            if (!setupLinks) Ui.Field(form, "Password", _password);
            page.Controls.Add(form);
            page.Controls.Add(_admin);
            page.Controls.Add(Ui.Note(setupLinks
                ? "They get a setup link (emailed if this server can send email; you can copy it too). With it they choose their own password and set up two-step sign-in, from anywhere."
                : "Give them the password privately. They can change it after signing in."));
            page.Controls.Add(_error);
            var ok = Ui.Primary("Add user", null);
            var cancel = Ui.Btn("Cancel", null);
            cancel.DialogResult = DialogResult.Cancel;
            ok.Click += (s, e) =>
            {
                if (DisplayName.Length == 0 || !Email.Contains("@")) Ui.Show(_error, "Enter their name and email.", true);
                else if (!setupLinks && Password.Length < 10) Ui.Show(_error, "Passwords need at least 10 characters.", true);
                else DialogResult = DialogResult.OK;
            };
            var buttons = Ui.Row();
            buttons.Controls.Add(ok);
            buttons.Controls.Add(cancel);
            page.Controls.Add(buttons);
            Controls.Add(page);
            AcceptButton = ok;
            CancelButton = cancel;
            Theme.Apply(this);
        }
    }

    /// <summary>A setup link to copy and send (#208).</summary>
    internal sealed class SetupLinkDialog : Form
    {
        public SetupLinkDialog(string email, string url, string until, bool emailed, bool localOnly)
        {
            Text = "Setup link for " + email;
            Font = Ui.Body;
            FormBorderStyle = FormBorderStyle.FixedDialog;
            StartPosition = FormStartPosition.CenterParent;
            MinimizeBox = false;
            MaximizeBox = false;
            AutoSize = true;
            AutoSizeMode = AutoSizeMode.GrowAndShrink;
            var page = new FlowLayoutPanel { FlowDirection = FlowDirection.TopDown, AutoSize = true, Padding = new Padding(20), WrapContents = false };
            page.Controls.Add(Ui.Note((emailed ? "It was emailed to " + email + ". " : "This server can't send email, so send it to them yourself (a text or message). ")
                + "It works once, until " + until + ". With it they choose their password and set up two-step sign-in."));
            var box = Ui.Input(new TextBox { Text = url, ReadOnly = true, Width = Theme.S(560) });
            page.Controls.Add(box);
            if (localOnly) page.Controls.Add(new Label { Text = "Remote access is off, so this link only works on the same network as this server.", ForeColor = Theme.Warning, AutoSize = true, MaximumSize = new System.Drawing.Size(Theme.S(560), 0), Margin = new Padding(0, 8, 0, 0) });
            var copied = Ui.Status();
            var copy = Ui.Primary("Copy link", (s, e) =>
            {
                try
                {
                    Clipboard.SetText(url);
                    Ui.Show(copied, "Copied.", false);
                }
                catch (Exception)
                {
                    box.SelectAll();
                    box.Focus();
                    Ui.Show(copied, "Couldn't copy; select the link and press Ctrl+C.", true);
                }
            });
            var close = Ui.Btn("Close", null);
            close.DialogResult = DialogResult.OK;
            var buttons = Ui.Row();
            buttons.Margin = new Padding(0, 12, 0, 0);
            buttons.Controls.Add(copy);
            buttons.Controls.Add(close);
            page.Controls.Add(buttons);
            page.Controls.Add(copied);
            Controls.Add(page);
            AcceptButton = close;
            CancelButton = close;
            Theme.Apply(this);
        }
    }

    internal sealed class PasswordDialog : Form
    {
        private readonly TextBox _password = new TextBox { UseSystemPasswordChar = true };
        private readonly TextBox _again = new TextBox { UseSystemPasswordChar = true };
        private readonly Label _error = Ui.Status();

        public string Password { get { return _password.Text; } }

        public PasswordDialog(string email)
        {
            Text = "New password for " + email;
            Font = Ui.Body;
            FormBorderStyle = FormBorderStyle.FixedDialog;
            StartPosition = FormStartPosition.CenterParent;
            MinimizeBox = false;
            MaximizeBox = false;
            AutoSize = true;
            AutoSizeMode = AutoSizeMode.GrowAndShrink;
            var page = new FlowLayoutPanel { FlowDirection = FlowDirection.TopDown, AutoSize = true, Padding = new Padding(20), WrapContents = false };
            var form = Ui.Form();
            Ui.Field(form, "New password", _password);
            Ui.Field(form, "Again", _again);
            page.Controls.Add(form);
            page.Controls.Add(_error);
            var ok = Ui.Primary("Set password", null);
            var cancel = Ui.Btn("Cancel", null);
            cancel.DialogResult = DialogResult.Cancel;
            ok.Click += (s, e) =>
            {
                if (Password.Length < 10) Ui.Show(_error, "Passwords need at least 10 characters.", true);
                else if (Password != _again.Text) Ui.Show(_error, "The two passwords don't match.", true);
                else DialogResult = DialogResult.OK;
            };
            var buttons = Ui.Row();
            buttons.Controls.Add(ok);
            buttons.Controls.Add(cancel);
            page.Controls.Add(buttons);
            Controls.Add(page);
            AcceptButton = ok;
            CancelButton = cancel;
            Theme.Apply(this);
        }
    }
}

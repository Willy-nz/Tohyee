using System;
using System.Drawing;
using System.Windows.Forms;

namespace Tohyee.Tray
{
    /// <summary>
    /// The server settings window. Signing in as a server admin (with two-step
    /// sign-in) comes first; then Organisations, Users, Remote access, Email and
    /// Updates. Nothing here touches the books.
    /// </summary>
    internal sealed class ServerSettingsForm : Form
    {
        private readonly TohyeeApi _api;
        private readonly TraySettings _settings;
        private readonly Panel _body = new Panel { Dock = DockStyle.Fill };
        private readonly Label _who = new Label { AutoSize = true, ForeColor = Color.White, Anchor = AnchorStyles.Right };

        public ServerSettingsForm(TohyeeApi api, TraySettings settings)
        {
            _api = api;
            _settings = settings;
            Text = "Tohyee server settings";
            Font = Ui.Body;
            ClientSize = new Size(840, 600);
            MinimumSize = new Size(640, 480);
            StartPosition = FormStartPosition.CenterScreen;
            ShowInTaskbar = true;

            var header = new TableLayoutPanel { Dock = DockStyle.Top, Height = 48, BackColor = Color.FromArgb(59, 7, 100), ColumnCount = 3, Padding = new Padding(16, 0, 16, 0) };
            header.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
            header.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            header.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
            header.Controls.Add(new Label { Text = "Tohyee server", ForeColor = Color.White, Font = new Font("Segoe UI Semibold", 12f), AutoSize = true, Anchor = AnchorStyles.Left }, 0, 0);
            header.Controls.Add(new Label { Text = "This computer only · the books are in the browser", ForeColor = Color.FromArgb(221, 214, 254), AutoSize = true, Anchor = AnchorStyles.Left, Margin = new Padding(16, 0, 0, 0) }, 1, 0);
            header.Controls.Add(_who, 2, 0);

            Controls.Add(_body);
            Controls.Add(header);
            ShowSignIn();
        }

        private void Swap(Control content)
        {
            _body.SuspendLayout();
            foreach (Control old in _body.Controls) old.Dispose();
            _body.Controls.Clear();
            content.Dock = DockStyle.Fill;
            _body.Controls.Add(content);
            _body.ResumeLayout();
        }

        private void ShowSignIn()
        {
            _who.Text = "";
            Swap(new SignInPage(_api, _settings, ShowSettings));
        }

        private void ShowSettings()
        {
            _who.Text = _api.SignedInEmail ?? "";
            var tabs = new TabControl { Dock = DockStyle.Fill, Padding = new Point(14, 6) };
            tabs.TabPages.Add(Tab("Organisations", new OrganisationsPage(_api)));
            tabs.TabPages.Add(Tab("Users", new UsersPage(_api)));
            tabs.TabPages.Add(Tab("Remote access", new RemoteAccessPage(_api)));
            tabs.TabPages.Add(Tab("Email", new EmailPage(_api)));
            var backupsTab = Tab("Backups", new BackupsPage(_api));
            tabs.TabPages.Add(backupsTab);
            tabs.TabPages.Add(Tab("Updates", new UpdatesPage(_api)));

            var signOut = Ui.Btn("Sign out", async (s, e) =>
            {
                await _api.SignOut();
                ShowSignIn();
            });
            var bottom = new FlowLayoutPanel { Dock = DockStyle.Bottom, Height = 44, FlowDirection = FlowDirection.RightToLeft, Padding = new Padding(12, 8, 12, 8) };
            bottom.Controls.Add(signOut);
            bottom.Controls.Add(Ui.Btn("Open Tohyee (the books)", (s, e) => TrayApp.Open(_settings.BooksUrl)));

            var panel = new Panel();
            panel.Controls.Add(tabs);
            panel.Controls.Add(bottom);
            Swap(panel);
            RemindAboutBackupKey(tabs, backupsTab);
        }

        /// <summary>Until a saved copy of the backup key has been checked, open on the Backups tab and say why.</summary>
        private async void RemindAboutBackupKey(TabControl tabs, TabPage backupsTab)
        {
            try
            {
                var result = await _api.Get("/api/admin/backups");
                var keyStatus = J.Obj(result, "keyStatus");
                if (!J.Bool(keyStatus, "keySet") || J.Str(keyStatus, "savedCopyCheckedAt") != null || tabs.IsDisposed) return;
                tabs.SelectedTab = backupsTab;
                MessageBox.Show(this,
                    "Save a copy of your backup key.\n\nBackups can only be opened with it, so if this computer is lost or rebuilt without a copy, the backups can't be restored. Use \"Show the key\", save it in a password manager, then \"Check my saved copy\".",
                    "Tohyee", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
            catch (ApiException)
            {
                // The Backups tab shows the problem itself.
            }
        }

        private static TabPage Tab(string title, Control page)
        {
            var tab = new TabPage(title) { UseVisualStyleBackColor = true };
            page.Dock = DockStyle.Fill;
            tab.Controls.Add(page);
            return tab;
        }
    }

    /// <summary>Sign in as a server admin: email and password, then the authenticator code.</summary>
    internal sealed class SignInPage : UserControl
    {
        public SignInPage(TohyeeApi api, TraySettings settings, Action signedIn)
        {
            var page = Ui.Page();
            page.Padding = new Padding(40, 32, 40, 16);
            page.Controls.Add(Ui.Title("Sign in"));
            page.Controls.Add(Ui.Note("Sign in with your Tohyee login. Only server admins can change the server settings."));
            var form = Ui.Form();
            var email = Ui.Field(form, "Email", new TextBox());
            var password = Ui.Field(form, "Password", new TextBox { UseSystemPasswordChar = true });
            var codeLabel = new Label { Text = "Code", AutoSize = true, Anchor = AnchorStyles.Left, Margin = new Padding(0, 6, 12, 6), Visible = false };
            var code = new TextBox { Dock = DockStyle.Fill, Margin = new Padding(0, 3, 0, 3), Visible = false };
            form.RowCount += 1;
            form.Controls.Add(codeLabel);
            form.Controls.Add(code);
            page.Controls.Add(form);
            var status = Ui.Status();
            var stage = "password";
            Button go = null;
            go = Ui.Btn("Sign in", async (s, e) =>
            {
                status.Text = "";
                await Ui.Busy(this, status, async () =>
                {
                    if (stage == "password")
                    {
                        stage = await api.SignIn(email.Text.Trim(), password.Text);
                        if (stage == "full")
                        {
                            signedIn();
                        }
                        else if (stage == "verify")
                        {
                            codeLabel.Visible = true;
                            code.Visible = true;
                            email.Enabled = false;
                            password.Enabled = false;
                            Ui.Show(status, "Enter the 6-digit code from your authenticator app (or a backup code).", false);
                            code.Focus();
                        }
                        else
                        {
                            stage = "password";
                            Ui.Show(status, "Set up two-step sign-in first: sign in to Tohyee in the browser once (" + settings.BooksUrl + "), then come back here.", true);
                        }
                    }
                    else
                    {
                        await api.Verify(email.Text.Trim(), code.Text.Trim());
                        signedIn();
                    }
                });
            });
            var buttons = Ui.Row();
            buttons.Controls.Add(go);
            page.Controls.Add(buttons);
            page.Controls.Add(status);
            Controls.Add(page);
            Load += (s, e) =>
            {
                var parentForm = FindForm();
                if (parentForm != null) parentForm.AcceptButton = go;
                email.Focus();
            };
        }
    }
}

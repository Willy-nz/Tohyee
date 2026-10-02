using System;
using System.Collections.Generic;
using System.Drawing;
using System.Windows.Forms;

namespace Tohyee.Tray
{
    /// <summary>What the window needs from the rest of the app (the demo mode swaps in sample versions).</summary>
    internal sealed class AppServices
    {
        public TohyeeApi Api;
        public TraySettings Settings;
        public ITailscale Tailscale;
        public ICloudflare Cloudflare;
        public NewsFeed News;
        /// <summary>The server's state as the tray icon last saw it.</summary>
        public Func<ServerInfo> Server;
    }

    internal sealed class ServerInfo
    {
        public ServerState State;
        public string Text;
        public string Version;
        public TimeSpan? Uptime;
    }

    /// <summary>
    /// The server settings window. Signing in as a server admin (with two-step
    /// sign-in) comes first; then a sidebar with Home, Organisations, Users,
    /// Remote access, Backups, Email, Stats and Updates. Nothing here touches the books.
    /// </summary>
    internal sealed class ServerSettingsForm : Form
    {
        private readonly AppServices _app;
        private readonly Panel _content = new Panel { Dock = DockStyle.Fill, BackColor = Theme.Bg };
        private readonly Dictionary<string, Control> _pages = new Dictionary<string, Control>();
        private Sidebar _sidebar;
        private BackupsPage _backupsPage;
        private bool _backUpWhenSignedIn;
        private bool _updatesWhenSignedIn;

        public string Current { get; private set; }

        public ServerSettingsForm(AppServices app)
        {
            _app = app;
            Text = "Tohyee server";
            Font = Ui.Body;
            BackColor = Theme.Bg;
            ForeColor = Theme.Text;
            // As big as it's designed for, but never bigger than the screen.
            var screen = Screen.PrimaryScreen.WorkingArea;
            ClientSize = new Size(Math.Min(Theme.S(1120), screen.Width - 40), Math.Min(Theme.S(760), screen.Height - 60));
            MinimumSize = new Size(Math.Min(Theme.S(900), screen.Width - 40), Math.Min(Theme.S(600), screen.Height - 60));
            StartPosition = FormStartPosition.CenterScreen;
            ShowInTaskbar = true;
            if (Theme.AppIcon != null) Icon = Theme.AppIcon;
            ShowSignIn();
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            Theme.DarkTitleBar(this);
        }

        private void Clear()
        {
            SuspendLayout();
            var pages = new List<Control>(_pages.Values);
            _pages.Clear();
            _content.Controls.Clear();
            foreach (var page in pages) page.Dispose();
            _backupsPage = null;
            Current = null;
            var old = new List<Control>();
            foreach (Control control in Controls) old.Add(control);
            Controls.Clear();
            foreach (var control in old)
            {
                if (control != _content) control.Dispose();
            }
            _sidebar = null;
            ResumeLayout();
        }

        private void ShowSignIn()
        {
            Clear();
            Controls.Add(new SignInPage(_app.Api, _app.Settings, ShowSettings) { Dock = DockStyle.Fill });
        }

        internal void ShowSettings()
        {
            Clear();
            SuspendLayout();
            _sidebar = new Sidebar(_app.Api.SignedInEmail, Navigate, () => TrayApp.Open(_app.Settings.BooksUrl), async () =>
            {
                await _app.Api.SignOut();
                ShowSignIn();
            });
            Controls.Add(_content);
            Controls.Add(_sidebar);
            ResumeLayout();
            Navigate("home");
            RemindAboutBackupKey();
            if (_updatesWhenSignedIn)
            {
                _updatesWhenSignedIn = false;
                Navigate("updates");
            }
            if (_backUpWhenSignedIn)
            {
                _backUpWhenSignedIn = false;
                StartBackUp();
            }
        }

        private Control Create(string key)
        {
            switch (key)
            {
                case "home": return new HomePage(_app, Navigate);
                case "organisations": return new OrganisationsPage(_app.Api);
                case "users": return new UsersPage(_app.Api);
                case "phone": return new RemoteAccessPage(_app.Api, _app.Settings, _app.Tailscale, _app.Cloudflare);
                case "backups": return _backupsPage = new BackupsPage(_app.Api);
                case "email": return new EmailPage(_app.Api);
                case "updates": return new UpdatesPage(_app);
                case "stats": return new StatsPage(_app.Api);
                default: throw new ArgumentException(key);
            }
        }

        /// <summary>Shows a page (made the first time it's opened, then kept, like tabs).</summary>
        public void Navigate(string key)
        {
            if (_sidebar == null || _sidebar.IsDisposed) return;
            Control page;
            if (!_pages.TryGetValue(key, out page))
            {
                page = Create(key);
                page.Dock = DockStyle.Fill;
                page.Visible = false;
                _pages[key] = page;
                _content.Controls.Add(page);
            }
            SetPage(key, page);
        }

        /// <summary>The screenshots mode: shows a page made elsewhere under a sidebar item.</summary>
        internal void ShowPage(string key, Control page)
        {
            Control old;
            if (_pages.TryGetValue(key, out old))
            {
                _content.Controls.Remove(old);
                old.Dispose();
            }
            page.Dock = DockStyle.Fill;
            _pages[key] = page;
            _content.Controls.Add(page);
            SetPage(key, page);
        }

        private void SetPage(string key, Control page)
        {
            _content.SuspendLayout();
            foreach (var other in _pages.Values)
            {
                if (other != page) other.Visible = false;
            }
            page.Visible = true;
            page.BringToFront();
            _content.ResumeLayout();
            Current = key;
            _sidebar.Select(key);
        }

        /// <summary>
        /// The tray menu's and Start menu's "Back up now": the same encrypted
        /// backups as the nightly ones, run straight away on the Backups page.
        /// Signing in comes first if needed.
        /// </summary>
        public void BackUpNow()
        {
            if (_sidebar != null && !_sidebar.IsDisposed) StartBackUp();
            else _backUpWhenSignedIn = true;
        }

        /// <summary>The tray's "an update is available" notification: opens Updates (signing in first if needed).</summary>
        public void OpenUpdates()
        {
            if (_sidebar != null && !_sidebar.IsDisposed) Navigate("updates");
            else _updatesWhenSignedIn = true;
        }

        private void StartBackUp()
        {
            Navigate("backups");
            var page = _backupsPage;
            BeginInvoke((Action)(async () => await page.BackUpNow()));
        }

        /// <summary>Until a saved copy of the backup key has been checked, open on Backups and say why.</summary>
        private async void RemindAboutBackupKey()
        {
            if (_app.Api.IsDemo) return;
            try
            {
                var result = await _app.Api.Get("/api/admin/backups");
                var keyStatus = J.Obj(result, "keyStatus");
                if (!J.Bool(keyStatus, "keySet") || J.Str(keyStatus, "savedCopyCheckedAt") != null || _sidebar == null || _sidebar.IsDisposed) return;
                Navigate("backups");
                MessageBox.Show(this,
                    "Save a copy of your backup key.\n\nBackups can only be opened with it, so if this computer is lost or rebuilt without a copy, the backups can't be restored. Use \"Show the key\", save it in a password manager, then \"Check my saved copy\".",
                    "Tohyee", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
            catch (ApiException)
            {
                // The Backups page shows the problem itself.
            }
        }
    }

    /// <summary>The left side of the window: the logo, the pages, and who's signed in.</summary>
    internal sealed class Sidebar : Panel
    {
        private readonly List<NavItem> _items = new List<NavItem>();
        private readonly Picture _logo = Picture.Logo(36);
        private readonly Label _name = new Label { Text = "Tohyee", Font = Theme.F("Segoe UI Semibold", 14f), ForeColor = Color.White, AutoSize = true, BackColor = Theme.Sidebar };
        private readonly Label _kind = new Label { Text = "SERVER", Font = Theme.SmallCaps, ForeColor = Theme.AccentText, AutoSize = true, BackColor = Theme.Sidebar };
        private readonly Label _who = new Label { ForeColor = Theme.Muted, Font = Theme.Small, AutoSize = false, AutoEllipsis = true, BackColor = Theme.Sidebar };
        private readonly FlatButton _open;
        private readonly NavItem _signOut;

        public Sidebar(string email, Action<string> navigate, Action openBooks, Action signOut)
        {
            Dock = DockStyle.Left;
            Width = Theme.S(236);
            BackColor = Theme.Sidebar;
            SetStyle(ControlStyles.OptimizedDoubleBuffer | ControlStyles.AllPaintingInWmPaint | ControlStyles.ResizeRedraw, true);
            _logo.BackColor = Theme.Sidebar;
            Controls.Add(_logo);
            Controls.Add(_name);
            Controls.Add(_kind);
            Add(navigate, "home", "Home", Glyph.Home);
            Add(navigate, "organisations", "Organisations", Glyph.Organisations);
            Add(navigate, "users", "Users", Glyph.Users);
            Add(navigate, "phone", "Remote access", Glyph.Phone);
            Add(navigate, "backups", "Backups", Glyph.Backups);
            Add(navigate, "email", "Email", Glyph.Email);
            Add(navigate, "stats", "Stats", Glyph.Stats);
            Add(navigate, "updates", "Updates", Glyph.Updates);

            _who.Text = "Signed in as\n" + (email ?? "");
            Controls.Add(_who);
            _open = new FlatButton("Open Tohyee (the books)", ButtonKind.Primary) { AutoSize = false, Height = Theme.S(36) };
            _open.Click += (s, e) => openBooks();
            Controls.Add(_open);
            _signOut = new NavItem("signout", "Sign out", Glyph.SignOut);
            _signOut.Click += (s, e) => signOut();
            Controls.Add(_signOut);
        }

        private void Add(Action<string> navigate, string key, string text, Glyph glyph)
        {
            var item = new NavItem(key, text, glyph);
            item.Click += (s, e) => navigate(key);
            _items.Add(item);
            Controls.Add(item);
        }

        public void Select(string key)
        {
            foreach (var item in _items) item.Selected = item.Key == key;
        }

        protected override void OnLayout(LayoutEventArgs levent)
        {
            base.OnLayout(levent);
            if (_open == null || _signOut == null) return; // still being built
            var side = Theme.S(12);
            var width = Width - side * 2 - 1;
            var item40 = Theme.S(40);
            _logo.Location = new Point(side + Theme.S(8), Theme.S(22));
            var block = _name.Height + _kind.Height - Theme.S(2);
            _name.Location = new Point(_logo.Right + Theme.S(10), _logo.Top + (_logo.Height - block) / 2 - Theme.S(2));
            _kind.Location = new Point(_logo.Right + Theme.S(12), _name.Bottom - Theme.S(2));
            var y = Theme.S(92);
            foreach (var item in _items)
            {
                item.SetBounds(side, y, width, item40);
                y += item40 + Theme.S(2);
            }
            var bottom = Height - Theme.S(16);
            _signOut.SetBounds(side, bottom - item40, width, item40);
            _open.SetBounds(side, _signOut.Top - Theme.S(46), width, Theme.S(36));
            var who = TextRenderer.MeasureText("Signed in as\nx", _who.Font).Height;
            _who.SetBounds(side + Theme.S(8), _open.Top - who - Theme.S(8), width - Theme.S(8), who);
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            using (var pen = new Pen(Color.FromArgb(34, 38, 45))) e.Graphics.DrawLine(pen, Width - 1, 0, Width - 1, Height);
        }
    }

    /// <summary>Sign in as a server admin: email and password, then the authenticator code.</summary>
    internal sealed class SignInPage : UserControl
    {
        private readonly Card _card = new Card();

        public SignInPage(TohyeeApi api, TraySettings settings, Action signedIn)
        {
            BackColor = Theme.Bg;
            _card.Width = Theme.S(480);
            var body = _card.Body;
            var brand = new FlowLayoutPanel { AutoSize = true, WrapContents = false, BackColor = Theme.Card, Margin = new Padding(0, 0, 0, 14) };
            brand.Controls.Add(Picture.Logo(52));
            var words = new FlowLayoutPanel { FlowDirection = FlowDirection.TopDown, AutoSize = true, WrapContents = false, BackColor = Theme.Card, Margin = new Padding(12, 2, 0, 0) };
            words.Controls.Add(new Label { Text = "Tohyee server", Font = Theme.Big, ForeColor = Theme.Text, AutoSize = true, Margin = new Padding(0) });
            words.Controls.Add(new Label { Text = "Server settings on this computer", ForeColor = Theme.Muted, AutoSize = true, Margin = new Padding(2, 0, 0, 0) });
            brand.Controls.Add(words);
            body.Controls.Add(brand);
            body.Controls.Add(Ui.Note("Sign in with your Tohyee login. Only server admins can change the server settings."));
            var form = Ui.Form();
            form.ColumnStyles[0].Width = Theme.S(90);
            form.ColumnStyles[1].Width = Theme.S(330);
            var email = Ui.Field(form, "Email", new TextBox());
            var password = Ui.Field(form, "Password", new TextBox { UseSystemPasswordChar = true });
            var codeLabel = new Label { Text = "Code", AutoSize = true, ForeColor = Theme.Muted, Anchor = AnchorStyles.Left, Margin = new Padding(0, 7, 12, 7), Visible = false };
            var code = Ui.Input(new TextBox { Dock = DockStyle.Fill, Margin = new Padding(0, 4, 0, 4), Visible = false });
            form.RowCount += 1;
            form.Controls.Add(codeLabel);
            form.Controls.Add(code);
            body.Controls.Add(form);
            var status = Ui.Status();
            var stage = "password";
            Button go = null;
            go = Ui.Primary("Sign in", async (s, e) =>
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
            go.Margin = new Padding(Theme.S(90), Theme.S(8), 0, 0);
            body.Controls.Add(go);
            body.Controls.Add(status);
            Controls.Add(_card);
            Load += (s, e) =>
            {
                var parentForm = FindForm();
                if (parentForm != null) parentForm.AcceptButton = go;
                email.Focus();
            };
        }

        protected override void OnLayout(LayoutEventArgs e)
        {
            base.OnLayout(e);
            _card.Location = new Point(Math.Max(16, (Width - _card.Width) / 2), Math.Max(16, (Height - _card.Height) / 2 - 30));
        }
    }
}

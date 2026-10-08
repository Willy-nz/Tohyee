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
    /// sign-in) comes first; then a sidebar with Home; Organisations and Users;
    /// Backups and Updates; Remote access, Email and Analytics; and Stats. Nothing here touches the books.
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
        /// <summary>Goes up each time the window signs in or out, so work started for an earlier session can tell (#198).</summary>
        private int _session;
        /// <summary>Goes up each time a page is shown.</summary>
        private int _navigations;

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
            MinimumSize = new Size(Math.Min(Theme.S(900), screen.Width - 40), Math.Min(Theme.S(640), screen.Height - 60));
            StartPosition = FormStartPosition.CenterScreen;
            ShowInTaskbar = true;
            if (Theme.AppIcon != null) Icon = Theme.AppIcon;
            ShowSignIn();
        }

        /// <summary>
        /// Paints the whole window in one go (WS_EX_COMPOSITED), so switching pages
        /// doesn't show each card and button being drawn one after another.
        /// </summary>
        protected override CreateParams CreateParams
        {
            get
            {
                var cp = base.CreateParams;
                if (Environment.OSVersion.Platform == PlatformID.Win32NT) cp.ExStyle |= 0x02000000;
                return cp;
            }
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            Theme.DarkTitleBar(this);
        }

        private void Clear()
        {
            _session++;
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
                case "home": return new HomePage(_app, Navigate, SetBadge);
                case "organisations": return new OrganisationsPage(_app.Api);
                case "users": return new UsersPage(_app.Api);
                case "phone": return new RemoteAccessPage(_app.Api, _app.Settings, _app.Tailscale, _app.Cloudflare);
                case "backups": return _backupsPage = new BackupsPage(_app.Api);
                case "analytics": return new AnalyticsPage(_app.Api);
                case "email": return new EmailPage(_app.Api);
                case "updates": return new UpdatesPage(_app);
                case "stats": return new StatsPage(_app.Api);
                default: throw new ArgumentException(key);
            }
        }

        /// <summary>Home's checks set the sidebar's badges (Backups, Updates, Organisations, Remote access).</summary>
        private void SetBadge(string key, int count, Color colour)
        {
            if (_sidebar != null && !_sidebar.IsDisposed) _sidebar.SetBadge(key, count, colour);
        }

        /// <summary>Shows a page (made the first time it's opened, then kept, like tabs).</summary>
        public void Navigate(string key)
        {
            if (_sidebar == null || _sidebar.IsDisposed) return;
            Control page;
            if (!_pages.TryGetValue(key, out page))
            {
                page = Create(key);
                // Made at its full size and laid out while hidden: a new page used to
                // appear first at its default 150 x 150 (a squashed copy with scroll
                // bars in the corner), then in pieces, then properly (2 Oct 2026).
                page.Visible = false;
                page.Bounds = _content.ClientRectangle;
                page.Dock = DockStyle.Fill;
                _pages[key] = page;
                _content.Controls.Add(page);
                page.CreateControl();
                page.PerformLayout();
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
            _navigations++;
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
            // #198: the answer can take a while. If the person has opened another page (or signed
            // out and in) meanwhile, the reminder doesn't pull them away; it comes again next time.
            var session = _session;
            var navigations = _navigations;
            try
            {
                var result = await _app.Api.Get("/api/admin/backups");
                var keyStatus = J.Obj(result, "keyStatus");
                if (!J.Bool(keyStatus, "keySet") || J.Str(keyStatus, "savedCopyCheckedAt") != null || _sidebar == null || _sidebar.IsDisposed) return;
                if (session != _session || navigations != _navigations || IsDisposed) return;
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

    /// <summary>
    /// The left side of the window: the logo, the pages in groups (People, Keep
    /// safe, Connect, Server) with a badge where something needs attention, and
    /// who's signed in (the server app redesign, approved by Jess on 9 Oct 2026).
    /// </summary>
    internal sealed class Sidebar : Panel
    {
        private readonly List<NavItem> _items = new List<NavItem>();
        /// <summary>Group headings and items, top to bottom.</summary>
        private readonly List<Control> _order = new List<Control>();
        private readonly Picture _logo = Picture.Logo(36);
        private readonly Label _name = new Label { Text = "Tohyee", Font = Theme.F("Segoe UI Semibold", 14f), ForeColor = Color.White, AutoSize = true, BackColor = Theme.Sidebar };
        private readonly Label _kind = new Label { Text = "SERVER", Font = Theme.SmallCaps, ForeColor = Theme.AccentText, AutoSize = true, BackColor = Theme.Sidebar };
        private readonly Label _who = new Label { ForeColor = Theme.Muted, Font = Theme.Small, AutoSize = false, AutoEllipsis = true, BackColor = Theme.Sidebar };
        private readonly LinkLabel _signOut = new LinkLabel { Text = "Sign out", Font = Theme.Small, AutoSize = true, BackColor = Theme.Sidebar, LinkBehavior = LinkBehavior.HoverUnderline };
        private readonly FlatButton _open;

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
            Group("People");
            Add(navigate, "organisations", "Organisations", Glyph.Organisations);
            Add(navigate, "users", "Users", Glyph.Users);
            Group("Keep safe");
            Add(navigate, "backups", "Backups", Glyph.Backups);
            Add(navigate, "updates", "Updates", Glyph.Updates);
            Group("Connect");
            Add(navigate, "phone", "Remote access", Glyph.Phone);
            Add(navigate, "email", "Email", Glyph.Email);
            Add(navigate, "analytics", "Analytics", Glyph.Stats);
            Group("Server");
            Add(navigate, "stats", "Stats", Glyph.Stats);

            _who.Text = "Signed in as " + (email ?? "");
            Controls.Add(_who);
            _signOut.LinkColor = Theme.AccentText;
            _signOut.ActiveLinkColor = Color.White;
            _signOut.VisitedLinkColor = Theme.AccentText;
            _signOut.LinkClicked += (s, e) => signOut();
            Controls.Add(_signOut);
            _open = new FlatButton("Open Tohyee (the books)", ButtonKind.Primary) { AutoSize = false, Height = Theme.S(36) };
            _open.Click += (s, e) => openBooks();
            Controls.Add(_open);
        }

        private void Group(string text)
        {
            var heading = new Label { Text = text.ToUpperInvariant(), Font = Theme.SmallCaps, ForeColor = Theme.Muted, AutoSize = true, BackColor = Theme.Sidebar };
            _order.Add(heading);
            Controls.Add(heading);
        }

        private void Add(Action<string> navigate, string key, string text, Glyph glyph)
        {
            var item = new NavItem(key, text, glyph);
            item.Click += (s, e) => navigate(key);
            _items.Add(item);
            _order.Add(item);
            Controls.Add(item);
        }

        public void Select(string key)
        {
            foreach (var item in _items) item.Selected = item.Key == key;
        }

        /// <summary>A badge on a page's item: how many things there need attention (0 removes it).</summary>
        public void SetBadge(string key, int count, Color colour)
        {
            foreach (var item in _items)
            {
                if (item.Key == key) item.SetBadge(count, colour);
            }
        }

        protected override void OnLayout(LayoutEventArgs levent)
        {
            base.OnLayout(levent);
            if (_open == null) return; // still being built
            var side = Theme.S(12);
            var width = Width - side * 2 - 1;
            var itemHeight = Theme.S(36);
            _logo.Location = new Point(side + Theme.S(8), Theme.S(22));
            var block = _name.Height + _kind.Height - Theme.S(2);
            _name.Location = new Point(_logo.Right + Theme.S(10), _logo.Top + (_logo.Height - block) / 2 - Theme.S(2));
            _kind.Location = new Point(_logo.Right + Theme.S(12), _name.Bottom - Theme.S(2));
            var y = Theme.S(80);
            foreach (var control in _order)
            {
                if (control is NavItem)
                {
                    control.SetBounds(side, y, width, itemHeight);
                    y += itemHeight + Theme.S(2);
                }
                else
                {
                    y += Theme.S(10);
                    control.Location = new Point(side + Theme.S(12), y);
                    y += control.Height + Theme.S(4);
                }
            }
            var bottom = Height - Theme.S(16);
            _open.SetBounds(side, bottom - Theme.S(36), width, Theme.S(36));
            var line = TextRenderer.MeasureText("x", _who.Font).Height;
            _signOut.Location = new Point(side + Theme.S(8), _open.Top - Theme.S(8) - _signOut.Height);
            _who.SetBounds(side + Theme.S(8), _signOut.Top - line - Theme.S(2), width - Theme.S(8), line);
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

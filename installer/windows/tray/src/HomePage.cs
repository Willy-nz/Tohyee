using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Linq;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace Tohyee.Tray
{
    /// <summary>
    /// Home (the redesign Jess approved on 9 Oct 2026, from the mock-up on #198):
    /// the title with the server's state beside it and Open Tohyee; a "Needs
    /// attention" card, only when something does; four quick looks (last backup,
    /// remote access, organisations, email), two to a row in a narrow window; and
    /// the latest news as a short list, the conference with it. What needs
    /// attention also puts a badge on that page in the sidebar.
    /// </summary>
    internal sealed class HomePage : UserControl
    {
        private readonly AppServices _app;
        private readonly Action<string> _navigate;
        private readonly Action<string, int, Color> _badge;
        private readonly StatusPill _pill = new StatusPill();
        private readonly Card _attention = new Card { Fill = Color.FromArgb(46, 42, 29), Border = Color.FromArgb(90, 74, 26) };
        private readonly FlowLayoutPanel _attentionItems = new FlowLayoutPanel { FlowDirection = FlowDirection.TopDown, WrapContents = false, AutoSize = true, Margin = new Padding(0), Tag = "stretch" };
        private readonly Tile _backup;
        private readonly Tile _phone;
        private readonly Tile _organisations;
        private readonly Tile _email;
        private readonly Card _news = new Card();
        private readonly FlowLayoutPanel _newsItems = new FlowLayoutPanel { FlowDirection = FlowDirection.TopDown, WrapContents = false, AutoSize = true, BackColor = Theme.Card, Margin = new Padding(0), Tag = "stretch" };
        private readonly Timer _timer = new Timer { Interval = 5000 };
        /// <summary>What each check found that needs attention, by page (the server's own state under "server").</summary>
        private readonly Dictionary<string, List<Attention>> _found = new Dictionary<string, List<Attention>>();
        private bool _loading;

        public HomePage(AppServices app, Action<string> navigate, Action<string, int, Color> badge)
        {
            _app = app;
            _navigate = navigate;
            _badge = badge;
            BackColor = Theme.Bg;
            var page = new PageFlow();

            // The title, the server's state and Open Tohyee, on one line.
            var top = new TableLayoutPanel { ColumnCount = 4, RowCount = 1, AutoSize = false, Height = Theme.S(48), BackColor = Theme.Bg, Margin = new Padding(0, 0, 0, Theme.S(12)), Tag = "stretch" };
            top.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
            top.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
            top.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            top.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
            top.Controls.Add(new Label { Text = "Home", Font = Theme.PageTitle, ForeColor = Theme.Text, AutoSize = true, Anchor = AnchorStyles.Left, Margin = new Padding(0, 0, Theme.S(14), 0) }, 0, 0);
            _pill.Anchor = AnchorStyles.Left;
            top.Controls.Add(_pill, 1, 0);
            var open = Ui.Primary("Open Tohyee", (s, e) => TrayApp.Open(_app.Settings.BooksUrl));
            open.Anchor = AnchorStyles.Right;
            open.Margin = new Padding(Theme.S(12), 0, 0, 0);
            top.Controls.Add(open, 3, 0);
            page.Controls.Add(top);

            // Needs attention (hidden while nothing does).
            _attention.Body.BackColor = _attention.Fill;
            _attentionItems.BackColor = _attention.Fill;
            _attention.Body.Controls.Add(new Label { Text = "NEEDS ATTENTION", Font = Theme.SmallCaps, ForeColor = Theme.Warning, AutoSize = true, BackColor = _attention.Fill, Margin = new Padding(0, 0, 0, Theme.S(6)) });
            _attention.Body.Controls.Add(_attentionItems);
            _attention.Visible = false;
            page.Controls.Add(_attention);

            // Quick looks.
            _backup = new Tile("Last backup", () => navigate("backups"));
            _phone = new Tile("Remote access", () => navigate("phone"));
            _organisations = new Tile("Organisations", () => navigate("organisations"));
            _email = new Tile("Email", () => navigate("email"));
            page.Controls.Add(new CardGrid(new[] { _backup.Card, _phone.Card, _organisations.Card, _email.Card }, Theme.S(170)));

            // News.
            _news.Body.Controls.Add(new Label { Text = "Latest news", Font = Theme.CardTitle, ForeColor = Theme.Text, AutoSize = true, BackColor = Theme.Card, Margin = new Padding(0, 0, 0, Theme.S(6)) });
            _news.Body.Controls.Add(_newsItems);
            page.Controls.Add(_news);

            Controls.Add(page);
            ShowNews(null);
            ShowServer();
            _timer.Tick += (s, e) => ShowServer();
            Load += async (s, e) =>
            {
                _timer.Start();
                // The news doesn't wait for the server's checks, nor they for it (#198).
                var news = LoadNews();
                await Reload();
                await news;
            };
            VisibleChanged += async (s, e) =>
            {
                // The server's state only ticks while Home is showing (#198).
                if (Visible) _timer.Start();
                else _timer.Stop();
                if (Visible && IsHandleCreated) await Reload();
            };
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing) _timer.Dispose();
            base.Dispose(disposing);
        }

        private void ShowServer()
        {
            if (IsDisposed) return;
            var info = _app.Server != null ? _app.Server() : null;
            var state = info == null ? ServerState.Checking : info.State;
            var parts = new List<string>();
            parts.Add(state == ServerState.Running ? "Running"
                : state == ServerState.Starting ? "Starting…"
                : state == ServerState.Checking ? "Checking…"
                : "Not running");
            if (info != null && info.Version != null) parts.Add("v" + info.Version);
            if (info != null && info.Uptime.HasValue && state == ServerState.Running) parts.Add("up " + Ui.Duration(info.Uptime.Value));
            _pill.Show(string.Join(" · ", parts), state == ServerState.Running ? Theme.Success : state == ServerState.Starting || state == ServerState.Checking ? Theme.Warning : Theme.Danger);
            var problems = new List<Attention>();
            if (state != ServerState.Running && state != ServerState.Starting && state != ServerState.Checking)
            {
                problems.Add(new Attention("Tohyee isn't running.", info != null && info.Text != null ? info.Text : "Nobody can use the books until it starts. Its log is in " + _app.Settings.LogsDir + ".", null, null, Theme.Danger));
            }
            Found("server", problems);
        }

        /// <summary>The quick looks, from the server (each on its own, so one problem doesn't hide the rest).</summary>
        private async Task Reload()
        {
            if (_loading) return;
            _loading = true;
            try
            {
                ShowServer();
                // What can need attention first, so the card (which pushes the rest down) comes early.
                await ShowBackup();
                if (IsDisposed) return;
                await ShowUpdates();
                if (IsDisposed) return;
                await ShowPhone();
                if (IsDisposed) return;
                await ShowOrganisations();
                if (IsDisposed) return;
                await ShowEmail();
            }
            catch (ObjectDisposedException) when (IsDisposed)
            {
                // Signed out or closed while the answers were on their way (#198).
            }
            finally
            {
                _loading = false;
            }
        }

        private async Task ShowBackup()
        {
            var problems = new List<Attention>();
            try
            {
                var result = await _app.Api.Get("/api/admin/backups");
                var settings = J.Obj(result, "settings");
                var keyStatus = J.Obj(result, "keyStatus");
                DateTime? last = null;
                var failed = false;
                var never = false;
                foreach (var entry in J.List(result, "status"))
                {
                    var good = J.Obj(entry, "lastGood");
                    var latest = J.Obj(entry, "latest");
                    if (latest != null && J.Str(latest, "status") == "failed") failed = true;
                    DateTime when;
                    if (good == null) never = true;
                    else if (DateTime.TryParse(J.Str(good, "finishedAt"), System.Globalization.CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.AdjustToUniversal | System.Globalization.DateTimeStyles.AssumeUniversal, out when))
                    {
                        if (!last.HasValue || when > last.Value) last = when;
                    }
                }
                var keySet = J.Bool(settings, "keySet");
                var schedule = !keySet ? "No backup key on this server"
                    : J.Bool(settings, "enabled") ? "Every night at " + (J.Str(settings, "time") ?? "02:00")
                    : "Nightly backups are off";
                if (failed) _backup.Show("Failed", schedule, Theme.Danger);
                else if (!last.HasValue) _backup.Show("Never", schedule, Theme.Warning);
                else _backup.Show(Ago(last.Value), schedule + (never ? " · some not yet" : ""), J.Bool(settings, "enabled") ? Theme.Success : Theme.Warning);

                if (!keySet)
                {
                    problems.Add(new Attention("There's no backup key on this server.", "Backups can't be made until one is set.", "Open Backups", "backups", Theme.Warning));
                }
                else if (keyStatus != null && J.Bool(keyStatus, "keySet") && J.Str(keyStatus, "savedCopyCheckedAt") == null)
                {
                    problems.Add(new Attention("Save a copy of your backup key.", "Backups can't be restored without it.", "Show the key", "backups", Theme.Warning));
                }
                if (failed) problems.Add(new Attention("The last backup failed.", "The Backups page says why.", "Open Backups", "backups", Theme.Danger));
                else if (keySet && !J.Bool(settings, "enabled")) problems.Add(new Attention("Nightly backups are off.", "Nothing is backed up until they're on again or you back up by hand.", "Open Backups", "backups", Theme.Warning));
            }
            catch (ApiException)
            {
                _backup.Show("—", "Couldn't check", Theme.Muted);
            }
            Found("backups", problems);
        }

        private async Task ShowPhone()
        {
            var problems = new List<Attention>();
            try
            {
                var remote = J.Obj(await _app.Api.Get("/api/admin/remote-access"), "remoteAccess");
                var method = J.Str(remote, "method") ?? "cloudflare";
                var url = J.Str(remote, "publicUrl");
                var connected = method == "tailscale" ? J.Bool(remote, "enabled") : J.Str(J.Obj(remote, "tunnel"), "status") == "connected";
                if (connected && url != null)
                {
                    _phone.Show("On", Host(url), Theme.Success);
                }
                else if (J.Bool(remote, "enabled"))
                {
                    var way = method == "tailscale" ? "Tailscale Funnel" : method == "tohyee" ? "Tohyee address" : "Your own domain (Cloudflare)";
                    _phone.Show("Not connected", way, Theme.Warning);
                    problems.Add(new Attention("Remote access is on but not connected.", "Phones and other computers can't reach the books (" + way + ").", "Open Remote access", "phone", Theme.Warning));
                }
                else
                {
                    _phone.Show("Off", "Choose a way to turn it on", Theme.Muted);
                }
            }
            catch (ApiException)
            {
                _phone.Show("—", "Couldn't check", Theme.Muted);
            }
            Found("phone", problems);
        }

        private static string Host(string url)
        {
            Uri uri;
            return Uri.TryCreate(url, UriKind.Absolute, out uri) ? uri.Host : url;
        }

        private static string Ago(DateTime utc)
        {
            var span = DateTime.UtcNow - utc;
            if (span.TotalMinutes < 2) return "Just now";
            if (span.TotalHours < 1) return (int)span.TotalMinutes + " min ago";
            if (span.TotalHours < 24) return (int)span.TotalHours + (span.TotalHours < 2 ? " hour ago" : " hours ago");
            return (int)span.TotalDays + (span.TotalDays < 2 ? " day ago" : " days ago");
        }

        private async Task ShowOrganisations()
        {
            var problems = new List<Attention>();
            try
            {
                var organisations = J.List(await _app.Api.Get("/api/admin/organisations"), "organisations");
                var active = organisations.Where(o => J.Bool(o, "isActive")).ToList();
                var broken = active.Count(o => J.Str(o, "provisioningStatus") == "failed" || J.Str(o, "migrationStatus") == "failed");
                var people = active.Sum(o => J.Int(o, "memberCount"));
                if (broken > 0)
                {
                    _organisations.Show(active.Count.ToString(), broken + (broken == 1 ? " needs attention" : " need attention"), Theme.Danger);
                    problems.Add(new Attention(broken == 1 ? "An organisation couldn't be set up or upgraded." : broken + " organisations couldn't be set up or upgraded.", "Nobody can open them until it's sorted.", "Open Organisations", "organisations", Theme.Danger));
                }
                else if (active.Count == 0) _organisations.Show("0", "Create the first one", Theme.Muted);
                else _organisations.Show(active.Count.ToString(), "In use · " + people + (people == 1 ? " person" : " people"), Color.Empty);
            }
            catch (ApiException)
            {
                _organisations.Show("—", "Couldn't check", Theme.Muted);
            }
            Found("organisations", problems);
        }

        private async Task ShowEmail()
        {
            try
            {
                var email = J.Obj(await _app.Api.Get("/api/admin/email"), "email");
                if (J.Bool(email, "configured")) _email.Show("Set up", J.Str(email, "fromAddress") ?? J.Str(email, "host") ?? "", Theme.Success);
                else _email.Show("Not set up", "For security alerts and sign-in resets", Theme.Muted);
            }
            catch (ApiException)
            {
                _email.Show("—", "Couldn't check", Theme.Muted);
            }
        }

        private async Task ShowUpdates()
        {
            var problems = new List<Attention>();
            try
            {
                var updates = await _app.Api.Get("/api/admin/updates");
                if (J.Bool(updates, "updateAvailable") && J.Str(updates, "latestVersion") != null)
                {
                    problems.Add(new Attention("Tohyee v" + J.Str(updates, "latestVersion") + " is available.", "Install backs up every organisation first.", "Review update", "updates", Theme.Warning));
                }
                var blocked = J.List(updates, "blockedOrganisations").Count;
                if (blocked > 0)
                {
                    problems.Add(new Attention(blocked == 1 ? "An organisation wasn't upgraded." : blocked + " organisations weren't upgraded.", "The Updates page says why.", "Open Updates", "updates", Theme.Danger));
                }
            }
            catch (ApiException)
            {
                // The Updates page shows the problem itself.
            }
            Found("updates", problems);
        }

        /// <summary>Keeps what a check found, then redraws Needs attention and that page's sidebar badge.</summary>
        private void Found(string key, List<Attention> problems)
        {
            if (IsDisposed) return;
            List<Attention> before;
            if (_found.TryGetValue(key, out before) && before.Select(a => a.Headline).SequenceEqual(problems.Select(a => a.Headline))) return;
            _found[key] = problems;
            if (key != "server")
            {
                var colour = problems.Any(a => a.Colour == Theme.Danger) ? Theme.Danger : Theme.Warning;
                if (_badge != null) _badge(key, problems.Count, colour);
            }
            ShowAttention();
        }

        private void ShowAttention()
        {
            var order = new[] { "server", "backups", "updates", "organisations", "phone" };
            var all = order.Where(k => _found.ContainsKey(k)).SelectMany(k => _found[k]).ToList();
            _attentionItems.SuspendLayout();
            foreach (var old in _attentionItems.Controls.Cast<Control>().ToList()) old.Dispose();
            _attentionItems.Controls.Clear();
            foreach (var item in all) _attentionItems.Controls.Add(AttentionRow(item));
            _attentionItems.ResumeLayout();
            _attention.Visible = all.Count > 0;
            _attention.Refit();
        }

        private Control AttentionRow(Attention item)
        {
            var fill = _attention.Fill;
            var row = new TableLayoutPanel { ColumnCount = 2, RowCount = 1, AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, BackColor = fill, Margin = new Padding(0, Theme.S(4), 0, Theme.S(4)), Tag = "stretch" };
            row.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            row.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
            var words = new FlowLayoutPanel { FlowDirection = FlowDirection.TopDown, WrapContents = false, AutoSize = true, BackColor = fill, Margin = new Padding(0), Anchor = AnchorStyles.Left };
            var headline = new Label { Text = item.Headline, Font = Theme.Strong, ForeColor = item.Colour == Theme.Danger ? Theme.Danger : Theme.Text, AutoSize = true, BackColor = fill, Margin = new Padding(0) };
            var detail = new Label { Text = item.Detail, ForeColor = Theme.Muted, AutoSize = true, BackColor = fill, Margin = new Padding(0, Theme.S(2), 0, 0) };
            words.Controls.Add(headline);
            words.Controls.Add(detail);
            row.Controls.Add(words, 0, 0);
            Control button = null;
            if (item.Action != null)
            {
                var page = item.Page;
                button = Ui.Btn(item.Action, (s, e) => _navigate(page));
                button.Anchor = AnchorStyles.Right;
                button.Margin = new Padding(Theme.S(12), 0, 0, 0);
                row.Controls.Add(button, 1, 0);
            }
            row.SizeChanged += (s, e) =>
            {
                var room = Math.Max(Theme.S(120), row.Width - (button != null ? button.Width + button.Margin.Horizontal : 0));
                headline.MaximumSize = new Size(room, 0);
                detail.MaximumSize = new Size(room, 0);
            };
            return row;
        }

        private async Task LoadNews()
        {
            try
            {
                ShowNews(await _app.News.Load(false));
            }
            catch (Exception)
            {
                ShowNews(new NewsResult { Offline = true, Conference = NewsFeed.DefaultConference });
            }
        }

        private void ShowNews(NewsResult news)
        {
            if (IsDisposed) return;
            _newsItems.SuspendLayout();
            foreach (var old in _newsItems.Controls.Cast<Control>().ToList()) old.Dispose();
            _newsItems.Controls.Clear();
            if (news == null)
            {
                _newsItems.Controls.Add(Muted("Loading news…"));
            }
            else
            {
                var items = news.Items.Where(i => i.Kind != "conference").Take(3).ToList();
                if (items.Count == 0) _newsItems.Controls.Add(Muted(news.Offline ? "Couldn't load news. It'll try again later." : "No news yet."));
                var first = true;
                foreach (var item in items)
                {
                    _newsItems.Controls.Add(NewsRow(item.Kind == "release" ? "RELEASE" : "NEWS", item, first));
                    first = false;
                }
                _newsItems.Controls.Add(NewsRow("CONFERENCE", news.Conference ?? NewsFeed.DefaultConference, first));
                if (news.Offline && news.FetchedAt.HasValue && items.Count > 0)
                {
                    _newsItems.Controls.Add(Muted("Offline: news from " + news.FetchedAt.Value.ToString("d MMM h:mm tt", System.Globalization.CultureInfo.GetCultureInfo("en-NZ")) + "."));
                }
            }
            var all = new LinkLabel { Text = "All releases on GitHub", AutoSize = true, Margin = new Padding(0, Theme.S(8), 0, 0) };
            StyleLink(all, Theme.AccentText);
            all.LinkClicked += (s, e) => TrayApp.Open(NewsFeed.ReleasesPage);
            _newsItems.Controls.Add(all);
            _newsItems.ResumeLayout();
            _news.Refit();
        }

        private static Label Muted(string text)
        {
            return new Label { Text = text, ForeColor = Theme.Muted, AutoSize = true, Tag = "wrap", BackColor = Theme.Card, Margin = new Padding(0, Theme.S(4), 0, Theme.S(4)) };
        }

        private static void StyleLink(LinkLabel link, Color colour)
        {
            link.LinkColor = colour;
            link.ActiveLinkColor = Color.White;
            link.VisitedLinkColor = colour;
            link.LinkBehavior = LinkBehavior.HoverUnderline;
            link.BackColor = Theme.Card;
        }

        /// <summary>One line of news: what it is and when, then its title (a link when there's more to read) and a short summary.</summary>
        private Control NewsRow(string kind, NewsItem item, bool first)
        {
            var row = new FlowLayoutPanel { FlowDirection = FlowDirection.LeftToRight, WrapContents = false, AutoSize = true, BackColor = Theme.Card, Margin = new Padding(0), Padding = new Padding(0, Theme.S(7), 0, Theme.S(7)), Tag = "stretch" };
            if (!first)
            {
                // A hairline above every row but the first.
                row.Paint += (s, e) =>
                {
                    using (var pen = new Pen(Theme.CardBorder)) e.Graphics.DrawLine(pen, 0, 0, row.Width, 0);
                };
            }
            var date = item.Kind == "conference" ? "" : NewsFeed.FormatDate(item.Date);
            var tagWidth = Theme.S(130);
            row.Controls.Add(new Label
            {
                Text = kind + (date.Length > 0 ? " · " + date : ""),
                Font = Theme.Small,
                ForeColor = item.Kind == "release" ? Theme.AccentText : item.Kind == "conference" ? Theme.AccentText : Theme.Warning,
                AutoSize = false,
                AutoEllipsis = true,
                Width = tagWidth,
                Height = Theme.S(20),
                BackColor = Theme.Card,
                Margin = new Padding(0, Theme.S(1), Theme.S(10), 0),
            });
            var words = new FlowLayoutPanel { FlowDirection = FlowDirection.TopDown, WrapContents = false, AutoSize = true, BackColor = Theme.Card, Margin = new Padding(0) };
            Label title;
            if (item.Link != null)
            {
                var link = new LinkLabel { Text = item.Title, AutoSize = true, Margin = new Padding(0) };
                StyleLink(link, Theme.Text);
                var url = item.Link;
                link.LinkClicked += (s, e) => TrayApp.Open(url);
                title = link;
            }
            else
            {
                title = new Label { Text = item.Title, ForeColor = Theme.Text, AutoSize = true, BackColor = Theme.Card, Margin = new Padding(0) };
            }
            words.Controls.Add(title);
            var summary = Summary(item);
            Label more = null;
            if (summary != null)
            {
                more = new Label { Text = summary, ForeColor = Theme.Muted, Font = Theme.Small, AutoSize = true, BackColor = Theme.Card, Margin = new Padding(0, Theme.S(1), 0, 0) };
                words.Controls.Add(more);
            }
            row.Controls.Add(words);
            row.SizeChanged += (s, e) =>
            {
                var room = Math.Max(Theme.S(120), row.Width - tagWidth - Theme.S(10));
                title.MaximumSize = new Size(room, 0);
                if (more != null) more.MaximumSize = new Size(room, 0);
            };
            return row;
        }

        /// <summary>The first sentence of an item's text, kept short; the conference says where and when.</summary>
        private static string Summary(NewsItem item)
        {
            if (item.Kind == "conference") return "Ōtepoti Dunedin · date to be confirmed";
            if (string.IsNullOrEmpty(item.Body)) return null;
            var text = item.Body.Trim();
            var stop = text.IndexOf(". ", StringComparison.Ordinal);
            if (stop > 0) text = text.Substring(0, stop + 1);
            if (text.Length <= 80) return text;
            var cut = text.LastIndexOf(' ', 77);
            return text.Substring(0, cut > 30 ? cut : 77).TrimEnd(' ', ',', ';') + "…";
        }

        /// <summary>Something that needs attention: what, why, and the page that sorts it.</summary>
        private sealed class Attention
        {
            public readonly string Headline;
            public readonly string Detail;
            public readonly string Action;
            public readonly string Page;
            public readonly Color Colour;

            public Attention(string headline, string detail, string action, string page, Color colour)
            {
                Headline = headline;
                Detail = detail;
                Action = action;
                Page = page;
                Colour = colour;
            }
        }

        /// <summary>The server's state beside the title: a dot and a few words in a rounded outline.</summary>
        private sealed class StatusPill : Control
        {
            private Color _colour = Theme.Muted;

            public StatusPill()
            {
                SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
                Font = Theme.Body;
                BackColor = Theme.Bg;
                Margin = new Padding(0);
                Show("Checking…", Theme.Warning);
            }

            public void Show(string text, Color colour)
            {
                if (Text == text && _colour == colour) return;
                Text = text;
                _colour = colour;
                var size = TextRenderer.MeasureText(text, Font);
                Size = new Size(size.Width + Theme.S(40), Math.Max(Theme.S(30), size.Height + Theme.S(12)));
                Invalidate();
            }

            protected override void OnPaint(PaintEventArgs e)
            {
                var g = e.Graphics;
                g.Clear(Theme.BackOf(this));
                g.SmoothingMode = SmoothingMode.AntiAlias;
                using (var path = Theme.Rounded(new RectangleF(0.5f, 0.5f, Width - 1.5f, Height - 1.5f), (Height - 1.5f) / 2f))
                using (var fill = new SolidBrush(Theme.Card))
                using (var pen = new Pen(Theme.CardBorder))
                {
                    g.FillPath(fill, path);
                    g.DrawPath(pen, path);
                }
                var dot = Theme.S(9);
                using (var brush = new SolidBrush(_colour)) g.FillEllipse(brush, Theme.S(13), (Height - dot) / 2f, dot, dot);
                TextRenderer.DrawText(g, Text, Font, new Rectangle(Theme.S(28), 0, Width - Theme.S(30), Height), Theme.Muted, TextFormatFlags.VerticalCenter | TextFormatFlags.Left | TextFormatFlags.SingleLine);
            }
        }

        /// <summary>A quick look: a label, a big value, a line under it; click to go to its page. Grey bars until it's loaded.</summary>
        private sealed class Tile
        {
            public readonly Card Card = new Card();
            private readonly Dot _dot = new Dot { Margin = new Padding(0, Theme.S(11), Theme.S(8), 0), Visible = false };
            private readonly Label _value = new Label { Font = Theme.Big, ForeColor = Theme.Text, AutoSize = true, Margin = new Padding(0), Visible = false };
            private readonly Label _detail = new Label { ForeColor = Theme.Muted, Font = Theme.Small, AutoSize = false, AutoEllipsis = true, Margin = new Padding(0, Theme.S(2), 0, 0), Visible = false };
            private readonly Picture _loading;

            public Tile(string title, Action open)
            {
                Card.Body.Controls.Add(new Label { Text = title.ToUpperInvariant(), Font = Theme.SmallCaps, ForeColor = Theme.Muted, AutoSize = true, BackColor = Theme.Card, Margin = new Padding(0, 0, 0, Theme.S(6)) });
                var row = new FlowLayoutPanel { AutoSize = true, WrapContents = false, BackColor = Theme.Card, Margin = new Padding(0) };
                row.Controls.Add(_dot);
                row.Controls.Add(_value);
                Card.Body.Controls.Add(row);
                _detail.Height = TextRenderer.MeasureText("Xg", Theme.Small).Height + Theme.S(2);
                Card.Body.Controls.Add(_detail);
                _loading = new Picture(new Size(Theme.S(140), Theme.S(48)), (g, r) =>
                {
                    using (var brush = new SolidBrush(Color.FromArgb(48, 53, 61)))
                    {
                        using (var top = Theme.Rounded(new RectangleF(0, Theme.S(6), r.Width, Theme.S(20)), Theme.S(5))) g.FillPath(brush, top);
                        using (var bottom = Theme.Rounded(new RectangleF(0, Theme.S(34), r.Width * 0.65f, Theme.S(11)), Theme.S(4))) g.FillPath(brush, bottom);
                    }
                }) { BackColor = Theme.Card, Margin = new Padding(0) };
                Card.Body.Controls.Add(_loading);
                Clickable(Card, open);
                Card.Body.SizeChanged += (s, e) => _detail.Width = Card.InnerWidth;
            }

            private static void Clickable(Control control, Action open)
            {
                control.Click += (s, e) => open();
                control.Cursor = Cursors.Hand;
                foreach (Control child in control.Controls) Clickable(child, open);
            }

            /// <summary>The value and the line under it. Color.Empty: no dot (a plain count).</summary>
            public void Show(string value, string detail, Color colour)
            {
                _value.Text = value;
                _detail.Text = detail;
                _dot.Visible = colour != Color.Empty;
                if (colour != Color.Empty) _dot.Colour = colour;
                _value.Visible = true;
                _detail.Visible = true;
                _detail.Width = Card.InnerWidth;
                _loading.Visible = false;
            }
        }
    }
}

using System;
using System.Collections.Generic;
using System.Drawing;
using System.Linq;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace Tohyee.Tray
{
    /// <summary>
    /// Home: whether the server is running, quick looks at remote access, the
    /// last backup and the organisations, the latest Tohyee news, and the
    /// conference card.
    /// </summary>
    internal sealed class HomePage : UserControl
    {
        private readonly AppServices _app;
        private readonly Dot _serverDot = new Dot { Size = new Size(Theme.S(14), Theme.S(14)), Margin = new Padding(0, Theme.S(11), Theme.S(10), 0) };
        private readonly Label _serverState = new Label { Font = Theme.Big, ForeColor = Theme.Text, AutoSize = true, Margin = new Padding(0) };
        private readonly Label _serverDetail = new Label { ForeColor = Theme.Muted, AutoSize = true, Margin = new Padding(0, 2, 0, 0) };
        private readonly Tile _phone;
        private readonly Tile _backup;
        private readonly Tile _organisations;
        private readonly Card _news = new Card();
        private readonly FlowLayoutPanel _newsItems = new FlowLayoutPanel { FlowDirection = FlowDirection.TopDown, WrapContents = false, AutoSize = true, BackColor = Theme.Card, Margin = new Padding(0), Tag = "stretch" };
        private readonly Card _conference = new Card { Strip = Theme.Accent };
        private readonly Timer _timer = new Timer { Interval = 5000 };
        private bool _loading;

        public HomePage(AppServices app, Action<string> navigate)
        {
            _app = app;
            BackColor = Theme.Bg;
            var page = Ui.Page("Home", null);
            page.Controls[0].Margin = new Padding(0, 0, 0, 16);

            // The server.
            var hero = Ui.Card(page, null, null);
            var heroRow = new TableLayoutPanel { ColumnCount = 3, RowCount = 1, AutoSize = true, BackColor = Theme.Card, Margin = new Padding(0), Tag = "stretch" };
            heroRow.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
            heroRow.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            heroRow.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
            var logo = Picture.Logo(64);
            logo.Margin = new Padding(0, 0, Theme.S(18), 0);
            heroRow.Controls.Add(logo, 0, 0);
            var words = new FlowLayoutPanel { FlowDirection = FlowDirection.TopDown, AutoSize = true, WrapContents = false, BackColor = Theme.Card, Margin = new Padding(0, 4, 0, 0) };
            var stateRow = new FlowLayoutPanel { AutoSize = true, WrapContents = false, BackColor = Theme.Card, Margin = new Padding(0) };
            stateRow.Controls.Add(_serverDot);
            stateRow.Controls.Add(_serverState);
            words.Controls.Add(stateRow);
            words.Controls.Add(_serverDetail);
            heroRow.Controls.Add(words, 1, 0);
            var open = Ui.Primary("Open Tohyee", (s, e) => TrayApp.Open(_app.Settings.BooksUrl));
            open.Anchor = AnchorStyles.Right;
            open.Margin = new Padding(12, 0, 0, 0);
            heroRow.Controls.Add(open, 2, 0);
            hero.Body.Controls.Add(heroRow);

            // Quick looks.
            _phone = new Tile("Remote access", Glyph.Phone, () => navigate("phone"));
            _backup = new Tile("Last backup", Glyph.Backups, () => navigate("backups"));
            _organisations = new Tile("Organisations", Glyph.Organisations, () => navigate("organisations"));
            page.Controls.Add(new SplitRow(new[] { _phone.Card, _backup.Card, _organisations.Card }, new[] { 1f, 1f, 1f }));

            // News and the conference.
            var newsHead = new FlowLayoutPanel { AutoSize = true, WrapContents = false, BackColor = Theme.Card, Margin = new Padding(0, 0, 0, 8) };
            var newsIcon = Picture.Icon(Glyph.News, 20, Theme.AccentText);
            newsIcon.Margin = new Padding(0, 3, 8, 0);
            newsHead.Controls.Add(newsIcon);
            newsHead.Controls.Add(new Label { Text = "Latest news", Font = Theme.CardTitle, ForeColor = Theme.Text, AutoSize = true, Margin = new Padding(0) });
            _news.Body.Controls.Add(newsHead);
            _news.Body.Controls.Add(_newsItems);
            page.Controls.Add(new SplitRow(new[] { _news, _conference }, new[] { 1.7f, 1f }));

            Controls.Add(page);
            ShowNews(null);
            ShowServer();
            _timer.Tick += (s, e) => ShowServer();
            Load += async (s, e) =>
            {
                _timer.Start();
                // The news doesn't wait for the server's status checks, nor they for it (#198).
                var news = LoadNews();
                await Reload();
                await news;
            };
            VisibleChanged += async (s, e) =>
            {
                // The server line only ticks while Home is showing (#198).
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
            var info = _app.Server != null ? _app.Server() : null;
            var state = info == null ? ServerState.Checking : info.State;
            _serverDot.Colour = state == ServerState.Running ? Theme.Success : state == ServerState.Starting || state == ServerState.Checking ? Theme.Warning : Theme.Danger;
            _serverState.Text = state == ServerState.Running ? "Tohyee is running"
                : state == ServerState.Starting ? "Tohyee is starting…"
                : state == ServerState.Checking ? "Checking Tohyee…"
                : info != null && info.Text != null ? info.Text : "Tohyee isn't running";
            var parts = new List<string>();
            if (info != null && info.Version != null) parts.Add("Version " + info.Version);
            if (info != null && info.Uptime.HasValue && state == ServerState.Running) parts.Add("Up " + Ui.Duration(info.Uptime.Value));
            parts.Add("The books are at " + _app.Settings.BooksUrl);
            _serverDetail.Text = string.Join("  ·  ", parts);
        }

        /// <summary>The quick looks, from the server (each one on its own, so one problem doesn't hide the rest).</summary>
        private async Task Reload()
        {
            if (_loading) return;
            _loading = true;
            try
            {
                ShowServer();
                await ShowPhone();
                if (IsDisposed) return;
                await ShowBackup();
                if (IsDisposed) return;
                await ShowOrganisations();
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

        private async Task ShowPhone()
        {
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
                    _phone.Show("Not connected", method == "tailscale" ? "Tailscale Funnel" : method == "tohyee" ? "Tohyee address" : "Your own domain (Cloudflare)", Theme.Warning);
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
        }

        private static string Host(string url)
        {
            Uri uri;
            return Uri.TryCreate(url, UriKind.Absolute, out uri) ? uri.Host : url;
        }

        private async Task ShowBackup()
        {
            try
            {
                var result = await _app.Api.Get("/api/admin/backups");
                var settings = J.Obj(result, "settings");
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
                var schedule = !J.Bool(settings, "keySet") ? "No backup key on this server"
                    : J.Bool(settings, "enabled") ? "Every night at " + (J.Str(settings, "time") ?? "02:00")
                    : "Nightly backups are off";
                if (failed) _backup.Show("Failed", "The last backup failed · " + schedule, Theme.Danger);
                else if (!last.HasValue) _backup.Show("Never", schedule, Theme.Warning);
                else _backup.Show(Ago(last.Value), schedule + (never ? " · some not yet" : ""), J.Bool(settings, "enabled") ? Theme.Success : Theme.Warning);
            }
            catch (ApiException)
            {
                _backup.Show("—", "Couldn't check", Theme.Muted);
            }
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
            try
            {
                var organisations = J.List(await _app.Api.Get("/api/admin/organisations"), "organisations");
                var active = organisations.Where(o => J.Bool(o, "isActive")).ToList();
                var problems = active.Count(o => J.Str(o, "provisioningStatus") == "failed" || J.Str(o, "migrationStatus") == "failed");
                var people = active.Sum(o => J.Int(o, "memberCount"));
                if (problems > 0) _organisations.Show(active.Count.ToString(), problems + (problems == 1 ? " needs attention" : " need attention"), Theme.Danger);
                else if (active.Count == 0) _organisations.Show("0", "Create the first one", Theme.Muted);
                else _organisations.Show(active.Count.ToString(), "In use · " + people + (people == 1 ? " person" : " people"), Theme.Success);
            }
            catch (ApiException)
            {
                _organisations.Show("—", "Couldn't check", Theme.Muted);
            }
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
            var width = Math.Max(200, _news.InnerWidth);
            if (news == null)
            {
                _newsItems.Controls.Add(Muted("Loading news…", width));
            }
            else if (news.Items.Count == 0)
            {
                _newsItems.Controls.Add(Muted(news.Offline ? "Couldn't load news. It'll try again later." : "No news yet.", width));
            }
            else
            {
                var first = true;
                foreach (var item in news.Items.Take(4))
                {
                    _newsItems.Controls.Add(NewsEntry(item, width, first));
                    first = false;
                }
                if (news.Offline && news.FetchedAt.HasValue)
                {
                    _newsItems.Controls.Add(Muted("Offline: news from " + news.FetchedAt.Value.ToString("d MMM h:mm tt", System.Globalization.CultureInfo.GetCultureInfo("en-NZ")) + ".", width));
                }
            }
            var all = new LinkLabel { Text = "All releases on GitHub", AutoSize = true, Margin = new Padding(0, 10, 0, 0) };
            StyleLink(all);
            all.LinkClicked += (s, e) => TrayApp.Open(NewsFeed.ReleasesPage);
            _newsItems.Controls.Add(all);
            _newsItems.ResumeLayout();
            ShowConference(news != null && news.Conference != null ? news.Conference : NewsFeed.DefaultConference);
            _news.Refit();
        }

        private static Label Muted(string text, int width)
        {
            return new Label { Text = text, ForeColor = Theme.Muted, AutoSize = true, Tag = "wrap", MaximumSize = new Size(width, 0), Margin = new Padding(0, 4, 0, 4) };
        }

        private static void StyleLink(LinkLabel link)
        {
            link.LinkColor = Theme.AccentText;
            link.ActiveLinkColor = Color.White;
            link.VisitedLinkColor = Theme.AccentText;
            link.LinkBehavior = LinkBehavior.HoverUnderline;
            link.BackColor = Theme.Card;
        }

        private Control NewsEntry(NewsItem item, int width, bool first)
        {
            var entry = new FlowLayoutPanel { FlowDirection = FlowDirection.TopDown, WrapContents = false, AutoSize = true, BackColor = Theme.Card, Margin = new Padding(0, first ? 2 : 12, 0, 0), Tag = "stretch" };
            if (!first)
            {
                entry.Controls.Add(new Panel { Height = 1, Width = width, BackColor = Theme.CardBorder, Margin = new Padding(0, 0, 0, 12), Tag = "stretch" });
            }
            var kind = item.Kind == "release" ? "RELEASE" : "NEWS";
            entry.Controls.Add(new Label { Text = kind + "  ·  " + NewsFeed.FormatDate(item.Date), Font = Theme.SmallCaps, ForeColor = item.Kind == "release" ? Theme.AccentText : Theme.Warning, AutoSize = true, Margin = new Padding(0, 0, 0, 2) });
            entry.Controls.Add(new Label { Text = item.Title, Font = Theme.Strong, ForeColor = Theme.Text, AutoSize = true, Tag = "wrap", MaximumSize = new Size(width, 0), Margin = new Padding(0, 0, 0, 2) });
            if (!string.IsNullOrEmpty(item.Body))
            {
                entry.Controls.Add(new Label { Text = item.Body, ForeColor = Theme.Muted, AutoSize = true, Tag = "wrap", MaximumSize = new Size(width, 0), Margin = new Padding(0, 0, 0, 2) });
            }
            if (item.Link != null)
            {
                var more = new LinkLabel { Text = "Read more", AutoSize = true, Margin = new Padding(0, 2, 0, 0) };
                StyleLink(more);
                var link = item.Link;
                more.LinkClicked += (s, e) => TrayApp.Open(link);
                entry.Controls.Add(more);
            }
            return entry;
        }

        private void ShowConference(NewsItem item)
        {
            var body = _conference.Body;
            body.SuspendLayout();
            foreach (var old in body.Controls.Cast<Control>().ToList()) old.Dispose();
            body.Controls.Clear();
            var width = Math.Max(160, _conference.InnerWidth);
            var head = new FlowLayoutPanel { AutoSize = true, WrapContents = false, BackColor = Theme.Card, Margin = new Padding(0, 0, 0, 10) };
            var icon = Picture.Icon(Glyph.Calendar, 20, Theme.AccentText);
            icon.Margin = new Padding(0, 0, 8, 0);
            head.Controls.Add(icon);
            head.Controls.Add(new Label { Text = "CONFERENCE", Font = Theme.SmallCaps, ForeColor = Theme.AccentText, AutoSize = true, Margin = new Padding(0, 3, 0, 0) });
            body.Controls.Add(head);
            body.Controls.Add(new Label { Text = item.Title, Font = Theme.CardTitle, ForeColor = Theme.Text, AutoSize = true, Tag = "wrap", MaximumSize = new Size(width, 0), Margin = new Padding(0, 0, 0, 8) });
            body.Controls.Add(new Label { Text = item.Body, ForeColor = Theme.Muted, AutoSize = true, Tag = "wrap", MaximumSize = new Size(width, 0), Margin = new Padding(0, 0, 0, 12) });
            var chips = new FlowLayoutPanel { FlowDirection = FlowDirection.TopDown, AutoSize = true, WrapContents = false, BackColor = Theme.Card, Margin = new Padding(0) };
            chips.Controls.Add(Chip("Ōtepoti Dunedin"));
            chips.Controls.Add(Chip("Date to be confirmed"));
            body.Controls.Add(chips);
            if (item.Link != null)
            {
                var more = new LinkLabel { Text = "Find out more", AutoSize = true, Margin = new Padding(0, 10, 0, 0) };
                StyleLink(more);
                var link = item.Link;
                more.LinkClicked += (s, e) => TrayApp.Open(link);
                body.Controls.Add(more);
            }
            body.ResumeLayout();
            _conference.Refit();
        }

        private static Control Chip(string text)
        {
            var size = TextRenderer.MeasureText(text, Theme.Small);
            return new Picture(new Size(size.Width + Theme.S(20), size.Height + Theme.S(10)), (g, r) =>
            {
                using (var path = Theme.Rounded(new RectangleF(0, 0, r.Width - 1, r.Height - 1), (r.Height - 1) / 2f))
                using (var fill = new SolidBrush(Theme.NavSelected))
                {
                    g.FillPath(fill, path);
                }
                TextRenderer.DrawText(g, text, Theme.Small, r, Theme.Text, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine);
            })
            { Margin = new Padding(0, 0, 6, 6) };
        }

        /// <summary>A quick-look card: a label, a big value, a line under it; click to go to its page.</summary>
        private sealed class Tile
        {
            public readonly Card Card = new Card();
            private readonly Dot _dot = new Dot { Margin = new Padding(0, Theme.S(11), Theme.S(8), 0) };
            private readonly Label _value = new Label { Text = "…", Font = Theme.Big, ForeColor = Theme.Text, AutoSize = true, Margin = new Padding(0) };
            private readonly Label _detail = new Label { Text = " ", ForeColor = Theme.Muted, AutoSize = true, AutoEllipsis = true, Margin = new Padding(0, 2, 0, 0) };

            public Tile(string title, Glyph glyph, Action open)
            {
                var head = new FlowLayoutPanel { AutoSize = true, WrapContents = false, BackColor = Theme.Card, Margin = new Padding(0, 0, 0, 8) };
                var icon = Picture.Icon(glyph, 18, Theme.Muted);
                icon.Margin = new Padding(0, 0, 8, 0);
                head.Controls.Add(icon);
                head.Controls.Add(new Label { Text = title.ToUpperInvariant(), Font = Theme.SmallCaps, ForeColor = Theme.Muted, AutoSize = true, Margin = new Padding(0, 2, 0, 0) });
                Card.Body.Controls.Add(head);
                var row = new FlowLayoutPanel { AutoSize = true, WrapContents = false, BackColor = Theme.Card, Margin = new Padding(0) };
                row.Controls.Add(_dot);
                row.Controls.Add(_value);
                Card.Body.Controls.Add(row);
                Card.Body.Controls.Add(_detail);
                Card.Cursor = Cursors.Hand;
                Clickable(Card, open);
                Card.Body.SizeChanged += (s, e) => _detail.MaximumSize = new Size(Card.InnerWidth, 0);
            }

            private static void Clickable(Control control, Action open)
            {
                control.Click += (s, e) => open();
                control.Cursor = Cursors.Hand;
                foreach (Control child in control.Controls) Clickable(child, open);
            }

            public void Show(string value, string detail, Color colour)
            {
                _value.Text = value;
                _detail.Text = detail;
                _dot.Colour = colour;
            }
        }
    }
}

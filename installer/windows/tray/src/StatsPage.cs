using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Globalization;
using System.Linq;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace Tohyee.Tray
{
    /// <summary>
    /// Stats (decision 332), like a media server's dashboard: how busy this
    /// computer and Tohyee are now, graphs of the last 24 hours, disk space,
    /// each organisation's database size, and what this server runs on. The
    /// server samples once a minute and keeps the last 24 hours in memory, so
    /// the graphs start again when Tohyee restarts.
    /// </summary>
    internal sealed class StatsPage : UserControl
    {
        private readonly TohyeeApi _api;
        private readonly Tile _cpu = new Tile("CPU");
        private readonly Tile _memory = new Tile("Memory");
        private readonly Tile _people = new Tile("People");
        private readonly Tile _requests = new Tile("Requests");
        private readonly Graph _cpuGraph = new Graph("CPU use (%)", true);
        private readonly Graph _memoryGraph = new Graph("Memory used", false);
        private readonly Graph _requestsGraph = new Graph("Requests a minute", false);
        private readonly Graph _peopleGraph = new Graph("People using Tohyee", false);
        private readonly FlowLayoutPanel _ranges = Ui.Row();
        private readonly ListView _disks = Ui.List("Disk", "Free", "Size", "Used");
        private readonly ListView _databases = Ui.List("Database", "Size");
        private readonly Label _databasesNote = new Label { AutoSize = true, ForeColor = Ui.Muted, Tag = "wrap", Margin = new Padding(0, 0, 0, 4) };
        private readonly Label _server = new Label { AutoSize = true, ForeColor = Theme.Text, Tag = "wrap", Margin = new Padding(0, 0, 0, 4) };
        private readonly Label _status = Ui.Status();
        private readonly Timer _timer = new Timer { Interval = 15000 };
        private Dictionary<string, object> _stats;
        private TimeSpan _range = TimeSpan.FromHours(24);
        private bool _loading;

        public StatsPage(TohyeeApi api)
        {
            _api = api;
            BackColor = Theme.Bg;
            var page = Ui.Page("Stats", "How busy this computer and Tohyee are. It refreshes every 15 seconds; the graphs go back up to 24 hours and start again when Tohyee restarts.");
            page.Controls.Add(new SplitRow(new[] { _cpu.Card, _memory.Card, _people.Card, _requests.Card }, new[] { 1f, 1f, 1f, 1f }));

            var graphs = Ui.Card(page, "History", null);
            foreach (var range in new[] { Tuple.Create("1 hour", 1), Tuple.Create("6 hours", 6), Tuple.Create("24 hours", 24) })
            {
                var hours = range.Item2;
                _ranges.Controls.Add(Ui.Btn(range.Item1, (s, e) =>
                {
                    _range = TimeSpan.FromHours(hours);
                    ShowGraphs();
                }));
            }
            graphs.Body.Controls.Add(_ranges);
            foreach (var graph in new[] { _cpuGraph, _memoryGraph, _requestsGraph, _peopleGraph }) graphs.Body.Controls.Add(graph);
            graphs.Body.Controls.Add(_status);

            var disks = Ui.Card(page, "Disk space", null);
            _disks.Height = Theme.S(110);
            disks.Body.Controls.Add(_disks);

            var databases = Ui.Card(page, "Databases", null);
            databases.Body.Controls.Add(_databasesNote);
            databases.Body.Controls.Add(_databases);

            var server = Ui.Card(page, "This server", null);
            server.Body.Controls.Add(_server);

            Controls.Add(page);
            _timer.Tick += async (s, e) => await Reload();
            Load += async (s, e) =>
            {
                _timer.Start();
                await Reload();
            };
            VisibleChanged += async (s, e) =>
            {
                if (Visible && IsHandleCreated) await Reload();
            };
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing) _timer.Dispose();
            base.Dispose(disposing);
        }

        private async Task Reload()
        {
            if (_loading || !Visible) return;
            _loading = true;
            try
            {
                _stats = await _api.Get("/api/admin/stats");
                _status.Text = "";
                ShowStats();
            }
            catch (ApiException error)
            {
                Ui.Show(_status, error.Message, true);
            }
            finally
            {
                _loading = false;
            }
        }

        private void ShowStats()
        {
            var s = _stats;
            var current = J.Obj(s, "current");
            var people = J.Obj(s, "people");
            var computer = J.Obj(s, "computer");
            if (current == null)
            {
                _cpu.Show("…", "The first reading comes a minute after Tohyee starts.");
                _memory.Show("…", "");
                _requests.Show("…", "");
            }
            else
            {
                _cpu.Show(Percent(current, "cpuPercent"), "Tohyee " + Percent(current, "tohyeeCpuPercent") + " · " + J.Int(computer, "cores") + " cores");
                var used = J.Num(current, "memoryUsedBytes");
                var total = J.Num(current, "memoryTotalBytes");
                _memory.Show(Bytes(used), "of " + Bytes(total) + " · Tohyee " + Bytes(J.Num(current, "tohyeeMemoryBytes")));
                var average = J.Str(current, "averageMs");
                _requests.Show(J.Int(current, "requests") + " last minute",
                    (average != null ? "Average " + average + " ms" : "None") + " · " + J.Int(current, "serverErrors") + " server errors");
            }
            _people.Show(J.Int(people, "activeNow") + " using it now",
                J.Int(people, "activeLast24Hours") + " in the last 24 hours · " + J.Int(people, "signedIn") + " signed in · " + J.Int(people, "users") + " users");
            ShowGraphs();

            _disks.BeginUpdate();
            _disks.Items.Clear();
            foreach (var disk in J.List(s, "disks"))
            {
                var free = J.Num(disk, "freeBytes");
                var size = J.Num(disk, "totalBytes");
                var item = new ListViewItem(J.Str(disk, "label") + " (" + J.Str(disk, "path") + ")");
                item.SubItems.Add(Bytes(free));
                item.SubItems.Add(Bytes(size));
                item.SubItems.Add(size > 0 ? Math.Round((size - free) * 100 / size) + "%" : "");
                if (size > 0 && free / size < 0.1) item.ForeColor = Ui.Danger;
                _disks.Items.Add(item);
            }
            Ui.FitColumns(_disks);
            _disks.EndUpdate();

            var databases = J.Obj(s, "databases");
            _databases.BeginUpdate();
            _databases.Items.Clear();
            if (databases != null)
            {
                foreach (var database in J.List(databases, "list").OrderByDescending(d => J.Num(d, "sizeBytes")))
                {
                    var item = new ListViewItem(J.Str(database, "name"));
                    item.SubItems.Add(Bytes(J.Num(database, "sizeBytes")));
                    _databases.Items.Add(item);
                }
                _databasesNote.Text = "All together " + Bytes(J.Num(databases, "totalBytes")) + ", measured every 15 minutes (last " + J.When(J.Str(databases, "at")) + "). Backups are compressed, so they're smaller.";
            }
            else
            {
                _databasesNote.Text = "Not measured yet.";
            }
            Ui.FitColumns(_databases);
            _databases.EndUpdate();

            var organisations = J.Obj(s, "organisations");
            var lines = new List<string>
            {
                "Tohyee v" + J.Str(s, "version") + ", running for " + Ui.Duration(TimeSpan.FromSeconds(J.Num(s, "uptimeSeconds"))) + " (since " + J.When(J.Str(s, "startedAt")) + ")",
                J.Int(organisations, "ready") + " organisations" + (J.Int(organisations, "blocked") > 0 ? ", " + J.Int(organisations, "blocked") + " blocked (see Updates)" : ""),
                "Computer: " + J.Str(computer, "platform") + ", " + (J.Str(computer, "cpuModel") ?? "CPU") + " (" + J.Int(computer, "cores") + " cores), " + Bytes(J.Num(computer, "memoryTotalBytes")) + " memory, on for " + Ui.Duration(TimeSpan.FromSeconds(J.Num(computer, "computerUptimeSeconds"))),
                "Database: PostgreSQL " + (J.Str(s, "postgresVersion") ?? "(unknown)") + " · " + "Node.js " + J.Str(s, "nodeVersion"),
            };
            if (current != null && J.Str(current, "databaseConnections") != null) lines.Add("Database connections: " + J.Int(current, "databaseConnections"));
            _server.Text = string.Join("\n", lines);
        }

        private void ShowGraphs()
        {
            if (_stats == null) return;
            var since = DateTime.UtcNow - _range;
            var history = J.List(_stats, "history")
                .Select(sample => new { Sample = sample, At = Parse(J.Str(sample, "at")) })
                .Where(x => x.At.HasValue && x.At.Value >= since)
                .ToList();
            var times = history.Select(x => x.At.Value.ToLocalTime()).ToArray();
            Func<string, double?[]> series = key => history.Select(x => Value(x.Sample, key)).ToArray();
            _cpuGraph.SetData(times, new[] { series("cpuPercent"), series("tohyeeCpuPercent") }, new[] { "This computer", "Tohyee" }, v => v.ToString("0", CultureInfo.InvariantCulture) + "%");
            _memoryGraph.SetData(times, new[] { series("memoryUsedBytes"), series("tohyeeMemoryBytes") }, new[] { "This computer", "Tohyee" }, Bytes);
            _requestsGraph.SetData(times, new[] { series("requests"), series("serverErrors") }, new[] { "Requests", "Server errors" }, v => v.ToString("0", CultureInfo.InvariantCulture));
            _peopleGraph.SetData(times, new[] { series("activeUsers") }, new[] { "Active in the last 5 minutes" }, v => v.ToString("0", CultureInfo.InvariantCulture));
        }

        private static DateTime? Parse(string iso)
        {
            DateTime parsed;
            if (iso != null && DateTime.TryParse(iso, CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal, out parsed)) return parsed;
            return null;
        }

        private static double? Value(Dictionary<string, object> sample, string key)
        {
            object value;
            if (sample == null || !sample.TryGetValue(key, out value) || value == null) return null;
            return J.Num(sample, key);
        }

        private static string Percent(Dictionary<string, object> sample, string key)
        {
            var value = Value(sample, key);
            return value.HasValue ? value.Value.ToString("0.#", CultureInfo.InvariantCulture) + "%" : "…";
        }

        internal static string Bytes(double bytes)
        {
            string[] units = { "bytes", "KB", "MB", "GB", "TB" };
            var unit = 0;
            while (bytes >= 1024 && unit < units.Length - 1)
            {
                bytes /= 1024;
                unit++;
            }
            return (unit == 0 ? bytes.ToString("0", CultureInfo.InvariantCulture) : bytes.ToString(bytes >= 100 ? "0" : "0.#", CultureInfo.InvariantCulture)) + " " + units[unit];
        }

        /// <summary>A small card with a heading, a big figure and a line under it.</summary>
        private sealed class Tile
        {
            public readonly Card Card = new Card();
            private readonly Label _value = new Label { Text = "…", Font = Theme.Big, ForeColor = Theme.Text, AutoSize = true, Margin = new Padding(0) };
            private readonly Label _detail = new Label { Text = " ", ForeColor = Theme.Muted, AutoSize = true, Tag = "wrap", Margin = new Padding(0, 2, 0, 0) };

            public Tile(string title)
            {
                Card.Body.Controls.Add(new Label { Text = title.ToUpperInvariant(), Font = Theme.SmallCaps, ForeColor = Theme.Muted, AutoSize = true, Margin = new Padding(0, 0, 0, 8) });
                Card.Body.Controls.Add(_value);
                Card.Body.Controls.Add(_detail);
            }

            public void Show(string value, string detail)
            {
                _value.Text = value;
                _detail.Text = detail;
            }
        }
    }

    /// <summary>A line graph of one or two series over time, drawn to fit its width.</summary>
    internal sealed class Graph : Control
    {
        private static readonly Color[] Colours = { Theme.AccentText, Theme.Warning };
        private readonly string _title;
        private readonly bool _percent;
        private DateTime[] _times = new DateTime[0];
        private double?[][] _series = new double?[0][];
        private string[] _names = new string[0];
        private Func<double, string> _format = v => v.ToString(CultureInfo.InvariantCulture);

        public Graph(string title, bool percent)
        {
            _title = title;
            _percent = percent;
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw | ControlStyles.UserPaint, true);
            BackColor = Theme.Card;
            Height = Theme.S(150);
            Margin = new Padding(0, 8, 0, 8);
            Tag = "stretch";
        }

        public void SetData(DateTime[] times, double?[][] series, string[] names, Func<double, string> format)
        {
            _times = times;
            _series = series;
            _names = names;
            _format = format;
            Invalidate();
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            var g = e.Graphics;
            g.Clear(BackColor);
            g.SmoothingMode = SmoothingMode.AntiAlias;
            var titleHeight = TextRenderer.MeasureText(_title, Theme.SmallCaps).Height + Theme.S(4);
            TextRenderer.DrawText(g, _title.ToUpperInvariant(), Theme.SmallCaps, new Point(0, 0), Theme.Muted);
            // The legend, after the title.
            var x = TextRenderer.MeasureText(_title.ToUpperInvariant(), Theme.SmallCaps).Width + Theme.S(16);
            for (var i = 0; i < _names.Length && i < Colours.Length; i++)
            {
                using (var brush = new SolidBrush(Colours[i])) g.FillRectangle(brush, x, Theme.S(5), Theme.S(10), Theme.S(3));
                x += Theme.S(14);
                TextRenderer.DrawText(g, _names[i], Theme.Small, new Point(x, 0), Theme.Muted);
                x += TextRenderer.MeasureText(_names[i], Theme.Small).Width + Theme.S(12);
            }

            var labelWidth = Theme.S(64);
            var plot = new Rectangle(labelWidth, titleHeight + Theme.S(4), Math.Max(10, Width - labelWidth - Theme.S(4)), Math.Max(10, Height - titleHeight - Theme.S(26)));
            var values = _series.SelectMany(s => s).Where(v => v.HasValue).Select(v => v.Value).ToList();
            var max = _percent ? 100 : Math.Max(1, values.Count > 0 ? values.Max() * 1.15 : 1);
            using (var grid = new Pen(Theme.CardBorder))
            {
                for (var line = 0; line <= 2; line++)
                {
                    var y = plot.Bottom - plot.Height * line / 2f;
                    g.DrawLine(grid, plot.Left, y, plot.Right, y);
                    var text = _format(max * line / 2);
                    var size = TextRenderer.MeasureText(text, Theme.Small);
                    TextRenderer.DrawText(g, text, Theme.Small, new Point(labelWidth - size.Width - Theme.S(6), (int)(y - size.Height / 2f)), Theme.Muted);
                }
            }
            if (_times.Length < 2)
            {
                TextRenderer.DrawText(g, "Not enough readings yet (one a minute).", Theme.Small, plot, Theme.Muted, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter);
                return;
            }
            var first = _times[0];
            var span = Math.Max(1, (_times[_times.Length - 1] - first).TotalSeconds);
            Func<int, float> px = i => plot.Left + (float)((_times[i] - first).TotalSeconds / span) * plot.Width;
            Func<double, float> py = v => plot.Bottom - (float)(Math.Min(v, max) / max) * plot.Height;
            for (var s = _series.Length - 1; s >= 0; s--)
            {
                var data = _series[s];
                using (var pen = new Pen(Colours[Math.Min(s, Colours.Length - 1)], Theme.S(2)) { LineJoin = LineJoin.Round })
                {
                    var run = new List<PointF>();
                    for (var i = 0; i < data.Length; i++)
                    {
                        // A gap (a missing reading) breaks the line.
                        if (data[i].HasValue) run.Add(new PointF(px(i), py(data[i].Value)));
                        if ((!data[i].HasValue || i == data.Length - 1) && run.Count > 0)
                        {
                            if (run.Count > 1) g.DrawLines(pen, run.ToArray());
                            run.Clear();
                        }
                    }
                }
            }
            // Times along the bottom: the start, the middle and the end.
            foreach (var i in new[] { 0, _times.Length / 2, _times.Length - 1 })
            {
                var text = _times[i].ToString("h:mm tt", CultureInfo.GetCultureInfo("en-NZ"));
                var size = TextRenderer.MeasureText(text, Theme.Small);
                var left = Math.Max(plot.Left, Math.Min(plot.Right - size.Width, (int)px(i) - size.Width / 2));
                TextRenderer.DrawText(g, text, Theme.Small, new Point(left, plot.Bottom + Theme.S(4)), Theme.Muted);
            }
        }
    }
}

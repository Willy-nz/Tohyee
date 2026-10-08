using System;
using System.Collections.Generic;
using System.Drawing;
using System.Linq;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace Tohyee.Tray
{
    /// <summary>
    /// Updates (decisions 328 to 331). Tohyee checks GitHub by itself each day;
    /// this page shows what it found and installs a new version in one go:
    /// back up every organisation, download TohyeeSetup and check it against
    /// GitHub's SHA-256, then run it silently. Tohyee restarts, upgrades each
    /// organisation's database as it starts, and this app comes back to say how
    /// it went. Your data and passwords are kept.
    /// </summary>
    internal sealed class UpdatesPage : UserControl
    {
        private readonly AppServices _app;
        private readonly Label _result = new Label { AutoSize = true, Font = Theme.Strong, ForeColor = Theme.Text, Tag = "wrap", Margin = new Padding(0, 4, 0, 4) };
        private readonly Label _detail = new Label { AutoSize = true, ForeColor = Ui.Muted, Tag = "wrap", Margin = new Padding(0, 0, 0, 8) };
        private readonly FlowLayoutPanel _buttons = Ui.Row();
        private readonly Label _status = Ui.Status();
        private readonly Card _lastCard;
        private readonly Label _last = new Label { AutoSize = true, ForeColor = Theme.Text, Tag = "wrap", Margin = new Padding(0, 0, 0, 4) };
        private readonly Label _blocked = new Label { AutoSize = true, ForeColor = Ui.Danger, Tag = "wrap", Margin = new Padding(0, 4, 0, 4) };
        private Dictionary<string, object> _details;
        private bool _installing;

        public UpdatesPage(AppServices app)
        {
            _app = app;
            BackColor = Theme.Bg;
            var page = Ui.Page("Updates", "Tohyee checks GitHub for a new version a minute after it starts and then once a day. Install backs up every organisation first, checks the download, installs it and upgrades each organisation's database. Anyone using the books is disconnected for a few minutes.");
            var card = Ui.Card(page, "Latest release", null);
            card.Body.Controls.Add(_result);
            card.Body.Controls.Add(_detail);
            card.Body.Controls.Add(_buttons);
            card.Body.Controls.Add(_status);
            _lastCard = Ui.Card(page, "Last update", null);
            _lastCard.Body.Controls.Add(_last);
            _lastCard.Body.Controls.Add(_blocked);
            _lastCard.Visible = false;
            foreach (var label in new[] { _result, _detail, _last, _blocked })
            {
                var line = label;
                line.Visible = false;
                line.TextChanged += (s, e) => line.Visible = line.Text.Length > 0;
            }
            Controls.Add(page);
            Load += async (s, e) => await Reload(false);
            VisibleChanged += async (s, e) =>
            {
                if (Visible && IsHandleCreated && !_installing) await Reload(false);
            };
        }

        /// <summary>The newest refresh asked for; an older answer never replaces a newer one (#198).</summary>
        private int _refreshGeneration;
        private bool _refreshing;

        private async Task Reload(bool checkNow)
        {
            // Opening the page (Load, then becoming visible) or flicking away and back while a
            // refresh is on its way doesn't start another; "Check now" always does.
            if (_refreshing && !checkNow) return;
            var generation = ++_refreshGeneration;
            _refreshing = true;
            try
            {
                await Ui.Busy(this, _status, async () =>
                {
                    var details = checkNow ? await _app.Api.Post("/api/admin/updates/check", null) : await _app.Api.Get("/api/admin/updates");
                    if (generation != _refreshGeneration || IsDisposed) return;
                    _details = details;
                    ShowDetails();
                });
            }
            finally
            {
                if (generation == _refreshGeneration) _refreshing = false;
            }
        }

        private void ShowDetails()
        {
            var d = _details;
            var current = J.Str(d, "currentVersion");
            var latest = J.Str(d, "latestVersion");
            var available = J.Bool(d, "updateAvailable");
            if (latest != null)
            {
                _result.Text = "This server runs v" + current + ". The latest release is v" + latest + (available ? ": an update is available." : ": you're up to date.");
                _result.ForeColor = available ? Theme.Warning : Ui.Success;
            }
            else
            {
                _result.Text = "This server runs v" + current + ". " + (J.Str(d, "checkedAt") != null ? "GitHub hasn't answered yet." : "It hasn't checked GitHub yet.");
                _result.ForeColor = Theme.Text;
            }
            var lines = new List<string>();
            if (J.Str(d, "releaseName") != null) lines.Add(J.Str(d, "releaseName") + (J.Str(d, "publishedAt") != null ? ", published " + J.When(J.Str(d, "publishedAt")) : ""));
            if (J.Str(d, "checkError") != null) lines.Add("The last check failed: " + J.Str(d, "checkError"));
            var when = new List<string>();
            if (J.Str(d, "checkedAt") != null) when.Add("Last checked " + J.When(J.Str(d, "checkedAt")));
            when.Add(J.Str(d, "nextCheckAt") != null ? "next check " + J.When(J.Str(d, "nextCheckAt")) : "automatic checks are off");
            var whenText = string.Join(" · ", when);
            lines.Add(char.ToUpperInvariant(whenText[0]) + whenText.Substring(1));
            _detail.Text = string.Join("\n", lines);

            _buttons.Controls.Clear();
            if (available) _buttons.Controls.Add(Ui.Primary("Install v" + latest, async (s, e) => await Install(current, latest)));
            _buttons.Controls.Add(Ui.Btn("Check now", async (s, e) => await Reload(true)));
            var notes = J.Str(d, "releaseNotesUrl");
            if (notes != null) _buttons.Controls.Add(Ui.Btn("Release notes", (s, e) => TrayApp.Open(notes)));

            var last = J.Obj(d, "lastUpdate");
            var blocked = J.List(d, "blockedOrganisations");
            _lastCard.Visible = last != null || blocked.Count > 0;
            if (last != null)
            {
                var checkedCount = J.Int(last, "organisationsChecked");
                var blockedThen = J.List(last, "organisationsBlocked").Count;
                _last.Text = "v" + J.Str(last, "previousVersion") + " → v" + J.Str(last, "version") + " on " + J.When(J.Str(last, "startedAt")) + ": "
                    + (blockedThen == 0
                        ? "all " + checkedCount + (checkedCount == 1 ? " organisation" : " organisations") + " came up."
                        : blockedThen + " of " + checkedCount + " organisations couldn't be upgraded.");
            }
            else
            {
                _last.Text = "";
            }
            _blocked.Text = blocked.Count == 0 ? ""
                : "Blocked (nobody can use these until an upgrade works; nothing was half-done, and the backup made before the update can be restored from Backups):\n"
                  + string.Join("\n", blocked.Select(o => "• " + J.Str(o, "displayName") + " (" + J.Str(o, "organisationId") + "): " + (J.Str(o, "error") ?? "no message")));
        }

        private void Say(string text)
        {
            _status.ForeColor = Theme.Text;
            _status.Text = text;
        }

        private async Task Install(string current, string version)
        {
            if (_app.Api.IsDemo) return;
            if (!Ui.Confirm(FindForm(),
                "Install Tohyee v" + version + "?\n\n"
                + "1. Every organisation is backed up (this can take a few minutes).\n"
                + "2. The installer is downloaded from GitHub and checked.\n"
                + "3. Tohyee stops, is updated, and starts again; anyone using the books is disconnected for a few minutes.\n\n"
                + "Windows will ask for permission. This app closes while it installs and comes back to tell you how it went.")) return;
            _installing = true;
            try
            {
                Dictionary<string, object> prepared = null;
                Say("Backing up every organisation…");
                var ok = await Ui.Busy(this, _status, async () =>
                {
                    prepared = await _app.Api.PostLong("/api/admin/updates/prepare", new Dictionary<string, object> { { "version", version } });
                });
                if (!ok || prepared == null) return;
                var setup = J.Obj(prepared, "setup");
                var backups = J.List(prepared, "backups").Count;
                string file = null;
                Say("Backed up " + backups + (backups == 1 ? " database" : " databases") + ". Downloading " + J.Str(setup, "name") + "…");
                ok = await Ui.Busy(this, _status, async () =>
                {
                    file = await UpdateInstaller.Download(
                        J.Str(setup, "downloadUrl"),
                        J.Str(setup, "name"),
                        J.Str(setup, "sha256"),
                        (long)J.Num(setup, "size"),
                        percent => BeginInvoke((Action)(() => Say("Backed up " + backups + (backups == 1 ? " database" : " databases") + ". Downloading " + J.Str(setup, "name") + ": " + percent + "%"))));
                });
                if (!ok || file == null) return;
                Say("Downloaded and checked. Starting the installer…");
                if (!UpdateInstaller.Run(file, current, J.Str(prepared, "version"), _app.Settings.LogsDir))
                {
                    Ui.Show(_status, "Windows didn't get permission, so nothing was installed. Press Install to try again.", true);
                    return;
                }
                Say("Installing v" + J.Str(prepared, "version") + ". Tohyee will stop and start again; this app comes back when it's done.");
            }
            finally
            {
                _installing = false;
            }
        }
    }
}

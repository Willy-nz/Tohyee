using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace Tohyee.Tray
{
    /// <summary>
    /// Backups: every night Tohyee backs up each organisation (and its own
    /// database of users and settings) into encrypted files in the backup
    /// folder. A OneDrive folder gets copies off this computer. Restoring makes
    /// a copy of the organisation, so the current books are never overwritten.
    /// </summary>
    internal sealed class BackupsPage : UserControl
    {
        private readonly TohyeeApi _api;
        private readonly Label _summary = new Label { AutoSize = true, ForeColor = Theme.Text, Tag = "wrap", MaximumSize = new Size(Theme.S(640), 0), Margin = new Padding(0, 0, 0, 8) };
        private readonly Label _attention = new Label { AutoSize = true, ForeColor = Ui.Danger, Tag = "wrap", MaximumSize = new Size(Theme.S(640), 0), Margin = new Padding(0, 0, 0, 8) };
        private readonly Label _state = Ui.State();
        private readonly CheckBox _enabled = new DarkCheckBox { Text = "Back up every night", AutoSize = true };
        private readonly TextBox _time = new TextBox { Width = Theme.S(80) };
        private readonly TextBox _folder = new TextBox { Width = Theme.S(330) };
        private readonly Label _folderNote = new Label { AutoSize = true, ForeColor = Ui.Muted, MaximumSize = new Size(Theme.S(600), 0), Margin = new Padding(0, 2, 0, 6) };
        private readonly ListView _status = Ui.List("Organisation", "Last good backup", "Size", "Latest attempt");
        private readonly ListView _files = Ui.List("Made", "Organisation", "Size", "File");
        private readonly Label _message = Ui.Status();
        private readonly Label _kitState = Ui.State();
        private string _defaultFolder;

        public BackupsPage(TohyeeApi api)
        {
            _api = api;
            _status.Height = Theme.S(150);
            _files.Height = Theme.S(200);
            BackColor = Theme.Bg;
            var page = Ui.Page("Backups", "Every night Tohyee backs up each organisation into its own file, encrypted with this server's recovery key, keeps 14 daily and 12 monthly backups, checks each file after it's made, and reads the newest ones back to check them again every week. Choose a OneDrive or Google Drive folder to get copies off this computer.");

            // What's known, and on what evidence (decision 733). No "safe" badge: what isn't proven is said.
            var status = Ui.Card(page, "Status", "What Tohyee has done and checked, and what it can't see.");
            status.Body.Controls.Add(_summary);
            status.Body.Controls.Add(_attention);
            var statusButtons = Ui.Row();
            statusButtons.Controls.Add(Ui.Btn("Check backups now", async (s, e) => await CheckNow()));
            statusButtons.Controls.Add(Ui.Btn("Open in the browser", (s, e) => TrayApp.Open(_api.BaseUrl + "/server/backups")));
            status.Body.Controls.Add(statusButtons);

            var nightly = Ui.Card(page, "Nightly backups", null);
            nightly.Body.Controls.Add(_state);
            var form = Ui.Form();
            Ui.Field(form, "Nightly", _enabled);
            Ui.Field(form, "At (24-hour)", _time);
            _time.Dock = DockStyle.None;
            // Wraps the buttons under the folder in a narrow window rather than running off the card.
            var folderRow = new FlowLayoutPanel { AutoSize = true, WrapContents = true, Margin = new Padding(0), BackColor = Theme.Card, Tag = "wrap" };
            folderRow.Controls.Add(Ui.Input(_folder));
            _folder.Margin = new Padding(0, 4, 8, 0);
            folderRow.Controls.Add(Ui.Btn("Browse…", (s, e) => Browse()));
            folderRow.Controls.Add(Ui.Btn("Use OneDrive", (s, e) => UseOneDrive()));
            folderRow.Controls.Add(Ui.Btn("Use Google Drive", (s, e) => UseGoogleDrive()));
            form.RowCount += 1;
            form.Controls.Add(new Label { Text = "Folder", AutoSize = true, ForeColor = Theme.Muted, Anchor = AnchorStyles.Left, Margin = new Padding(0, 7, 12, 7) });
            form.Controls.Add(folderRow);
            form.RowCount += 1;
            form.Controls.Add(new Label());
            form.Controls.Add(_folderNote);
            nightly.Body.Controls.Add(form);
            var settingsButtons = Ui.Row();
            settingsButtons.Controls.Add(Ui.Primary("Save", async (s, e) => await Save()));
            settingsButtons.Controls.Add(Ui.Btn("Back up now", async (s, e) => await BackUpNow()));
            settingsButtons.Controls.Add(Ui.Btn("Open the folder", (s, e) => TrayApp.OpenFolder(_folder.Text.Trim())));
            nightly.Body.Controls.Add(settingsButtons);
            nightly.Body.Controls.Add(_message);

            // The recovery kit (#389, decisions 735-736): made, downloaded and checked in the browser, where saving and choosing a file is natural.
            var kit = Ui.Card(page, "Recovery kit", "The one thing you need, with the backup files, to get the books back on another computer. It holds this server's recovery key and nothing else. Save it in a password manager (or print it), not in the backup folder, then check your saved copy.");
            kit.Body.Controls.Add(_kitState);
            var kitButtons = Ui.Row();
            kitButtons.Controls.Add(Ui.Btn("Save recovery kit…", (s, e) => TrayApp.Open(_api.BaseUrl + "/server/backups#recovery-kit")));
            kitButtons.Controls.Add(Ui.Btn("Check recovery kit…", (s, e) => TrayApp.Open(_api.BaseUrl + "/server/backups#recovery-kit")));
            kit.Body.Controls.Add(kitButtons);

            var latest = Ui.Card(page, "Each organisation", null);
            latest.Body.Controls.Add(_status);

            var files = Ui.Card(page, "Backup files", "Restoring one makes a new organisation, e.g. \"Green Island (restored from 2026-09-27)\", with the same people, so you can check it before using it.");
            files.Body.Controls.Add(_files);
            var fileButtons = Ui.Row();
            fileButtons.Controls.Add(Ui.Btn("Restore as a copy…", async (s, e) => await Restore()));
            fileButtons.Controls.Add(Ui.Btn("Restore on this computer…", (s, e) => TrayApp.Open(_api.BaseUrl + "/server/backups/restore")));
            fileButtons.Controls.Add(Ui.Btn("Refresh", async (s, e) => await Reload()));
            files.Body.Controls.Add(fileButtons);
            Controls.Add(page);
            Load += async (s, e) => await Reload();
        }

        private static string SizeText(double bytes)
        {
            if (bytes <= 0) return "";
            return bytes >= 1024 * 1024 ? (bytes / 1024 / 1024).ToString("0.0") + " MB" : Math.Ceiling(bytes / 1024) + " KB";
        }

        private void Show(Dictionary<string, object> result)
        {
            var settings = J.Obj(result, "settings");
            _defaultFolder = J.Str(settings, "defaultFolder");
            _enabled.Checked = J.Bool(settings, "enabled");
            _time.Text = J.Str(settings, "time") ?? "02:00";
            _folder.Text = J.Str(settings, "folder") ?? "";
            _folderNote.Text = "Tohyee's service writes here, so it must be a folder on this computer. Blank means the default: " + _defaultFolder;

            var anyFailed = false;
            var anyNever = false;
            _status.BeginUpdate();
            _status.Items.Clear();
            foreach (var entry in J.List(result, "status"))
            {
                var good = J.Obj(entry, "lastGood");
                var latest = J.Obj(entry, "latest");
                var latestText = latest == null ? "" : J.Str(latest, "status") == "failed" ? "Failed: " + J.Str(latest, "error") : J.Str(latest, "status") == "running" ? "Running…" : "OK";
                var item = new ListViewItem(new[]
                {
                    J.Str(entry, "displayName") ?? "Server (users and settings)",
                    good == null ? "Never" : J.When(J.Str(good, "finishedAt")),
                    good == null ? "" : SizeText(J.Num(good, "sizeBytes")),
                    latestText,
                });
                if (latestText.StartsWith("Failed")) { item.ForeColor = Ui.Danger; anyFailed = true; }
                if (good == null) anyNever = true;
                _status.Items.Add(item);
            }
            Ui.FitColumns(_status);
            _status.EndUpdate();

            _files.BeginUpdate();
            _files.Items.Clear();
            foreach (var file in J.List(result, "files"))
            {
                var header = J.Obj(file, "header");
                var item = new ListViewItem(new[]
                {
                    header == null ? "" : J.When(J.Str(header, "createdAt")),
                    header == null ? J.Str(file, "problem") : J.Str(header, "displayName") ?? "Server (users and settings)",
                    SizeText(J.Num(file, "sizeBytes")),
                    J.Str(file, "name"),
                })
                { Tag = file };
                _files.Items.Add(item);
            }
            Ui.FitColumns(_files);
            _files.EndUpdate();

            ShowOverview(J.Obj(result, "overview"));

            var recoveryKit = J.Obj(result, "recoveryKit");
            if (!J.Bool(recoveryKit, "keySet"))
            {
                _kitState.Text = "There's no TOHYEE_SECRET_KEY on this server, so there's no recovery key.";
                _kitState.ForeColor = Ui.Danger;
            }
            else if (J.Str(recoveryKit, "version") == null)
            {
                _kitState.Text = "There's no recovery key yet: the first backup makes one.";
                _kitState.ForeColor = Theme.Text;
            }
            else if (J.Str(recoveryKit, "checkedAt") == null)
            {
                _kitState.Text = "Not checked: nobody has checked a saved kit for recovery key version " + J.Str(recoveryKit, "version") + ".";
                _kitState.ForeColor = Ui.Danger;
            }
            else
            {
                _kitState.Text = "Version " + J.Str(recoveryKit, "version") + ": " + J.Str(recoveryKit, "checkedByEmail") + " checked a saved kit on " + J.When(J.Str(recoveryKit, "checkedAt")) + ". That proves it was right then, not that it's still there.";
                _kitState.ForeColor = Ui.Success;
            }
            if (!J.Bool(settings, "keySet"))
            {
                _state.Text = "This server has no TOHYEE_SECRET_KEY, so it can't make backups. Updating Tohyee with the installer sets one.";
                _state.ForeColor = Ui.Danger;
            }
            else if (!J.Bool(settings, "enabled"))
            {
                _state.Text = "Nightly backups are off.";
                _state.ForeColor = Ui.Danger;
            }
            else if (anyFailed)
            {
                _state.Text = "The last backup failed for something below. Tohyee tries again every hour.";
                _state.ForeColor = Ui.Danger;
            }
            else
            {
                _state.Text = "On: every night at " + _time.Text + (anyNever ? ". Not everything has been backed up yet; use Back up now to start." : ".");
                _state.ForeColor = anyNever ? Theme.Text : Ui.Success;
            }
        }

        private static string Ago(string iso)
        {
            DateTime parsed;
            if (string.IsNullOrEmpty(iso) || !DateTime.TryParse(iso, System.Globalization.CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.AdjustToUniversal | System.Globalization.DateTimeStyles.AssumeUniversal, out parsed)) return "";
            var hours = (DateTime.UtcNow - parsed).TotalHours;
            if (hours < 1) return "under an hour ago";
            if (hours < 48) return Math.Floor(hours) + " hours ago";
            return Math.Floor(hours / 24) + " days ago";
        }

        /// <summary>The overview from the server, plus what only this app can see: whether OneDrive is running for this person.</summary>
        private void ShowOverview(Dictionary<string, object> overview)
        {
            if (overview == null)
            {
                _summary.Text = "";
                _attention.Text = "";
                return;
            }
            var lines = new List<string>();
            var all = J.Str(overview, "everythingBackedUpAt");
            lines.Add("Latest backup: " + (all != null ? "everything, the oldest " + Ago(all) + " (" + J.When(all) + ")" : "not everything has been backed up yet"));
            var integrity = J.Obj(overview, "integrity");
            var checkedAt = J.Str(integrity, "allCheckedAt");
            lines.Add("Files checked again: " + (J.Int(integrity, "failed") > 0 ? J.Int(integrity, "failed") + " failed (see below)" : checkedAt != null ? "all, " + Ago(checkedAt) : "not all yet"));
            var test = J.Obj(overview, "testRestore");
            if (test != null)
            {
                lines.Add("Last test restore: " + (J.Int(test, "failed") > 0 ? J.Int(test, "failed") + " failed (see below)" : J.Str(test, "allAt") != null ? "every database, " + Ago(J.Str(test, "allAt")) : "not done yet (use Test a restore in the browser)"));
            }
            lines.Add("Off-site copy: " + J.Str(J.Obj(overview, "offSite"), "note"));
            var storage = J.Obj(overview, "storage");
            var free = J.Obj(overview, "storage") != null && storage.ContainsKey("freeBytes") && storage["freeBytes"] != null ? "; " + SizeText(J.Num(storage, "freeBytes")) + " free" : "";
            lines.Add("Space: " + J.Int(storage, "fileCount") + " files, " + SizeText(J.Num(storage, "usedBytes")) + free);
            _summary.Text = string.Join(Environment.NewLine, lines);

            var problems = new List<string>();
            foreach (var item in J.List(overview, "attention")) problems.Add("• " + J.Str(item, "text"));
            var destination = J.Obj(overview, "destination");
            if (J.Str(destination, "kind") == "onedrive" && !_api.IsDemo && Process.GetProcessesByName("OneDrive").Length == 0)
            {
                // The service can't see this; the app runs as the person, so it can.
                problems.Insert(0, "• OneDrive isn't running on this computer, so nothing in the backup folder is being uploaded. Start OneDrive and sign in. (Tohyee can't tell if it's paused or out of storage: check its icon by the clock.)");
            }
            _attention.Text = problems.Count == 0 ? "" : "Needs attention:" + Environment.NewLine + string.Join(Environment.NewLine, problems);
        }

        /// <summary>Reads the newest backup of each database back from the folder and checks it again.</summary>
        private async Task CheckNow()
        {
            Ui.Show(_message, "Checking the newest backup files… this can take a few minutes.", false);
            if (await Ui.Busy(this, _message, async () =>
            {
                var result = await _api.PostLong("/api/admin/backups/check", null);
                var checks = J.List(result, "checks");
                var failed = checks.FindAll(c => J.Str(c, "status") != "ok");
                Ui.Show(_message, checks.Count == 0 ? "There are no backups to check yet." : failed.Count == 0 ? "Checked the newest backup of " + checks.Count + (checks.Count == 1 ? " database" : " databases") + ": all whole and unchanged." : failed.Count + " failed: " + J.Str(failed[0], "error"), failed.Count > 0);
            }))
            {
                var keep = _message.Text;
                var keepColour = _message.ForeColor;
                await Reload();
                Ui.Show(_message, keep, keepColour == Ui.Danger);
            }
        }

        private async Task Reload()
        {
            await Ui.Busy(this, _message, async () => Show(await _api.Get("/api/admin/backups")));
        }

        private void Browse()
        {
            using (var dialog = new FolderBrowserDialog { Description = "Where should Tohyee save backups?", ShowNewFolderButton = true })
            {
                if (Directory.Exists(_folder.Text.Trim())) dialog.SelectedPath = _folder.Text.Trim();
                if (dialog.ShowDialog(FindForm()) == DialogResult.OK) _folder.Text = dialog.SelectedPath;
            }
        }

        private void UseOneDrive()
        {
            var oneDrive = Environment.GetEnvironmentVariable("OneDrive");
            if (string.IsNullOrEmpty(oneDrive) || !Directory.Exists(oneDrive))
            {
                Ui.Show(_message, "OneDrive isn't set up for you on this computer. Sign in to OneDrive, or choose a folder with Browse.", true);
                return;
            }
            _folder.Text = Path.Combine(oneDrive, "Tohyee backups");
        }

        /// <summary>
        /// Google Drive for desktop in "Mirror files" mode keeps a real "My Drive" folder in your profile,
        /// which works like OneDrive. "Stream files" mode puts it on its own drive letter that belongs to
        /// whoever is signed in, which the Tohyee service may not be able to use (decision 486).
        /// </summary>
        private void UseGoogleDrive()
        {
            var drive = FolderAccess.FindGoogleDrive();
            if (drive == null)
            {
                Ui.Show(_message, "Google Drive isn't set up for you on this computer. Install Google Drive for desktop, sign in, and choose \"Mirror files\" in its settings (Google Drive, Preferences, My Drive). Or choose a folder with Browse.", true);
                return;
            }
            _folder.Text = Path.Combine(drive.Path, "Tohyee backups");
            if (drive.Streamed)
            {
                Ui.Show(_message, "Google Drive is streaming files (" + drive.Path + "), which the Tohyee service may not be able to use. In Google Drive's settings choose \"Mirror files\" for My Drive, then press Use Google Drive again.", true);
            }
            else
            {
                Ui.Show(_message, "Google Drive mirrors files here, so backups are uploaded while you're signed in to Windows. Press Save.", false);
            }
        }

        private async Task Save()
        {
            var body = new Dictionary<string, object>
            {
                { "enabled", _enabled.Checked },
                { "time", _time.Text.Trim() },
                { "folder", _folder.Text.Trim() == _defaultFolder ? "" : _folder.Text.Trim() },
            };
            // Decision 486: the service runs as its own account, so it's given the chosen folder first.
            var chosen = (string)body["folder"];
            var problem = FolderAccess.Grant(chosen, true);
            if (await Ui.Busy(this, _message, async () =>
            {
                await _api.Put("/api/admin/backups", body);
                Ui.Show(_message, "Saved. Tohyee checked it can write to that folder.", false);
            }))
            {
                await Reload();
            }
            else if (problem != null)
            {
                Ui.Show(_message, _message.Text + " " + problem, true);
            }
        }

        /// <summary>Backs up every organisation (and the server's own database) now, encrypted, into the backup folder.</summary>
        internal async Task BackUpNow()
        {
            Ui.Show(_message, "Backing up… this can take a few minutes.", false);
            if (await Ui.Busy(this, _message, async () =>
            {
                var result = await _api.PostLong("/api/admin/backups", null);
                var runs = J.List(result, "runs");
                var failed = runs.FindAll(r => J.Str(r, "status") != "ok");
                Ui.Show(_message, failed.Count == 0 ? "Backed up " + runs.Count + (runs.Count == 1 ? " database." : " databases.") : failed.Count + " failed: " + J.Str(failed[0], "error"), failed.Count > 0);
            }))
            {
                var keep = _message.Text;
                var keepColour = _message.ForeColor;
                await Reload();
                Ui.Show(_message, keep, keepColour == Ui.Danger);
            }
        }

        private async Task Restore()
        {
            if (_files.SelectedItems.Count == 0)
            {
                Ui.Show(_message, "Choose a backup file in the list first.", true);
                return;
            }
            var file = (Dictionary<string, object>)_files.SelectedItems[0].Tag;
            var header = J.Obj(file, "header");
            if (header == null || J.Str(header, "kind") != "organisation")
            {
                Ui.Show(_message, "Only an organisation's backup can be restored here.", true);
                return;
            }
            var name = J.Str(header, "displayName");
            if (!Ui.Confirm(FindForm(), "Restore " + name + " as it was on " + J.When(J.Str(header, "createdAt")) + "?\n\nThis makes a new organisation (a copy) with the same people. " + name + " itself isn't changed.")) return;
            Ui.Show(_message, "Restoring… this can take a few minutes.", false);
            var body = new Dictionary<string, object> { { "file", J.Str(file, "name") } };
            if (await Ui.Busy(this, _message, async () =>
            {
                Dictionary<string, object> result;
                try
                {
                    result = await _api.PostLong("/api/admin/backups/restore", body);
                }
                catch (ApiException error)
                {
                    // Made on another server (or before this one was set up again): ask for that server's recovery code.
                    if (!error.Message.Contains("recovery kit")) throw;
                    var oldKey = AskKey("Restore from another server", "This backup was made by another server (or before this one was set up again). Paste that server's recovery code. For a recovery file, use Restore on this computer:", true);
                    if (string.IsNullOrEmpty(oldKey)) throw;
                    body["key"] = oldKey;
                    Ui.Show(_message, "Restoring… this can take a few minutes.", false);
                    result = await _api.PostLong("/api/admin/backups/restore", body);
                }
                var organisation = J.Obj(result, "organisation");
                Ui.Show(_message, "Restored as " + J.Str(organisation, "displayName") + " (" + J.Str(organisation, "id") + "). Its automatic jobs (emails, feeds) are paused: check it in Tohyee, then turn them on in Backups in the browser.", false);
            }))
            {
                var keep = _message.Text;
                await Reload();
                Ui.Show(_message, keep, false);
            }
        }
        /// <summary>Asks for a recovery code; null if cancelled.</summary>
        private string AskKey(string title, string prompt, bool hidden)
        {
            using (var dialog = new Form
            {
                Text = title,
                Font = Ui.Body,
                FormBorderStyle = FormBorderStyle.FixedDialog,
                StartPosition = FormStartPosition.CenterParent,
                MinimizeBox = false,
                MaximizeBox = false,
                ClientSize = new Size(Theme.S(480), Theme.S(170)),
            })
            {
                var label = new Label { Text = prompt, Left = Theme.S(16), Top = Theme.S(12), Width = Theme.S(448), Height = Theme.S(64), AutoSize = false };
                var box = new TextBox { Left = Theme.S(16), Top = Theme.S(82), Width = Theme.S(448), UseSystemPasswordChar = hidden };
                var ok = new Button { Text = "OK", DialogResult = DialogResult.OK, Left = Theme.S(298), Top = Theme.S(124), Width = Theme.S(80), Height = Theme.S(30) };
                var cancel = new Button { Text = "Cancel", DialogResult = DialogResult.Cancel, Left = Theme.S(384), Top = Theme.S(124), Width = Theme.S(80), Height = Theme.S(30) };
                dialog.Controls.AddRange(new Control[] { label, box, ok, cancel });
                dialog.AcceptButton = ok;
                dialog.CancelButton = cancel;
                Theme.Apply(dialog);
                return dialog.ShowDialog(FindForm()) == DialogResult.OK ? box.Text.Trim() : null;
            }
        }
    }
}

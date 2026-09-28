using System;
using System.Collections.Generic;
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
        private readonly Label _state = new Label { AutoSize = true, Font = new Font("Segoe UI Semibold", 10.5f), Margin = new Padding(0, 0, 0, 8), MaximumSize = new Size(760, 0) };
        private readonly CheckBox _enabled = new CheckBox { Text = "Back up every night", AutoSize = true };
        private readonly TextBox _time = new TextBox { Width = 80 };
        private readonly TextBox _folder = new TextBox { Width = 420 };
        private readonly Label _folderNote = new Label { AutoSize = true, ForeColor = Ui.Muted, MaximumSize = new Size(560, 0) };
        private readonly ListView _status = Ui.List("Organisation", "Last good backup", "Size", "Latest attempt");
        private readonly ListView _files = Ui.List("Made", "Organisation", "Size", "File");
        private readonly Label _message = Ui.Status();
        private string _defaultFolder;

        public BackupsPage(TohyeeApi api)
        {
            _api = api;
            _status.Height = 130;
            _files.Height = 170;
            var page = Ui.Page();
            page.Controls.Add(Ui.Title("Backups"));
            page.Controls.Add(Ui.Note("Every night Tohyee backs up each organisation into its own file, encrypted with this server's secret key, keeps 14 daily and 12 monthly backups, and checks each file after it's made. Choose a OneDrive folder to get copies off this computer."));
            page.Controls.Add(Ui.Note("Restoring needs this server's secret key (TOHYEE_SECRET_KEY in " + Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "Tohyee", "tohyee.env") + "). Keep a copy of it somewhere safe that isn't the backup folder, such as a password manager."));
            page.Controls.Add(_state);

            var form = Ui.Form();
            Ui.Field(form, "Nightly", _enabled);
            Ui.Field(form, "At (24-hour)", _time);
            var folderRow = new FlowLayoutPanel { AutoSize = true, WrapContents = false, Margin = new Padding(0) };
            folderRow.Controls.Add(_folder);
            folderRow.Controls.Add(Ui.Btn("Browse…", (s, e) => Browse()));
            folderRow.Controls.Add(Ui.Btn("Use OneDrive", (s, e) => UseOneDrive()));
            Ui.Field(form, "Folder", folderRow);
            form.RowCount += 1;
            form.Controls.Add(new Label());
            form.Controls.Add(_folderNote);
            page.Controls.Add(form);

            var settingsButtons = Ui.Row();
            settingsButtons.Controls.Add(Ui.Btn("Save", async (s, e) => await Save()));
            settingsButtons.Controls.Add(Ui.Btn("Back up now", async (s, e) => await BackUpNow()));
            settingsButtons.Controls.Add(Ui.Btn("Open the folder", (s, e) => TrayApp.OpenFolder(_folder.Text.Trim())));
            page.Controls.Add(settingsButtons);

            page.Controls.Add(_status);
            page.Controls.Add(Ui.Note("Backup files. Restoring one makes a new organisation, e.g. \"Green Island (restored from 2026-09-27)\", with the same people, so you can check it before using it."));
            page.Controls.Add(_files);
            var fileButtons = Ui.Row();
            fileButtons.Controls.Add(Ui.Btn("Restore as a copy…", async (s, e) => await Restore()));
            fileButtons.Controls.Add(Ui.Btn("Refresh", async (s, e) => await Reload()));
            page.Controls.Add(fileButtons);
            page.Controls.Add(_message);
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
            foreach (ColumnHeader column in _status.Columns) column.Width = -2;
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
            foreach (ColumnHeader column in _files.Columns) column.Width = -2;
            _files.EndUpdate();

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
                _state.ForeColor = anyNever ? Color.Black : Ui.Success;
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

        private async Task Save()
        {
            var body = new Dictionary<string, object>
            {
                { "enabled", _enabled.Checked },
                { "time", _time.Text.Trim() },
                { "folder", _folder.Text.Trim() == _defaultFolder ? "" : _folder.Text.Trim() },
            };
            if (await Ui.Busy(this, _message, async () =>
            {
                await _api.Put("/api/admin/backups", body);
                Ui.Show(_message, "Saved. Tohyee checked it can write to that folder.", false);
            }))
            {
                await Reload();
            }
        }

        private async Task BackUpNow()
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
            if (await Ui.Busy(this, _message, async () =>
            {
                var result = await _api.PostLong("/api/admin/backups/restore", new Dictionary<string, object> { { "file", J.Str(file, "name") } });
                var organisation = J.Obj(result, "organisation");
                Ui.Show(_message, "Restored as " + J.Str(organisation, "displayName") + " (" + J.Str(organisation, "id") + "). Open Tohyee to check it.", false);
            }))
            {
                var keep = _message.Text;
                await Reload();
                Ui.Show(_message, keep, false);
            }
        }
    }
}

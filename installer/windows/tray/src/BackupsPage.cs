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
        private readonly Label _state = Ui.State();
        private readonly CheckBox _enabled = new DarkCheckBox { Text = "Back up every night", AutoSize = true };
        private readonly TextBox _time = new TextBox { Width = Theme.S(80) };
        private readonly TextBox _folder = new TextBox { Width = Theme.S(330) };
        private readonly Label _folderNote = new Label { AutoSize = true, ForeColor = Ui.Muted, MaximumSize = new Size(Theme.S(600), 0), Margin = new Padding(0, 2, 0, 6) };
        private readonly ListView _status = Ui.List("Organisation", "Last good backup", "Size", "Latest attempt");
        private readonly ListView _files = Ui.List("Made", "Organisation", "Size", "File");
        private readonly Label _message = Ui.Status();
        private readonly Label _keyState = Ui.State();
        private string _defaultFolder;

        public BackupsPage(TohyeeApi api)
        {
            _api = api;
            _status.Height = Theme.S(150);
            _files.Height = Theme.S(200);
            BackColor = Theme.Bg;
            var page = Ui.Page("Backups", "Every night Tohyee backs up each organisation into its own file, encrypted with this server's secret key, keeps 14 daily and 12 monthly backups, and checks each file after it's made. Choose a OneDrive or Google Drive folder to get copies off this computer.");

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

            var key = Ui.Card(page, "Your backup key", "Backups can only be opened with this server's backup key. If this computer is lost or rebuilt, you'll need a copy of the key to restore them, so save one somewhere safe that isn't the backup folder, such as a password manager. Then paste it back here so Tohyee can check your copy is exactly right.");
            key.Body.Controls.Add(_keyState);
            var keyButtons = Ui.Row();
            keyButtons.Controls.Add(Ui.Btn("Show the key…", async (s, e) => await ShowKey()));
            keyButtons.Controls.Add(Ui.Btn("Check my saved copy…", async (s, e) => await CheckKey()));
            key.Body.Controls.Add(keyButtons);

            var latest = Ui.Card(page, "Each organisation", null);
            latest.Body.Controls.Add(_status);

            var files = Ui.Card(page, "Backup files", "Restoring one makes a new organisation, e.g. \"Green Island (restored from 2026-09-27)\", with the same people, so you can check it before using it.");
            files.Body.Controls.Add(_files);
            var fileButtons = Ui.Row();
            fileButtons.Controls.Add(Ui.Btn("Restore as a copy…", async (s, e) => await Restore()));
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

            var keyStatus = J.Obj(result, "keyStatus");
            if (!J.Bool(keyStatus, "keySet"))
            {
                _keyState.Text = "There's no backup key yet (TOHYEE_SECRET_KEY isn't set).";
                _keyState.ForeColor = Ui.Danger;
            }
            else if (J.Str(keyStatus, "savedCopyCheckedAt") == null)
            {
                _keyState.Text = "Not saved yet: nobody has checked a saved copy of this key. Show the key, save it, then check your copy.";
                _keyState.ForeColor = Ui.Danger;
            }
            else
            {
                _keyState.Text = "Saved: " + J.Str(keyStatus, "savedCopyCheckedByEmail") + " checked a saved copy on " + J.When(J.Str(keyStatus, "savedCopyCheckedAt")) + ".";
                _keyState.ForeColor = Ui.Success;
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
                    // Made on another server (or before the key changed): ask for that server's key.
                    if (!error.Message.Contains("made with a different key")) throw;
                    var oldKey = AskKey("Restore from another server", "This backup was made with a different backup key, from another server or before this one was set up again. Paste the backup key you saved from that server:", true);
                    if (string.IsNullOrEmpty(oldKey)) throw;
                    body["key"] = oldKey;
                    Ui.Show(_message, "Restoring… this can take a few minutes.", false);
                    result = await _api.PostLong("/api/admin/backups/restore", body);
                }
                var organisation = J.Obj(result, "organisation");
                Ui.Show(_message, "Restored as " + J.Str(organisation, "displayName") + " (" + J.Str(organisation, "id") + "). Open Tohyee to check it.", false);
            }))
            {
                var keep = _message.Text;
                await Reload();
                Ui.Show(_message, keep, false);
            }
        }
        /// <summary>Asks for a key or password; null if cancelled.</summary>
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

        private async Task ShowKey()
        {
            var password = AskKey("Show the backup key", "To see the backup key, type your Tohyee password again (" + (_api.SignedInEmail ?? "") + "):", true);
            if (string.IsNullOrEmpty(password)) return;
            string key = null;
            await Ui.Busy(this, _message, async () =>
            {
                var result = await _api.Post("/api/admin/backups/key", new Dictionary<string, object> { { "password", password } });
                key = J.Str(result, "key");
            });
            if (key == null) return;
            using (var dialog = new Form
            {
                Text = "Your backup key",
                Font = Ui.Body,
                FormBorderStyle = FormBorderStyle.FixedDialog,
                StartPosition = FormStartPosition.CenterParent,
                MinimizeBox = false,
                MaximizeBox = false,
                ClientSize = new Size(Theme.S(560), Theme.S(230)),
            })
            {
                var label = new Label
                {
                    Text = "Save this key somewhere safe that isn't the backup folder, such as a password manager (as a note called \"Tohyee backup key\"). Anyone with the key and the backup files can read the books, so keep it private. Then use \"Check my saved copy\".",
                    Left = Theme.S(16), Top = Theme.S(12), Width = Theme.S(528), Height = Theme.S(72), AutoSize = false,
                };
                var box = new TextBox { Text = key, ReadOnly = true, Left = Theme.S(16), Top = Theme.S(92), Width = Theme.S(528), Font = Theme.F("Consolas", 11f) };
                var copied = new Label { Left = Theme.S(16), Top = Theme.S(130), Width = Theme.S(400), Height = Theme.S(22), ForeColor = Ui.Success };
                var copy = new Button { Text = "Copy", Left = Theme.S(16), Top = Theme.S(180), Width = Theme.S(90), Height = Theme.S(30) };
                copy.Click += (s, e) =>
                {
                    Clipboard.SetText(key);
                    copied.Text = "Copied. Paste it into your password manager now.";
                };
                var done = new Button { Text = "Done", DialogResult = DialogResult.OK, Left = Theme.S(454), Top = Theme.S(180), Width = Theme.S(90), Height = Theme.S(30) };
                dialog.Controls.AddRange(new Control[] { label, box, copied, copy, done });
                dialog.AcceptButton = done;
                Theme.Apply(dialog);
                copied.ForeColor = Ui.Success;
                dialog.ShowDialog(FindForm());
            }
            try
            {
                // Don't leave the key on the clipboard.
                if (Clipboard.ContainsText() && Clipboard.GetText() == key) Clipboard.Clear();
            }
            catch (Exception)
            {
                // The clipboard was busy; nothing more to do.
            }
        }

        private async Task CheckKey()
        {
            var pasted = AskKey("Check my saved copy", "Paste the backup key from where you saved it (your password manager). Tohyee checks it's exactly right:", false);
            if (string.IsNullOrEmpty(pasted)) return;
            if (await Ui.Busy(this, _message, async () =>
            {
                await _api.Post("/api/admin/backups/key/check", new Dictionary<string, object> { { "key", pasted } });
                Ui.Show(_message, "That's the right key. Your saved copy is good.", false);
            }))
            {
                var keep = _message.Text;
                await Reload();
                Ui.Show(_message, keep, false);
            }
        }
    }
}

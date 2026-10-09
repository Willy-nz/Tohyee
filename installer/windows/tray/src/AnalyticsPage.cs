using System;
using System.Collections.Generic;
using System.IO;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace Tohyee.Tray
{
    internal sealed class AnalyticsPage : UserControl
    {
        private readonly TohyeeApi _api;
        private readonly PageFlow _page;
        private readonly Label _message = Ui.Status();
        private readonly List<Card> _cards = new List<Card>();

        public AnalyticsPage(TohyeeApi api)
        {
            _api = api;
            BackColor = Theme.Bg;
            _page = Ui.Page("Analytics", "The folder on this computer each organisation's analytics reads CSV files from. Tohyee only reads them; it never changes or deletes files there.");
            var note = Ui.Card(_page, "Analytics folders", "Use a full path. Saving gives the Tohyee service permission to read it. Leave blank for none.");
            var buttons = Ui.Row();
            buttons.Controls.Add(Ui.Btn("Refresh", async (s, e) => await Reload()));
            note.Body.Controls.Add(buttons);
            note.Body.Controls.Add(_message);
            Controls.Add(_page);
            Load += async (s, e) => await Reload();
        }

        private async Task Reload()
        {
            _message.Text = "";
            await Ui.Busy(this, _message, async () =>
            {
                var result = await _api.Get("/api/admin/analytics-folders");
                if (IsDisposed) return;
                // One layout for the whole batch, not one per card removed and added (#198).
                _page.SuspendLayout();
                try
                {
                    foreach (var card in _cards)
                    {
                        _page.Controls.Remove(card);
                        card.Dispose();
                    }
                    _cards.Clear();
                    foreach (var entry in J.List(result, "folders")) AddOrganisation(entry);
                }
                finally
                {
                    _page.ResumeLayout(true);
                }
            });
        }

        private void AddOrganisation(Dictionary<string, object> entry)
        {
            var id = J.Str(entry, "organisationId");
            var name = J.Str(entry, "displayName");
            var card = Ui.Card(_page, name, id);
            _cards.Add(card);
            var savedFolder = J.Str(entry, "folder") ?? "";
            var form = Ui.Form();
            var folder = Ui.Field(form, "Folder", new TextBox { Text = savedFolder, AccessibleName = "Analytics folder for " + name });
            card.Body.Controls.Add(form);
            var state = Ui.State();
            ShowState(state, entry);
            card.Body.Controls.Add(state);
            var buttons = Ui.Row();
            buttons.Controls.Add(Ui.Btn("Browse…", (s, e) => Browse(folder)));
            var save = Ui.Primary("Save", null);
            save.Enabled = false;
            folder.TextChanged += (s, e) => save.Enabled = folder.Text.Trim() != savedFolder;
            save.Click += async (s, e) =>
            {
                var chosen = folder.Text.Trim();
                // Decision 486: the service runs as its own account, so it's given the chosen folder to read first.
                var problem = chosen.Length > 0 ? FolderAccess.Grant(chosen, false) : null;
                if (problem != null) Ui.Show(_message, problem, true);
                if (await Ui.Busy(this, _message, async () =>
                {
                    await _api.Put("/api/admin/analytics-folders", new Dictionary<string, object>
                    {
                        { "organisationId", id },
                        { "folder", chosen },
                    });
                    var result = await _api.Get("/api/admin/analytics-folders");
                    var updated = J.List(result, "folders").Find(row => J.Str(row, "organisationId") == id);
                    if (updated != null)
                    {
                        savedFolder = J.Str(updated, "folder") ?? "";
                        folder.Text = savedFolder;
                        ShowState(state, updated);
                        save.Enabled = false;
                    }
                    Ui.Show(_message, chosen.Length == 0 ? name + " has no analytics folder now." : name + " now reads files from " + chosen + ".", false);
                })) save.Enabled = folder.Text.Trim() != savedFolder;
            };
            buttons.Controls.Add(save);
            card.Body.Controls.Add(buttons);
            card.Refit();
        }

        private static void ShowState(Label state, Dictionary<string, object> entry)
        {
            var hasFolder = !string.IsNullOrEmpty(J.Str(entry, "folder"));
            var readable = J.Bool(entry, "readable");
            state.Text = !hasFolder ? "None" : readable ? "Readable" : "Can't open it";
            state.ForeColor = !hasFolder ? Theme.Muted : readable ? Ui.Success : Ui.Danger;
        }

        private void Browse(TextBox folder)
        {
            using (var dialog = new FolderBrowserDialog { Description = "Where should Tohyee read analytics CSV files from?", ShowNewFolderButton = false })
            {
                if (Directory.Exists(folder.Text.Trim())) dialog.SelectedPath = folder.Text.Trim();
                if (dialog.ShowDialog(FindForm()) == DialogResult.OK) folder.Text = dialog.SelectedPath;
            }
        }
    }
}

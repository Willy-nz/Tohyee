using System;
using System.Collections.Generic;
using System.Drawing;
using System.Linq;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace Tohyee.Tray
{
    /// <summary>
    /// Updates: compares this server with the latest release on GitHub. On
    /// Windows, updating means running the new TohyeeSetup; your data is kept.
    /// </summary>
    internal sealed class UpdatesPage : UserControl
    {
        private readonly TohyeeApi _api;
        private readonly Label _result = new Label { AutoSize = true, Font = new Font("Segoe UI Semibold", 10.5f), MaximumSize = new Size(720, 0), Margin = new Padding(0, 8, 0, 4) };
        private readonly Label _detail = new Label { AutoSize = true, ForeColor = Ui.Muted, MaximumSize = new Size(720, 0), Margin = new Padding(0, 0, 0, 8) };
        private readonly FlowLayoutPanel _links = Ui.Row();
        private readonly Label _status = Ui.Status();

        public UpdatesPage(TohyeeApi api)
        {
            _api = api;
            var page = Ui.Page();
            page.Controls.Add(Ui.Title("Updates"));
            page.Controls.Add(Ui.Note("Compares this server with the latest release on GitHub. To update, download the new TohyeeSetup and run it on this computer: it stops Tohyee, replaces the program, keeps your data and passwords, and starts it again. Back up first (tray menu → Back up now)."));
            var buttons = Ui.Row();
            buttons.Controls.Add(Ui.Btn("Check now", async (s, e) => await Check()));
            page.Controls.Add(buttons);
            page.Controls.Add(_result);
            page.Controls.Add(_detail);
            page.Controls.Add(_links);
            page.Controls.Add(_status);
            Controls.Add(page);
        }

        private async Task Check()
        {
            _status.Text = "";
            _links.Controls.Clear();
            await Ui.Busy(this, _status, async () =>
            {
                var check = await _api.Get("/api/updates/latest-release");
                var release = J.Obj(check, "release");
                var available = J.Bool(check, "updateAvailable");
                _result.Text = "This server runs v" + J.Str(check, "currentVersion") + ". The latest release is v" + J.Str(check, "latestVersion") + (available ? ": an update is available." : ": you're up to date.");
                _result.ForeColor = available ? Color.FromArgb(180, 83, 9) : Ui.Success;
                var published = J.Str(release, "publishedAt");
                _detail.Text = (J.Str(release, "name") ?? J.Str(release, "tagName")) + (published != null ? ", published " + J.When(published) : "");
                var notes = J.Str(release, "htmlUrl");
                if (notes != null) _links.Controls.Add(Ui.Btn("Release notes", (s, e) => TrayApp.Open(notes)));
                var setup = J.List(release, "assets").FirstOrDefault(asset => (J.Str(asset, "name") ?? "").StartsWith("TohyeeSetup-", StringComparison.OrdinalIgnoreCase) && (J.Str(asset, "name") ?? "").EndsWith(".exe", StringComparison.OrdinalIgnoreCase));
                if (setup != null && available)
                {
                    var url = J.Str(setup, "downloadUrl");
                    _links.Controls.Add(Ui.Btn("Download " + J.Str(setup, "name"), (s, e) => TrayApp.Open(url)));
                }
            });
        }
    }
}

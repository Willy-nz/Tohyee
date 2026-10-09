using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace Tohyee.Tray
{
    /// <summary>
    /// Sign-ins (#208, decision 487): every sign-in attempt on this server for
    /// the last year, newest first, with the suspicious ones flagged: a new
    /// device or address, several failures, someone guessing from one address,
    /// a locked login, a backup code, an emailed two-step reset, a server admin
    /// through remote access. Reported, never blocked (Jess).
    /// </summary>
    internal sealed class SignInsPage : UserControl
    {
        private readonly TohyeeApi _api;
        private readonly ListView _list = Ui.List("When", "Login", "What", "From", "Remote", "Flag", "Browser");
        private readonly CheckBox _flagged = new DarkCheckBox { Text = "Flagged only", AutoSize = true };
        private readonly CheckBox _remote = new DarkCheckBox { Text = "Through remote access only", AutoSize = true };
        private readonly Label _unseen = new Label { AutoSize = true, ForeColor = Theme.Warning, Font = Theme.Strong, Margin = new Padding(0, 0, 0, 6), Visible = false };
        private readonly Label _status = Ui.Status();
        private readonly Action<int> _badge;

        public SignInsPage(TohyeeApi api, Action<int> badge)
        {
            _api = api;
            _badge = badge;
            BackColor = Theme.Bg;
            var page = Ui.Page("Sign-ins", "Every sign-in attempt on this server for the last year. Anything unusual is flagged and emailed to the person and the server admins; nothing is blocked. If one wasn't them, sign them out everywhere on the Users page and reset their password.");
            var card = Ui.Card(page, null, null);
            card.Body.Controls.Add(_unseen);
            var buttons = Ui.Row();
            buttons.Margin = new Padding(0, 0, 0, 8);
            buttons.Controls.Add(_flagged);
            buttons.Controls.Add(_remote);
            buttons.Controls.Add(Ui.Btn("I've looked", async (s, e) => await MarkSeen()));
            buttons.Controls.Add(Ui.Btn("Refresh", async (s, e) => await Reload()));
            card.Body.Controls.Add(buttons);
            _list.Height = Theme.S(380);
            card.Body.Controls.Add(_list);
            card.Body.Controls.Add(_status);
            _flagged.CheckedChanged += async (s, e) => await Reload();
            _remote.CheckedChanged += async (s, e) => await Reload();
            Controls.Add(page);
            Ui.LoadWhenShown(this, Reload, TimeSpan.FromMinutes(1));
        }

        private static string What(Dictionary<string, object> entry)
        {
            var outcome = J.Str(entry, "outcome");
            var text = outcome == "signed_in" ? "Signed in" : outcome == "password_ok" ? "Password right" : outcome == "failed" ? "Failed" : outcome == "locked" ? "Locked" : "Refused";
            var step = J.Str(entry, "step");
            var how = step == "code" ? "code" : step == "backup_code" ? "backup code" : step == "setup_link" ? "setup link" : step == "reset_link" ? "reset link" : step == "first_admin" ? "first admin" : "password";
            return text + " (" + how + ")";
        }

        private async Task Reload()
        {
            await Ui.Busy(this, _status, async () =>
            {
                var path = "/api/admin/sign-ins?flagged=" + (_flagged.Checked ? "true" : "false") + "&remote=" + (_remote.Checked ? "true" : "false");
                var result = await _api.Get(path);
                if (IsDisposed) return;
                ShowUnseen(J.Int(J.Obj(result, "unseen"), "count"));
                _list.BeginUpdate();
                _list.Items.Clear();
                foreach (var entry in J.List(result, "events"))
                {
                    var item = new ListViewItem(new[]
                    {
                        J.When(J.Str(entry, "at")),
                        J.Str(entry, "email"),
                        What(entry),
                        J.Str(entry, "address") ?? "",
                        J.Bool(entry, "remote") ? "Yes" : "",
                        J.Str(entry, "flag") ?? "",
                        J.Str(entry, "userAgent") ?? "",
                    })
                    { Tag = entry };
                    if (J.Str(entry, "flag") != null) item.ForeColor = Theme.Warning;
                    else if (J.Str(entry, "outcome") == "failed" || J.Str(entry, "outcome") == "locked") item.ForeColor = Ui.Muted;
                    _list.Items.Add(item);
                }
                Ui.FitColumns(_list);
                _list.EndUpdate();
            });
        }

        private void ShowUnseen(int count)
        {
            _unseen.Text = count == 1 ? "1 flagged sign-in since you last looked." : count + " flagged sign-ins since you last looked.";
            _unseen.Visible = count > 0;
            if (_badge != null) _badge(count);
        }

        private async Task MarkSeen()
        {
            await Ui.Busy(this, _status, async () =>
            {
                var result = await _api.Post("/api/admin/sign-ins/seen", null);
                ShowUnseen(J.Int(J.Obj(result, "unseen"), "count"));
            });
        }
    }
}

using System;
using System.Collections.Generic;
using System.Drawing;
using System.Linq;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace Tohyee.Tray
{
    /// <summary>
    /// Organisations: each has its own database. Create one, rename it, retry a
    /// failed set-up or upgrade, take it out of use (it's kept, not deleted), or
    /// hand it over to a new owner after a 7-day wait (#208).
    /// </summary>
    internal sealed class OrganisationsPage : UserControl
    {
        private readonly TohyeeApi _api;
        private readonly ListView _list = Ui.List("Name", "ID", "Currency", "Status", "People", "Created");
        private readonly Label _status = Ui.Status();
        private List<Dictionary<string, object>> _organisations = new List<Dictionary<string, object>>();
        /// <summary>Handovers still waiting, by organisation (#208).</summary>
        private Dictionary<string, Dictionary<string, object>> _handovers = new Dictionary<string, Dictionary<string, object>>();

        public OrganisationsPage(TohyeeApi api)
        {
            _api = api;
            BackColor = Theme.Bg;
            var page = Ui.Page("Organisations", "Each organisation has its own PostgreSQL database, so it can be backed up, restored or moved on its own. Being a server admin doesn't give you access to an organisation's books; its owner adds people. If its owners can't (they died or left), Hand over makes someone else an owner after a 7-day wait the owners can cancel.");
            var card = Ui.Card(page, null, null);
            var buttons = Ui.Row();
            buttons.Margin = new Padding(0, 0, 0, 8);
            buttons.Controls.Add(Ui.Primary("New organisation…", async (s, e) => await Create()));
            buttons.Controls.Add(Ui.Btn("Rename…", async (s, e) => await Rename()));
            buttons.Controls.Add(Ui.Btn("Retry set-up or upgrade", async (s, e) => await Repair()));
            buttons.Controls.Add(Ui.Btn("Take out of use / put back", async (s, e) => await ToggleActive()));
            buttons.Controls.Add(Ui.Btn("Hand over…", async (s, e) => await HandOver()));
            buttons.Controls.Add(Ui.Btn("Refresh", async (s, e) => await Reload()));
            card.Body.Controls.Add(buttons);
            _list.Height = Theme.S(320);
            card.Body.Controls.Add(_list);
            card.Body.Controls.Add(_status);
            Controls.Add(page);
            // Again when shown after a minute away (#198); the selected row stays selected.
            Ui.LoadWhenShown(this, Reload, TimeSpan.FromMinutes(1));
        }

        private static string StatusText(Dictionary<string, object> organisation)
        {
            if (!J.Bool(organisation, "isActive")) return "Out of use";
            var provisioning = J.Str(organisation, "provisioningStatus");
            var migration = J.Str(organisation, "migrationStatus");
            if (provisioning == "failed") return "Set-up failed: " + J.Str(organisation, "provisioningError");
            if (provisioning == "pending") return "Setting up";
            if (migration == "failed") return "Upgrade failed: " + J.Str(organisation, "migrationError");
            if (migration == "pending") return "Upgrading";
            return "Ready";
        }

        private async Task Reload()
        {
            await Ui.Busy(this, _status, async () =>
            {
                _organisations = J.List(await _api.Get("/api/admin/organisations"), "organisations");
                var handovers = J.List(await _api.Get("/api/admin/handovers"), "handovers");
                if (IsDisposed) return;
                _handovers = new Dictionary<string, Dictionary<string, object>>();
                foreach (var handover in handovers)
                {
                    if (J.Str(handover, "status") == "waiting") _handovers[J.Str(handover, "organisationId")] = handover;
                }
                var selected = Ui.SelectedKey(_list, tag => J.Str((Dictionary<string, object>)tag, "id"));
                _list.BeginUpdate();
                _list.Items.Clear();
                foreach (var organisation in _organisations)
                {
                    var status = StatusText(organisation);
                    Dictionary<string, object> waiting;
                    if (_handovers.TryGetValue(J.Str(organisation, "id"), out waiting))
                    {
                        status += " · handing over to " + J.Str(waiting, "toEmail") + " on " + J.When(J.Str(waiting, "takesEffectAt"));
                    }
                    var item = new ListViewItem(new[]
                    {
                        J.Str(organisation, "displayName"),
                        J.Str(organisation, "id"),
                        J.Str(organisation, "baseCurrency"),
                        status,
                        J.Int(organisation, "memberCount").ToString(),
                        J.When(J.Str(organisation, "createdAt")),
                    })
                    { Tag = organisation };
                    if (status.StartsWith("Set-up failed") || status.StartsWith("Upgrade failed")) item.ForeColor = Ui.Danger;
                    else if (status == "Out of use") item.ForeColor = Ui.Muted;
                    else if (status != "Ready") item.ForeColor = Theme.Warning;
                    _list.Items.Add(item);
                }
                Ui.FitColumns(_list);
                _list.EndUpdate();
                Ui.Reselect(_list, selected, tag => J.Str((Dictionary<string, object>)tag, "id"));
                if (_organisations.Count == 0) Ui.Show(_status, "No organisations yet. Use New organisation to create the first one.", false);
            });
        }

        private Dictionary<string, object> Selected()
        {
            if (_list.SelectedItems.Count == 0)
            {
                Ui.Show(_status, "Choose an organisation in the list first.", true);
                return null;
            }
            return (Dictionary<string, object>)_list.SelectedItems[0].Tag;
        }

        private async Task Create()
        {
            using (var dialog = new NewOrganisationDialog(_api.SignedInEmail))
            {
                if (dialog.ShowDialog(FindForm()) != DialogResult.OK) return;
                if (await Ui.Busy(this, _status, async () =>
                {
                    var result = await _api.Post("/api/admin/organisations", new Dictionary<string, object>
                    {
                        { "id", dialog.OrganisationId },
                        { "displayName", dialog.DisplayName },
                        { "baseCurrency", dialog.Currency },
                        { "ownerEmail", dialog.OwnerEmail },
                    });
                    var created = J.Obj(result, "organisation");
                    Ui.Show(_status, "Created " + J.Str(created, "displayName") + " (" + StatusText(created) + ").", false);
                }))
                {
                    await Reload();
                }
            }
        }

        private async Task Rename()
        {
            var organisation = Selected();
            if (organisation == null) return;
            var name = Ui.Ask(FindForm(), "Rename organisation", "New name for " + J.Str(organisation, "displayName") + ":", J.Str(organisation, "displayName"));
            if (string.IsNullOrEmpty(name)) return;
            if (await Ui.Busy(this, _status, async () =>
            {
                await _api.Patch("/api/admin/organisations/" + Uri.EscapeDataString(J.Str(organisation, "id")), new Dictionary<string, object> { { "displayName", name } });
                Ui.Show(_status, "Renamed to " + name + ".", false);
            }))
            {
                await Reload();
            }
        }

        private async Task Repair()
        {
            var organisation = Selected();
            if (organisation == null) return;
            if (await Ui.Busy(this, _status, async () =>
            {
                var result = await _api.Post("/api/admin/organisations/" + Uri.EscapeDataString(J.Str(organisation, "id")) + "/repair", null);
                Ui.Show(_status, J.Str(organisation, "displayName") + ": " + StatusText(J.Obj(result, "organisation")) + ".", false);
            }))
            {
                await Reload();
            }
        }

        /// <summary>
        /// #208: makes someone else an owner when the organisation's owners can't (died, left). It waits
        /// 7 days; the owners and admins are emailed and any of them can cancel it. Not to yourself.
        /// </summary>
        private async Task HandOver()
        {
            var organisation = Selected();
            if (organisation == null) return;
            var id = J.Str(organisation, "id");
            var path = "/api/admin/organisations/" + Uri.EscapeDataString(id) + "/handover";
            Dictionary<string, object> waiting;
            if (_handovers.TryGetValue(id, out waiting))
            {
                if (!Ui.Confirm(FindForm(), J.Str(organisation, "displayName") + " is being handed over to " + J.Str(waiting, "toEmail") + " on " + J.When(J.Str(waiting, "takesEffectAt")) + ". Cancel it?")) return;
                if (await Ui.Busy(this, _status, async () =>
                {
                    await _api.Delete(path);
                    Ui.Show(_status, "The handover of " + J.Str(organisation, "displayName") + " is cancelled.", false);
                }))
                {
                    await Reload();
                }
                return;
            }
            string email;
            string reason;
            using (var dialog = new HandoverDialog(J.Str(organisation, "displayName")))
            {
                if (dialog.ShowDialog(FindForm()) != DialogResult.OK) return;
                email = dialog.Email;
                reason = dialog.Reason;
            }
            if (await Ui.Busy(this, _status, async () =>
            {
                var result = J.Obj(await _api.Post(path, new Dictionary<string, object> { { "email", email }, { "reason", reason } }), "handover");
                Ui.Show(_status, J.Str(organisation, "displayName") + " will be handed over to " + J.Str(result, "toEmail") + " on " + J.When(J.Str(result, "takesEffectAt")) + " unless its owners or admins cancel it.", false);
            }))
            {
                await Reload();
            }
        }

        private async Task ToggleActive()
        {
            var organisation = Selected();
            if (organisation == null) return;
            var active = J.Bool(organisation, "isActive");
            var question = active
                ? "Take " + J.Str(organisation, "displayName") + " out of use? Nobody can open its books until it's put back. Its database is kept."
                : "Put " + J.Str(organisation, "displayName") + " back in use?";
            if (!Ui.Confirm(FindForm(), question)) return;
            if (await Ui.Busy(this, _status, async () =>
            {
                await _api.Patch("/api/admin/organisations/" + Uri.EscapeDataString(J.Str(organisation, "id")), new Dictionary<string, object> { { "isActive", !active } });
                Ui.Show(_status, J.Str(organisation, "displayName") + (active ? " is out of use." : " is back in use."), false);
            }))
            {
                await Reload();
            }
        }
    }

    /// <summary>Who to hand an organisation to, and why (#208).</summary>
    internal sealed class HandoverDialog : Form
    {
        private readonly TextBox _email = new TextBox();
        private readonly TextBox _reason = new TextBox { Multiline = true, Height = Theme.S(70) };
        private readonly Label _error = Ui.Status();

        public string Email { get { return _email.Text.Trim(); } }
        public string Reason { get { return _reason.Text.Trim(); } }

        public HandoverDialog(string organisation)
        {
            Text = "Hand over " + organisation;
            Font = Ui.Body;
            FormBorderStyle = FormBorderStyle.FixedDialog;
            StartPosition = FormStartPosition.CenterParent;
            MinimizeBox = false;
            MaximizeBox = false;
            AutoSize = true;
            AutoSizeMode = AutoSizeMode.GrowAndShrink;
            var page = new FlowLayoutPanel { FlowDirection = FlowDirection.TopDown, AutoSize = true, Padding = new Padding(20), WrapContents = false };
            page.Controls.Add(Ui.Note("For when " + organisation + "'s owners can't add a new owner themselves (for example the owner has died or left). The person you choose becomes an owner after 7 days. Its owners and admins are emailed now, see it when they sign in, and any of them can cancel it. Nobody loses access. You can't choose yourself."));
            var form = Ui.Form();
            Ui.Field(form, "Their login (email)", _email);
            Ui.Field(form, "Why", _reason);
            page.Controls.Add(form);
            page.Controls.Add(Ui.Note("The reason is shown to the owners and admins and kept in the organisation's history, e.g. \"The owner has died; this is the executor's accountant.\" Add their login on the Users page first."));
            page.Controls.Add(_error);
            var ok = Ui.Primary("Hand over in 7 days", null);
            var cancel = Ui.Btn("Cancel", null);
            cancel.DialogResult = DialogResult.Cancel;
            ok.Click += (s, e) =>
            {
                if (!Email.Contains("@")) Ui.Show(_error, "Enter the email of their Tohyee login.", true);
                else if (Reason.Length < 5) Ui.Show(_error, "Say why (at least 5 characters).", true);
                else DialogResult = DialogResult.OK;
            };
            var buttons = Ui.Row();
            buttons.Controls.Add(ok);
            buttons.Controls.Add(cancel);
            page.Controls.Add(buttons);
            Controls.Add(page);
            CancelButton = cancel;
            Theme.Apply(this);
        }
    }

    internal sealed class NewOrganisationDialog : Form
    {
        private readonly TextBox _name = new TextBox();
        private readonly TextBox _id = new TextBox();
        private readonly ComboBox _currency = new ComboBox { DropDownStyle = ComboBoxStyle.DropDown };
        private readonly TextBox _owner = new TextBox();
        private readonly Label _error = Ui.Status();
        private bool _idTouched;

        public string DisplayName { get { return _name.Text.Trim(); } }
        public string OrganisationId { get { return _id.Text.Trim(); } }
        public string Currency { get { return _currency.Text.Trim().ToUpperInvariant(); } }
        public string OwnerEmail { get { return _owner.Text.Trim(); } }

        public NewOrganisationDialog(string ownerEmail)
        {
            Text = "New organisation";
            Font = Ui.Body;
            FormBorderStyle = FormBorderStyle.FixedDialog;
            StartPosition = FormStartPosition.CenterParent;
            MinimizeBox = false;
            MaximizeBox = false;
            AutoSize = true;
            AutoSizeMode = AutoSizeMode.GrowAndShrink;

            var page = new FlowLayoutPanel { FlowDirection = FlowDirection.TopDown, AutoSize = true, Padding = new Padding(20), WrapContents = false };
            page.Controls.Add(Ui.Note("It gets its own database with a starting New Zealand chart of accounts. The owner can add everyone else."));
            var form = Ui.Form();
            Ui.Field(form, "Name", _name);
            Ui.Field(form, "ID (in addresses)", _id);
            Ui.Field(form, "Base currency", _currency);
            Ui.Field(form, "Owner's email", _owner);
            page.Controls.Add(form);
            page.Controls.Add(_error);
            _currency.Items.AddRange(new object[] { "NZD", "AUD", "USD", "GBP", "EUR", "CAD", "SGD", "JPY" });
            _currency.Text = "NZD";
            _owner.Text = ownerEmail ?? "";
            _name.TextChanged += (s, e) =>
            {
                if (!_idTouched) _id.Text = Slug(_name.Text);
            };
            _id.KeyPress += (s, e) => _idTouched = true;

            var ok = Ui.Primary("Create", null);
            var cancel = Ui.Btn("Cancel", null);
            cancel.DialogResult = DialogResult.Cancel;
            ok.Click += (s, e) =>
            {
                var problem = Check();
                if (problem != null)
                {
                    Ui.Show(_error, problem, true);
                    return;
                }
                DialogResult = DialogResult.OK;
            };
            var buttons = Ui.Row();
            buttons.Controls.Add(ok);
            buttons.Controls.Add(cancel);
            page.Controls.Add(buttons);
            Controls.Add(page);
            AcceptButton = ok;
            CancelButton = cancel;
            Theme.Apply(this);
        }

        private string Check()
        {
            if (DisplayName.Length == 0) return "Give the organisation a name.";
            if (!Regex.IsMatch(OrganisationId, "^[a-z0-9][a-z0-9-]{0,31}$")) return "The ID can have lower-case letters, numbers and dashes (up to 32), starting with a letter or number.";
            if (!Regex.IsMatch(Currency, "^[A-Z]{3}$")) return "The currency is a three-letter code, like NZD.";
            if (!OwnerEmail.Contains("@")) return "Enter the owner's email (they need a Tohyee login already).";
            return null;
        }

        /// <summary>The same slug as the web page: lower case, dashes, at most 32 characters.</summary>
        public static string Slug(string name)
        {
            var slug = Regex.Replace(name.ToLowerInvariant(), "[^a-z0-9]+", "-").Trim('-');
            if (slug.Length > 32) slug = slug.Substring(0, 32);
            return slug.TrimEnd('-');
        }
    }
}

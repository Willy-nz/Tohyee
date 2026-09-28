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
    /// failed set-up or upgrade, or take it out of use (it's kept, not deleted).
    /// </summary>
    internal sealed class OrganisationsPage : UserControl
    {
        private readonly TohyeeApi _api;
        private readonly ListView _list = Ui.List("Name", "ID", "Currency", "Status", "People", "Created");
        private readonly Label _status = Ui.Status();
        private List<Dictionary<string, object>> _organisations = new List<Dictionary<string, object>>();

        public OrganisationsPage(TohyeeApi api)
        {
            _api = api;
            var page = Ui.Page();
            page.Controls.Add(Ui.Title("Organisations"));
            page.Controls.Add(Ui.Note("Each organisation has its own PostgreSQL database, so it can be backed up, restored or moved on its own. Being a server admin doesn't give you access to an organisation's books; its owner adds people."));
            page.Controls.Add(_list);
            var buttons = Ui.Row();
            buttons.Controls.Add(Ui.Btn("New organisation…", async (s, e) => await Create()));
            buttons.Controls.Add(Ui.Btn("Rename…", async (s, e) => await Rename()));
            buttons.Controls.Add(Ui.Btn("Retry set-up or upgrade", async (s, e) => await Repair()));
            buttons.Controls.Add(Ui.Btn("Take out of use / put back", async (s, e) => await ToggleActive()));
            buttons.Controls.Add(Ui.Btn("Refresh", async (s, e) => await Reload()));
            page.Controls.Add(buttons);
            page.Controls.Add(_status);
            Controls.Add(page);
            Load += async (s, e) => await Reload();
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
                _list.BeginUpdate();
                _list.Items.Clear();
                foreach (var organisation in _organisations)
                {
                    var status = StatusText(organisation);
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
                    _list.Items.Add(item);
                }
                foreach (ColumnHeader column in _list.Columns) column.Width = -2;
                _list.EndUpdate();
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

            var page = new FlowLayoutPanel { FlowDirection = FlowDirection.TopDown, AutoSize = true, Padding = new Padding(16), WrapContents = false };
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

            var ok = new Button { Text = "Create", AutoSize = true };
            var cancel = new Button { Text = "Cancel", DialogResult = DialogResult.Cancel, AutoSize = true };
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

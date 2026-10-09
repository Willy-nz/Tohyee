# Security policy

Tohyee is self-hosted accounting software that can hold financial records,
payroll information and credentials for connected services. Please report
suspected vulnerabilities privately so they can be investigated without
unnecessarily exposing people using the software.

## Reporting a vulnerability

Use GitHub's [Report a vulnerability form](https://github.com/Willy-nz/Tohyee/security/advisories/new)
to send a private report to the repository maintainers. You can also find it
under **Security and quality → Advisories → Report a vulnerability**.

If the form is unavailable, open a public issue asking for a private security
contact. Include only that request—not the vulnerability, affected server
address, reproduction steps or sensitive attachments. Wait for a private
channel before sharing details.

Ordinary bugs and feature requests can go in
[GitHub Issues](https://github.com/Willy-nz/Tohyee/issues). If a bug could expose
data, bypass permissions or affect the integrity of financial records, use
the private reporting process instead.

### What to include

- The affected release version or commit, and when you observed the problem.
- Your installation method and operating system: Windows installer, Docker
  or a source checkout.
- Whether access was local, over a private network, or through remote access
  such as Cloudflare Tunnel, a Tohyee address or Tailscale Funnel.
- The affected component and the permissions an attacker would need.
- Reproduction steps using a test organisation and fabricated data where
  possible, with expected and actual behaviour.
- The potential impact and any suggested mitigation or fix.
- Relevant, redacted logs or screenshots. State whether the finding came
  from source review, a test environment or an observed incident.

Do not send real accounting or payroll records, database backups, passwords,
authenticator or recovery codes, session cookies, API or tunnel tokens,
environment files, or the server's encryption/backup key. Replace sensitive
values with placeholders. If a credential has already been exposed, revoke
or rotate it through the affected service; deleting a posted value alone
does not make it safe again.

## Versions and security fixes

Check the [releases page](https://github.com/Willy-nz/Tohyee/releases) for the
latest published version and release notes. Please report the version you
are using even if it is older; do not upgrade a live installation merely to
reproduce a suspected vulnerability.

Security fixes target the current development branch and subsequent
releases. There is no published long-term-support schedule or guaranteed
backport policy for older versions. An unreleased change on `main` should
not be assumed to be available in an installed release.

## Handling reports

Maintainers will assess reports, may request additional information, and
coordinate any fix and disclosure through the private report. A report may
be a duplicate, a configuration issue or an unconfirmed finding; its status
and any further evidence needed should be discussed there.

There is no guaranteed response or resolution time. This policy does not
offer a bug bounty or other payment. Please coordinate public disclosure
with the maintainers so users have an opportunity to apply a fix or
mitigation. Security advisories and release notes are the places to check
for published fixes.

## Scope and responsible testing

Relevant areas include the web application and API, authentication and
permissions, organisation isolation, analytics and file handling, payroll,
integrations, the address relay, remote access, and the installers and
update process.

Test only systems you own or have explicit permission to assess. Use a
separate test installation where possible. Do not access other people's
records, disrupt a live service, or test third-party services without their
permission. This policy does not authorise testing other Tohyee installations
or Cloudflare, Tailscale or connected service infrastructure.

## For people running Tohyee

Keep Tohyee and its supporting software updated, review release notes, and
maintain tested backups with the recovery key stored securely and separately.
Protect administrator accounts, enable two-step sign-in and grant users only
the access they need.

Public remote access exposes the application's sign-in page to the internet;
a tunnel is not a replacement for application authentication. Tailscale
Funnel is public access, unlike private tailnet access. Only expose the
intended application endpoint, never the local administration endpoint or
database. Review your tunnel provider's access controls and trust model.

If you suspect active compromise, restrict remote access using the relevant
provider or network controls, preserve logs, and contact the person managing
your server. A GitHub vulnerability report is not an emergency incident
response service. Do not delete the server's encryption key as a containment
step: it is needed to recover encrypted secrets and backups.

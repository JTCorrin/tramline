# Security

Security is a core goal of Tramline: it runs your code on your infrastructure and holds your secrets, so the safe choice should always be the default. See [Secure by default](docs/roadmap.md#secure-by-default) for the design and what is still to come.

## Reporting a vulnerability

Please **do not open a public issue**. Report it privately through GitHub's [private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability) on this repository, with steps to reproduce and the affected version. We aim to acknowledge reports within 3 working days and to publish a fix and advisory as soon as one is ready.

## Supported versions

Tramline is pre-1.0. Only the latest `main` receives security fixes.

## What Tramline does today

- **Secrets:** variable values and deployment snapshots are encrypted at rest with AES-256-GCM, using a key derived from `TRAMLINE_SECRET_KEY`. Sealed variables are write-only: the API never returns them. Values of sealed and secret-looking variables (including a sealed value copied into another variable through references), and passwords inside URLs, are masked in deployment logs before they are stored. Masking prevents accidental disclosure; it cannot stop code that is given a secret from deliberately encoding and leaking it.
- **Containers:** every workload runs with `no-new-privileges` and all capabilities dropped except a small allowlist (no `NET_RAW`, `MKNOD`, `SYS_CHROOT`, …), a process limit, and an optional memory limit and read-only root filesystem. Workloads never get host mounts, so the Docker socket cannot leak into them.
- **Builds:** source builds run in a rootless BuildKit container, never `--privileged`. It does relax Docker's seccomp and AppArmor profiles for the builder only, which its user namespace requires. Service variables reach builds as BuildKit secrets, which BuildKit doesn't write into images or logs (a build step can still print or copy one). Build tools are pinned by checksum and re-verified on every use. **Known limitation:** builds on a node share one long-lived builder that runs without BuildKit's process sandbox, so one build can interfere with another; until per-build builders land, don't run builds for organizations that don't trust each other on the same node.
- **Images:** every image is scanned with Trivy before it runs, by default. Built images are scanned as a tarball before they reach Docker; registry images are scanned by the exact digest pulled, and the deployment then runs that digest. Per service, `warn` shows the findings and deploys, `block` refuses images with critical vulnerabilities that have a fix (and images that could not be scanned), and `off` skips the scan. Trivy runs inside the unprivileged builder, without access to the Docker socket, and is pinned by checksum.
- **Backups:** a dump or restore that fails anywhere in its pipeline is reported as failed, Postgres restores stop at the first SQL error, and retention never deletes the newest successful backups to keep failed ones. Encrypted on the node with a per-backup AES-256-GCM key (wrapped with `TRAMLINE_SECRET_KEY`) before upload, so the bucket provider only ever stores ciphertext. Nodes upload and download through presigned URLs for single objects and never hold bucket credentials; the bucket's secret key is encrypted at rest and write-only in the API. A restore applies nothing unless the whole backup authenticates, and restore drills prove backups can be restored before they are needed.
- **The control plane's database:** with `TRAMLINE_BACKUP_S3_*` set, it is snapshotted hourly, encrypted with a key derived from `TRAMLINE_SECRET_KEY` before upload, and drilled daily.
- **GitHub:** Tramline's GitHub App asks only for read access to repository contents and metadata. Its private key and webhook secret are encrypted at rest, and push webhooks are verified with HMAC in constant time. Installation tokens live for an hour, are never stored, are issued only for installations the organization connected, and are restricted to the one repository a build needs; they are only ever sent to `https://github.com`. **Known limitation:** connecting an installation checks it belongs to Tramline's app, not that the person connecting it controls that GitHub account; until user authorization during install lands, only connect installations on accounts your organization owns.
- **Custom domains:** traffic is routed only after a TXT record proves the domain is yours, hostnames are unique across the install, and generated names can't be claimed. HSTS on a custom domain covers that host only.
- **Data browser:** read-only by construction: the control plane builds every query, each runs in a `READ ONLY` transaction with a statement timeout inside the database container, and table names are checked against the database's own list.
- **API tokens:** shown once and stored as SHA-256 hashes; scoped (`read`, `write`, `deploy`), optionally expiring, and tied to their creator's membership. `write` only stages changes; applying them and deleting anything that runs needs `deploy`. Tokens cannot create tokens, change organization settings or manage nodes, and every change made through the API is recorded in the audit log.
- **Sign-in:** optional TOTP two-factor authentication with backup codes, and passkeys (WebAuthn) bound to the install's hostname.
- **CI without secrets:** GitHub Actions workflows from trusted repositories (pinned by repository id, optionally limited to refs and environments) exchange their OIDC token, verified against GitHub's keys with the issuer, audience and expiry checked, for an API token that lasts 15 minutes.
- **Nodes and agents:** agents connect outbound with per-node tokens (stored hashed) and need no inbound control port. A node's reports (containers, builds, logs, backup jobs) only count for work assigned to it. Machines join with one-time, expiring join tokens. Nodes are managed only by install admins, an explicit grant: the first admin claims the install with a one-time setup token from the server's data directory.
- **Web app:** a nonce-based Content Security Policy with no inline or eval scripts, `X-Frame-Options: DENY`, `nosniff`, a strict referrer policy, HSTS over HTTPS, rate-limited sign-in, and organization scoping on every query.
- **Ingress:** HTTPS with automatic certificates and HSTS on real domains. Caddy's admin API is never exposed.
- **Supply chain:** CodeQL, gitleaks secret scanning, `pnpm audit` and Dependabot run in CI.

## Operating a secure install

- Generate `TRAMLINE_SECRET_KEY` with `openssl rand -base64 32` and keep it out of the repository. Losing it makes stored secrets and backups unreadable; leaking it exposes them. Keep a copy somewhere other than the server.
- Serve the control plane over HTTPS (`TRAMLINE_URL=https://…`).
- Treat `apps/web/data/local-agent.token` like a password: it lets an agent receive your services' secrets. The same goes for `setup-token` in the data directory until someone claims the install, so claim it as soon as the install is up.
- Run one control-plane process. Events, live logs, pending data-browser queries and the schedulers live in that process's memory; several web workers would each run their own.
- Public sign-up is open: anyone who can reach the sign-up page can create an account and an organization (but not manage nodes). Keep the install private until sign-up policies land if that matters to you.

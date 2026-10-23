# Security

Security is a core goal of Tramline: it runs your code on your infrastructure and holds your secrets, so the safe choice should always be the default. See [Secure by default](docs/roadmap.md#secure-by-default) for the design and what is still to come.

## Reporting a vulnerability

Please **do not open a public issue**. Report it privately through GitHub's [private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability) on this repository, with steps to reproduce and the affected version. We aim to acknowledge reports within 3 working days and to publish a fix and advisory as soon as one is ready.

## Supported versions

Tramline is pre-1.0. Only the latest `main` receives security fixes.

## What Tramline does today

- **Secrets:** variable values and deployment snapshots are encrypted at rest with AES-256-GCM, using a key derived from `TRAMLINE_SECRET_KEY`. Sealed variables are write-only: the API never returns them. Values of sealed and secret-looking variables, and passwords inside URLs, are redacted from deployment logs before they are stored.
- **Containers:** every workload runs with `no-new-privileges` and all capabilities dropped except a small allowlist (no `NET_RAW`, `MKNOD`, `SYS_CHROOT`, …), a process limit, and an optional memory limit and read-only root filesystem. Workloads never get host mounts, so the Docker socket cannot leak into them.
- **Builds:** source builds run in a rootless BuildKit container, never `--privileged`. It does relax Docker's seccomp and AppArmor profiles for the builder only, which its user namespace requires. Service variables reach builds only as BuildKit secrets, never in the image or the logs. Build tools are pinned by checksum or digest.
- **Agents:** they connect outbound with per-node tokens (stored hashed), may only write logs for their own deployments, and need no inbound control port.
- **Web app:** a nonce-based Content Security Policy with no inline or eval scripts, `X-Frame-Options: DENY`, `nosniff`, a strict referrer policy, HSTS over HTTPS, rate-limited sign-in, and organization scoping on every query.
- **Ingress:** HTTPS with automatic certificates and HSTS on real domains. Caddy's admin API is never exposed.
- **Supply chain:** CodeQL, gitleaks secret scanning, `pnpm audit` and Dependabot run in CI.

## Operating a secure install

- Generate `TRAMLINE_SECRET_KEY` with `openssl rand -base64 32` and keep it out of the repository. Losing it makes stored secrets unreadable; leaking it exposes them.
- Serve the control plane over HTTPS (`TRAMLINE_URL=https://…`).
- Treat `apps/web/data/local-agent.token` like a password: it lets an agent receive your services' secrets.

# Tramline roadmap

## Context

Tramline is an open-source, self-hosted, slimmed-down Railway. It keeps Railway's UX: **Project → empty canvas → right-click to add components → side panel for deployments, variables, networking and settings**. Workloads run on compute the user chooses (local Docker, Proxmox, Hetzner/AWS/GCP/Azure), and Tramline can recommend the cheapest place to run them.

Core decisions:

- **Self-hosted first**: one install per team, SQLite is the control-plane database.
- **Compute model**: Tramline provisions or enrolls Linux VMs, runs a **Tramline agent + Docker** on each, and schedules containers onto them. Every provider uses the same runtime, so prices can be compared like for like.
- **Agent in TypeScript**, shipped as a single binary with `bun build --compile`.
- **First deploy target: local Docker.**

---

## Architecture

```
 Browser (SvelteKit UI)       tram CLI · MCP server (agents)
   │  resource layer (get/getAll/update…)   │
   └──────────── packages/client ───────────┘
                     │ HTTPS  /api/v1  + SSE /api/v1/events
┌────────────────────▼───────────────────────────────────────┐
│ Control plane — apps/web (SvelteKit, adapter-node, 1 proc) │
│  • REST API (zod-validated, versioned)                     │
│  • Domain services (src/lib/server/domain/*)               │
│  • SQLite + Drizzle (WAL)   • better-auth (+organization)  │
│  • Job queue (SQLite-backed) • Reconciler / scheduler      │
│  • Agent gateway (WebSocket)  • Pricing catalog + placement│
│  • Adapter registry (manual, proxmox, hetzner, aws, gcp…) │
└───────────▲───────────────────────────────▲────────────────┘
            │ agent dials OUT over wss       │ cloud APIs
   ┌────────┴────────┐  WireGuard mesh  ┌────┴────────────┐
   │ Node (local)    │◄───────────────►│ Node (cloud VM)  │
   │ tramline-agent  │                  │ tramline-agent   │
   │ Docker, Caddy,  │                  │ Docker, Caddy,   │
   │ BuildKit, DNS   │                  │ DNS              │
   └─────────────────┘                  └──────────────────┘
```

Core principles:

1. **Desired state vs actual state.** The UI and API only change _desired state_ in the DB. The **reconciler** works out placement and sends each node its full desired state. The **agent** converges locally (pull images, start/stop containers, configure Caddy) and reports actual state back. This is the kubelet pattern: it survives disconnects, retries are idempotent, and there is one code path.
2. **Local Docker goes through the agent too.** The "local" node is just an agent on the same host, started alongside `pnpm dev`. Moving to multiple nodes in Phase 6 is then an install step, not a rewrite.
3. **Agents dial out** to the control plane. This works behind NAT and on home Proxmox, and nodes never need an inbound control port.
4. **One public API.** The UI, CLI and future Terraform provider all use `/api/v1`. That is why the resource layer sits on REST and not on SvelteKit remote functions.

### Repo layout (pnpm monorepo; the current scaffold moves into `apps/web`)

```
apps/web/            SvelteKit UI + /api/v1 + control-plane workers
  src/lib/server/db/           drizzle schema, migrations, client
  src/lib/server/domain/       projects, services, deployments, variables… (business logic)
  src/lib/server/reconciler/   scheduler + desired-state builder
  src/lib/server/queue/        SQLite job queue
  src/lib/server/agents/       WebSocket gateway, node registry
  src/lib/server/adapters/     adapter registry, account mgmt, node pool orchestration
  src/lib/server/pricing/      offer aggregation (from adapters) + placement
  src/lib/resources/           Svelte reactive resource layer (*.svelte.ts)
  src/lib/components/ui/       shadcn-svelte
  src/lib/components/canvas/   Svelte Flow nodes/edges/context menu
apps/agent/          node agent (Bun → single binary): docker, caddy, wireguard, dns
packages/contracts/  zod schemas: API DTOs + agent protocol messages (shared types)
packages/client/     typed apiClient + resource definitions (used by web + CLI)
packages/adapter-sdk/        ComputeAdapter interface, helpers, conformance test suite, fake adapter
packages/adapters/manual/    "any Linux box" (join script) — built in
packages/adapters/proxmox/   first real adapter
packages/adapters/hetzner|aws|gcp|azure/   later, same contract
```

### Resource model

Three layers, with one source of truth for types (`packages/contracts`):

```ts
// packages/client/src/resource.ts
export const defineResource =
	<T, C, U, Q = void>(path: string) =>
	(http: Http) => ({
		getAll: (query?: Q) => http.get<T[]>(path, query),
		get: (id: string) => http.get<T>(`${path}/${id}`),
		create: (input: C) => http.post<T>(path, input),
		update: (id: string, patch: U) => http.patch<T>(`${path}/${id}`, patch),
		remove: (id: string) => http.delete<void>(`${path}/${id}`)
	});

// packages/client/src/index.ts
export const createClient = (opts: { baseUrl: string; fetch?: typeof fetch; token?: string }) => {
	const http = createHttp(opts);
	return {
		projects: projects(http),
		services: { ...services(http), deploy: (id: string) => http.post(`/services/${id}/deploy`) },
		deployments: {
			...deployments(http),
			rollback: (id: string) => http.post(`/deployments/${id}/rollback`)
		},
		variables: variables(http) /* … */
	};
};
```

- **Svelte layer** (`apps/web/src/lib/resources/*.svelte.ts`): rune-based cached stores, e.g. `const svc = service(id)` returns `{ data, loading, error, update(patch) }`. They do optimistic updates and are invalidated by SSE events, so the canvas and panels update live during deploys.
- **SSR**: `+page.ts` loads call the same client with `event.fetch`.
- **Server**: `routes/api/v1/services/[id]/+server.ts` runs `Contract.parse(body)`, calls `domain.services.update(ctx, id, patch)` and returns the DTO. Route files stay thin; domain functions hold the authorization and logic.
- IDs use prefixed ULIDs (`prj_…`, `svc_…`, `dep_…`) so they are readable in logs and URLs.

### Compute adapters (Proxmox first)

Each place compute can come from is an **adapter**: a self-contained package that implements one contract. The control plane only talks to the contract, so the scheduler, pricing and UI never contain any provider-specific code.

```ts
// packages/adapter-sdk/src/index.ts
export interface ComputeAdapter<Creds = unknown> {
	meta: { id: 'proxmox' | 'hetzner' | string; name: string; icon: string };
	credentials: z.ZodType<Creds>; // drives the auto-generated "Connect account" form
	capabilities: { spot: boolean; arch: ('amd64' | 'arm64')[]; autoProvision: boolean };
	validate(creds: Creds): Promise<void>; // "Test connection" button
	listRegions(creds: Creds): Promise<Region[]>; // Proxmox: cluster nodes / zones
	listOffers(creds: Creds, region: string): Promise<Offer[]>; // sizes + $/hr → feeds pricing
	createNode(creds: Creds, spec: NodeSpec): Promise<ProviderNode>; // spec carries cloud-init + join token
	getNode(creds: Creds, id: string): Promise<ProviderNode | null>;
	listNodes(creds: Creds): Promise<ProviderNode[]>; // orphan/drift detection
	destroyNode(creds: Creds, id: string): Promise<void>;
}
```

- **The adapter only provisions a VM.** Everything after boot (Docker, agent, WireGuard, workloads) is identical everywhere because the agent enrolls itself. That keeps adapters small: Proxmox is roughly "clone cloud-init template → set cores/mem/disk → start".
- **`manual` is the built-in baseline adapter.** `createNode` returns an install command instead of calling an API, and the local Docker node is a `manual` node on localhost.
- **Pricing comes from adapters** (`listOffers`), so a new adapter automatically appears in cost comparisons. Proxmox offers are priced from a user-entered $/month for the host (or $0).
- **The conformance suite** in `adapter-sdk` (create → wait for enrollment → destroy → no orphans) runs against every adapter, and a `fake` adapter backs the unit tests. Community adapters (DigitalOcean, Vultr, OVH, Linode…) only need to pass it.
- The same pattern applies later to other integrations: **git** (GitHub first, then GitLab/Gitea), **DNS** (Cloudflare for automatic records) and **backup storage** (S3-compatible).

### Data model (Drizzle, SQLite)

- **Auth/tenancy**: better-auth tables + `organization` plugin (teams, members, roles) + API tokens.
- `project` (orgId, name) → `environment` (projectId, name; `production` created by default).
- `service` (projectId, name, icon, kind: `image|repo|database|empty`, canvas x/y).
- `service_instance`: per-environment config (source, build, deploy: start cmd, replicas, healthcheck, restart policy, cpu/mem limits, cron schedule; networking; placement pin). This matches Railway, where every service has config per environment.
- `variable` (scope: environment-shared or service_instance; key; **AES-256-GCM encrypted value**; sealed flag).
- `staged_change` (environmentId, target, JSON patch, author). Edits are staged, and "Deploy N changes" applies them, as in Railway.
- `deployment` (instanceId, status `queued|building|deploying|active|failed|crashed|removed`, immutable config + resolved-vars snapshot, imageRef, commit).
- `volume`, `domain` (generated|custom, port, cert status), `node` (adapterId, adapter account, region, capacity, status, wg key/IP, lastSeen), `adapter_account` (adapterId, encrypted credentials), `node_pool`, `price_offer`, `job`, `audit_log`, `git_installation`.

---

## Beyond the original brief

- **Staged changes + Deploy button**: a core part of Railway's UX, and a safety net.
- **Environments** (prod/staging, duplicate env) and later **PR preview environments**.
- **Reference variables** `${{Postgres.DATABASE_URL}}`, `${{shared.KEY}}`, plus Tramline-provided vars (`PORT`, `TRAMLINE_PRIVATE_DOMAIN`, `TRAMLINE_PUBLIC_DOMAIN`…). **Canvas edges are drawn from these references**, which is how Railway shows its connection lines.
- **Secrets encrypted at rest** (master key from `TRAMLINE_SECRET_KEY`) for env vars and cloud credentials.
- **Zero-downtime deploys** (start new → healthcheck → swap ingress → stop old), **rollback**, restart policies, replicas, **cron services**.
- **Builds via Railpack** (Railway's own open-source BuildKit builder) with Dockerfile auto-detection, plus an internal registry.
- **Control-plane backups**: SQLite is the brain, so add **Litestream** to S3-compatible storage.
- **Hetzner as the first public cloud.** It has the simplest API and the cheapest VMs, which makes it a good test of the provider abstraction before AWS, GCP and Azure.
- **"Bring any Linux box" node enrollment** (`curl … | sh` with a join token). This covers Proxmox VMs, VPSes and Raspberry Pis before any cloud API work.
- **Pricing caveats built into placement**: cross-cloud egress and latency are real costs. An environment defaults to one placement group (provider + region). Services with volumes are sticky. Spot instances are opt-in and only for stateless services.
- Audit log, RBAC, API tokens, deploy notifications (webhook/Discord/Slack), `tram` CLI, config-as-code (`tramline.json`), project templates, an install script/compose file for Tramline itself, CI, and a license choice (see the end).
- Swap `adapter-auto` for **`adapter-node`**: we need a long-lived process for the reconciler, queue, SSE and agent WebSockets.

---

## Secure by default

Security is a core reason for Tramline to exist, so every default should be the safe one, and anything less safe should be an explicit, visible opt-out. The checklist people apply by hand to a fresh VPS (key-only SSH, a non-root user, a closed firewall, fail2ban, everything in a repo behind Caddy, off-server backups) should simply be **what Tramline does** to every node it creates or enrolls.

**Already in place**

- Variable values and deployment snapshots are encrypted at rest (AES-256-GCM, key derived from `TRAMLINE_SECRET_KEY`), masked in the UI, and sent only to the node that runs the deployment.
- Agents dial out with per-node bearer tokens (stored hashed), so nodes need no inbound control port. An agent can only write logs for its own deployments.
- One isolated network per environment. Caddy's admin API is never exposed. Sign-in is rate limited, and org data is scoped in every query (with tests that check it).

**Nodes (VMs and Proxmox guests)**: a hardening baseline applied by cloud-init or the `manual` install script, reported back by the agent:

- **SSH:** key-only, no root login, no passwords. Tramline itself never needs SSH (the agent dials out), so by default port 22 is closed or limited to an admin IP, with an emergency "open SSH for 1 hour" switch in the UI.
- **Non-root:** a dedicated `tramline` system user runs the agent. Rootless Docker or `userns-remap` is offered where supported, because membership of the `docker` group is effectively root.
- **Firewall:** nftables default-deny inbound. Only 80/443 are open on ingress nodes, plus the WireGuard UDP port between nodes. Adapters also configure the provider firewall or security group (two layers).
- **Brute force:** fail2ban or sshguard whenever SSH is open. Unattended security upgrades, time sync, and minimal base images (Ubuntu LTS or Debian, Flatcar later).
- **Posture view:** each node shows a checklist (SSH, firewall, updates, Docker mode, disk encryption) with a score, and the control plane warns when a node drifts.

**Workloads**

- **Container defaults:** `no-new-privileges`, all capabilities dropped except a small allowlist, PID and memory limits, `/var/run/docker.sock` never mountable into user containers, and an optional read-only root filesystem.
- **Images:** tags resolved to a digest at deploy time and pinned in the snapshot, so a rollback really is the same image. A vulnerability scan (Trivy) runs before every new image runs, with warnings or optional blocking ✅ (Phase 3.5). SBOMs are stored (later).
- **Secrets:**
  - "Sealed" variables (write-only, never shown again after saving).
  - Known secret values redacted from deployment logs.
  - Envelope encryption: a key per environment, wrapped by the master key, so the master key can be rotated without redeploying.
  - Secrets optionally mounted as tmpfs files instead of env vars.
  - Build secrets passed as BuildKit secret mounts, never as `ARG`.
  - External secret stores later (1Password, Vault, AWS or GCP Secrets Manager).

**Control plane and account security**

- 2FA and passkeys (better-auth plugins), scoped and expiring API tokens, an audit log (including who revealed a secret), and RBAC.
- Security headers and CSP on by default; HSTS on generated domains.
- Agent ↔ control plane over TLS. mTLS and token rotation arrive with remote nodes.
- Signed agent binaries and a checksum-verified install script.

**Recoverability (the "no backup is a gamble" rule)**

- Litestream streams the control-plane SQLite database to S3-compatible storage.
- Scheduled database and volume backups go **off the node**, with restore drills run in CI.
- Config-as-code and project export, so an install can be rebuilt from a repo plus a backup.

**CI supply chain:** CodeQL, `pnpm audit`, gitleaks secret scanning, Dependabot or Renovate, and pinned GitHub Actions.

**No long-lived credentials: Tramline as an OIDC identity provider**

The best secret is one that doesn't exist. Rather than pasting AWS, GCP or Azure keys into variables, a deployment proves _who it is_, and the cloud hands it short-lived credentials. GitHub Actions and Vercel already do this, and Tramline is well placed to do it too, because it already knows exactly which org, project, environment, service and deployment every container belongs to.

- **Issuer:** each install is an OIDC issuer. It serves `/.well-known/openid-configuration` and a JWKS with rotating signing keys, held encrypted like other secrets.
- **Per-deployment tokens:** the agent mounts a signed JWT into each container as a tmpfs file and refreshes it before it expires (around 1 hour, never stored at rest). It works like a Kubernetes projected service-account token.
  - Claims: `sub=org:acme:project:shop:environment:production:service:api`, plus the deployment ID, node and audience.
  - The audience is configurable per service: `sts.amazonaws.com`, a GCP pool, or `api://AzureADTokenExchange`.
- **No SDK changes:** Tramline sets the standard environment variables the official cloud SDKs already read:
  - **AWS:** `AWS_ROLE_ARN` + `AWS_WEB_IDENTITY_TOKEN_FILE`
  - **GCP:** a generated external-account `GOOGLE_APPLICATION_CREDENTIALS` file
  - **Azure:** `AZURE_FEDERATED_TOKEN_FILE` + client and tenant IDs
  - **HashiCorp Vault:** JWT auth

  You configure a trust policy once in the cloud, matching on `sub` (for example "only production of `shop/api`"), and then there are no keys to paste, rotate or leak.

- **The canvas:** a service gets a "Cloud identity" setting with a role per provider and a copyable trust-policy snippet. Tramline can't recover a deployment's credentials afterwards, because the cloud mints them per request.
- **Constraint (self-hosting):** the cloud must be able to fetch the issuer's discovery document over public HTTPS. Installs on a private network (behind Proxmox or a LAN) can publish just the discovery document and JWKS to a public bucket or static site. Tramline automates that upload, and only public keys leave the network.
- **The other direction:**
  - CI deploys to Tramline using **GitHub Actions' OIDC token** under a trust policy (repo, branch, environment), so CI holds no Tramline API token.
  - Agents on cloud nodes can authenticate with the cloud's instance identity instead of a static join token.
  - Compute adapters use workload-identity federation for provider APIs wherever Tramline itself runs in that cloud.
- **What remains secret:** services that only accept static keys (many SaaS APIs) still need them. Those stay sealed, redacted and envelope-encrypted, and an optional external store (1Password, Vault) fetches them at deploy time so they never sit in Tramline at all. Credentials Tramline generates itself (for example database passwords) never need to be seen by a person.

**Where it lands**

- **Phase 2.5 ✅:**
  - Container defaults: `no-new-privileges`, capabilities trimmed to an allowlist (no `NET_RAW` or `MKNOD`), a PID limit, optional memory limit and read-only root, no host mounts. The ingress keeps only `NET_BIND_SERVICE`.
  - Sealed variables: write-only, can be replaced or restored but never revealed, and not visible in the raw editor or the API.
  - Log redaction of sealed and secret-looking values and URL passwords.
  - Nonce-based CSP plus `nosniff`, `X-Frame-Options`, a referrer policy, a permissions policy, and HSTS over HTTPS. HSTS is also set on HTTPS ingress routes, and every e2e test fails on a CSP violation.
  - CI security: CodeQL (security-extended), gitleaks, `pnpm audit` (high and above), Dependabot, and least-privilege workflow permissions.
  - `SECURITY.md`.
  - Found and fixed while verifying on a real Docker host:
    - Agents only ever touch containers labelled with their own node ID, and each node has its own ingress, so a misconfigured or second agent can't remove another install's services.
    - Old containers drain for 10s after the route moves. A swap was measured at 334 out of 334 requests answered with 200.
    - Routes are dropped when the last deployment goes.
    - The deploy timeout counts from scheduling, not from queueing.
    - A rejected agent token now backs off and re-reads the token file instead of stopping the agent.
    - Deploy waits for in-flight edits, and forms can't submit before the page has hydrated.
- **Phase 3 ✅:** BuildKit secret mounts, image digest pinning, a rootless builder, and pinned and verified build tools.
  - GitHub: a private, read-only app (`contents` and `metadata` only) whose private key and webhook secret are encrypted at rest. Installation tokens last an hour, are cached in memory only and are handed to the builder through git's environment, never in a URL.
  - Webhooks are HMAC-verified in constant time; the manifest, install and setup redirects are bound to a state cookie; installations are verified with GitHub before they're connected and never shared across organizations.
- **Phase 3.5 ✅:** image vulnerability scanning with Trivy, warning by default or blocking fixable critical findings, on built and registry images alike.
- **Phase 4:** off-site backups and Litestream (moved forward from Phase 9), plus restore drills.
- **Phase 5 ✅:** token scopes and the audit log (5a); 2FA, passkeys and **GitHub Actions OIDC for deploying to Tramline** with no CI secrets (5b).
- **Phase 5.5 (workload identity):** Tramline as an OIDC issuer (discovery, JWKS and key rotation), per-deployment tokens mounted and refreshed by the agent, AWS, GCP, Azure and Vault federation with trust-policy snippets on the canvas, and publishing the JWKS for private installs. Tested end to end against real AWS STS in a scheduled CI job.
- **Phase 6:** node hardening baseline, `tramline` user, firewall, fail2ban, WireGuard-only node traffic, mTLS agents, posture view, and the database TCP proxy (opt-in, TLS enforced by the database, IP allowlist in the host firewall).
- **Phase 7:** provider firewalls and security groups, no public SSH by default on cloud nodes.

## Phases

Each phase ends with a demoable result. Phases 0–2 are the MVP spine.

### Phase 0: Foundations ✅

- `git init`, move the scaffold into `apps/web`, set up the pnpm workspace with `packages/contracts` and `packages/client`, and add CI (lint, check, test).
- Install: `drizzle-orm`, `drizzle-kit`, `better-sqlite3`, `better-auth`, `zod`, `ulid`, `@sveltejs/adapter-node`, `shadcn-svelte` (bits-ui, tailwind-variants, tailwind-merge, `@lucide/svelte`), `mode-watcher` (dark-first, Railway style), `svelte-sonner`, `@xyflow/svelte` (**Svelte Flow**, the library you were thinking of).
- Drizzle setup (WAL, migrations), better-auth with email/password + GitHub OAuth + organization plugin, and auth guard in `hooks.server.ts`.
- `createHttp`, `defineResource`, the API error envelope and auth context, plus the first resource (`projects`) end to end as the reference pattern.
- App shell: sign-in, org switcher, projects dashboard, theme.
- **Exit:** sign up → create org → create/list/rename/delete projects through the resource layer, with unit tests for the client and domain.

### Phase 1: Canvas and configuration (no infrastructure yet) ✅

- Project page = full-screen Svelte Flow canvas: pan/zoom, minimap, dot grid, positions saved (debounced `services.update`).
- **Right-click context menu** + `⌘K` palette: _GitHub Repo · Docker Image · Database (Postgres/MySQL/Redis/Mongo) · Empty Service_. Custom service node: icon, name, status pill, domain, volume badge.
- **Service side panel** (Sheet) with tabs: **Deployments · Variables · Metrics · Settings** (Source, Build, Deploy, Networking, Volumes, Danger zone).
- Variables editor: table + raw `.env` mode, shared variables, reference autocomplete, edges drawn from references, cycle detection.
- Environment switcher; **staged changes** banner with diff view and "Deploy".
- SSE event bus `/api/v1/events?projectId=` wired into resource-cache invalidation.
- **Exit:** the whole Railway experience works in "design mode". Deploy creates a `queued` deployment record. Playwright covers right-click → add → configure → stage → deploy.

### Phase 2: Agent and local Docker deploys (image services) ✅ (real-Docker e2e runs in CI)

- **Agent protocol** (`packages/contracts/src/agent.ts`): `hello`, the node's full desired state, an actual-state report, and log batches.
  - **Transport:** HTTPS with long-polling rather than WebSockets. The agent still dials out (so NAT is fine), it works through any proxy, and every exchange is idempotent. WebSockets can come later for interactive `exec`.
- **`apps/agent`:**
  - Uses dockerode, behind a `ContainerRuntime` interface so it can be tested with a fake.
  - Runs three loops: a sync loop (long-poll, then converge), a report loop (observe, health-check, report, and re-converge periodically to repair drift), and a log shipper.
  - Detects Docker outages and reports them.
- **Ingress:** a `tramline-ingress` Caddy container. The agent pushes its routes into the container and loads them with `caddy reload`, so Caddy's admin API never leaves the container and no host files are shared with it. (It first used a bind-mounted file with `--watch`; Caddy could read a half-written file and some file-sharing layers served it a stale copy, so new routes intermittently never went live.) It joins every environment network, which lets it run healthchecks too.
- **Control plane:**
  - Registry for the built-in `local` node; its token is written to `data/local-agent.token`.
  - A deterministic desired-state builder with a revision hash.
  - A **reconciler** state machine (queued → deploying → active ⇄ crashed, or → failed), with stability and healthcheck gates, startup crash-loop detection and a 10-minute timeout.
  - Zero-downtime swaps: public routes point at a per-deployment alias, and the old deployment is removed only once the new one is live.
  - Redeploy, rollback and remove.
- **Networking v1:**
  - One Docker network per environment, with `<service>.<env>.tramline.internal` aliases.
  - A stable generated domain `<svc>-<hex>.<baseDomain>`, also exposed as `TRAMLINE_PUBLIC_DOMAIN`. `localhost` serves plain HTTP; real domains get automatic HTTPS.
- **UI:** deployments tab with live status messages, SSE-streamed logs, redeploy/rollback/remove buttons, the URL on the node and in the panel, and a node status indicator.
- **Deferred:** the SQLite job queue moves to Phase 3, where builds need it. Cron services move to Phase 4.
- **Exit:** `e2e/deploy.e2e.ts` (run with `TRAMLINE_E2E_DOCKER=1`): deploy `traefik/whoami` with a healthcheck, reach it through the ingress, see its logs, remove it, and get a 404.

### Phase 3: Builds from source

**3a: build pipeline ✅** (verified end to end on Docker, e2e in CI)

- **Builder:** one **rootless BuildKit** container per node (`tramline-builder-<node>`), never `--privileged`. It runs as uid 1000 with a persistent cache volume.
  - The trade-off: its user namespace needs Docker's seccomp and AppArmor profiles relaxed, and it keeps Docker's default capabilities.
  - It is separate from workloads, which keep the hardened defaults.
- **Pipeline:** shallow clone of a branch or exact commit → **Railpack** (`prepare` + its BuildKit frontend), or a Dockerfile when one is present or chosen → image streamed straight into the node's Docker → deploy.
  - The root directory can't escape the repository.
  - Build output streams live into the deployment log as its own stream, with secrets redacted.
- **Supply chain:** the Railpack CLI is downloaded from the official release and checked against a pinned sha256. The Railpack frontend and BuildKit images are pinned by digest (`apps/agent/src/pins.ts`).
- **Build secrets:** every service variable is a **BuildKit secret**, passed only in the build process's environment. Verified with a canary on a real build: absent from the image's environment, its layer history, its raw bytes and the build log, yet available at runtime.
- **Reconciler:** `queued → building → deploying`, with a 30-minute build timeout. The image ID and commit are recorded, and the commit shows in the UI.
  - **Redeploy and rollback reuse the built image** (no clone, no rebuild).
  - Image deployments **pin the digest they first pulled**, so a rollback runs exactly that image.
- **Housekeeping:** the newest 3 built images per service are kept and older ones removed.
- **Deferred:** the internal registry moves to Phase 6, since images load directly into the node's Docker until there are several nodes. The job queue turned out to be unnecessary: builds are driven by desired state like everything else.
- **Found while verifying on real Docker:**
  - dockerode's `followProgress` ignores `{"error": …}` lines, so failed pulls and loads looked successful. These now fail properly.
  - Ending the image stream early truncated large images under backpressure.

**3b: GitHub ✅** (verified against the real GitHub API; signed-push e2e in CI)

- **GitHub App in one click** via GitHub's manifest flow, from **Settings → GitHub**, on a personal account or a GitHub organization. Only owners and admins can connect it.
  - Read-only `contents` and `metadata` permissions. Push webhooks are requested only when `TRAMLINE_URL` is https and reachable from the internet.
  - Credentials are encrypted at rest. Installations are checked with GitHub before they're connected to an organization.
- **Repo picker** in the source dialog, listing every repository the organization's installations can read; picking one fills in the URL and default branch.
- **Private repos** clone with 1-hour installation tokens, attached to each build when the agent fetches its desired state and never stored. Services added by URL before the app was connected use the organization's installation on the repository's owner.
- **Auto-deploy:** a "Deploy on push" switch per service (on by default).
  - **Webhooks:** signed `push` events deploy the pushed commit to every matching service and branch, skipping deletions, tags and commits already deployed. With a root directory set, only pushes that touch it deploy.
  - **Polling** when GitHub can't reach the install: every `TRAMLINE_GIT_POLL_SECONDS` (5× slower when webhooks work, as a safety net), using ETags so unchanged branches cost nothing. Public repositories without the app are checked every 5 minutes to stay inside GitHub's anonymous rate limit.
  - Auto-deploys use the applied configuration and variables; staged edits stay staged.
- The deployment log follows the newest deployment, so a push's build log appears without a click.
- **Deferred:** watch paths beyond the root directory move to Phase 4 alongside config-as-code.
- **Exit:** `e2e/github.e2e.ts`: create the app through the manifest flow (GitHub stubbed), then a signed push webhook deploys the pushed commit.

### Phase 3.5: Image vulnerability scanning ✅ (verified on Docker; e2e in CI)

- **Trivy in the builder:** the pinned Trivy CLI (checksum-verified, like Railpack) runs inside each node's rootless builder, never with the Docker socket. Its vulnerability database is cached on the builder's volume.
- **Before anything runs:**
  - **Built images** are written to a tarball, scanned, and only then loaded into Docker, so a refused image never reaches it.
  - **Registry images** get a short "Scanning image" stage: the agent pulls the image, Trivy scans that exact digest from the registry, and the deployment runs by that digest (which also pins it for rollbacks).
  - **Redeploys and rollbacks** of an image that already ran reuse it and its scan.
- **Policy per service** (Settings → Security → Vulnerability scan):
  - `warn` (the default): findings are shown and the image deploys.
  - `block`: images with **critical vulnerabilities that have a fix** are refused, and so are images that could not be scanned. Unfixable criticals are shown but don't block, since there is nothing to upgrade to.
  - `off`: no scan.
- **Results:** counts per severity and the 50 most severe findings are stored on the deployment, shown as a summary line and a findings table with links to each advisory, and the full scan output is in the build log.
- **Exit:** `e2e/scan.e2e.ts`: block mode refuses `alpine:3.12.0` (fixable critical vulnerabilities) before it runs; `e2e/deploy.e2e.ts` and `e2e/build.e2e.ts` scan in warn mode and deploy.
- **Deferred:**
  - SBOMs.
  - Rescanning running deployments when new vulnerabilities are published.
  - Private registry credentials, which image services don't support yet.
  - The first scan on a node downloads Trivy's vulnerability database (about 1.5 minutes on the connection it was tested on), and Trivy refreshes it daily, so some scans take longer.

### Phase 4: Data, variables and networking depth

Database templates with generated credentials and connection variables, `${{Service.KEY}}` references with canvas edges, and resolution snapshotted at deploy time already landed in Phase 1. Phase 4 is split in three.

**4a: volumes ✅** (verified on Docker; e2e in CI)

- **One volume per service and environment**, set as a mount path in Settings → Volume (Railway's model). It is a named Docker volume created by the agent and labelled with its node. The path is exposed to the service as `TRAMLINE_VOLUME_MOUNT_PATH`.
- **Database templates come with one:** Postgres (`/var/lib/postgresql/data`), MySQL (`/var/lib/mysql`), Redis (`/data`, now append-only) and MongoDB (`/data/db`).
- **Recreate, not swap:** two containers must never share a data directory. For a service with a volume:
  - The old deployment stops first ("Stopping for dep_…"), and the new one waits until the agent reports the old container gone.
  - That means a few seconds of downtime per deploy, as on Railway. If the new deployment fails, the old one runs again.
  - Such a service runs a single replica.
- **Clean shutdown:** workloads are stopped with SIGTERM before removal, with 30s for services with a volume (10s otherwise), so databases flush to disk.
- **Sticky placement:** the volume is pinned to the node the service first ran on, and later deployments wait for that node.
- **Lifecycle:** detaching a volume (clearing the mount path) keeps its data for later. Deleting the service or environment deletes the volume: the agent removes it once no container uses it, and the control plane forgets it when the node stops reporting it.
- **Exit:** `e2e/data.e2e.ts`: PostgREST connects to Postgres through `${{Postgres.DATABASE_URL}}` over the private network; Postgres is redeployed, finds its existing data ("Skipping initialization"), and PostgREST reconnects.
- **Deferred:** volume size limits and usage (Docker's local volumes don't enforce a size); volumes for non-root images whose mount path doesn't exist in the image (Docker creates it owned by root).

**4b: backups ✅** (verified on Docker against an S3 gateway; e2e in CI)

- **Storage per organization:** any S3-compatible bucket, set in Settings → Backups by owners and admins, with a "Test connection" that writes and deletes an object. The secret key is encrypted at rest and never returned.
- **Credentials stay on the control plane:** for each job it signs a short-lived URL (AWS SigV4 presigning, checked against AWS's published example and against a real S3 server) that allows exactly one upload or download. Nodes never hold bucket credentials.
- **What a backup contains:**
  - Postgres, MySQL and MongoDB templates: a consistent native dump (`pg_dumpall`, `mysqldump --single-transaction`, `mongodump`), taken inside the running database container with credentials from its own environment, with no downtime.
  - Any other volume (including Redis, whose append-only files are the reliable copy): a `tar` archive made by a locked-down helper container (pinned busybox, no network, the volume mounted read-only, one capability). It is crash-consistent: taken while the service runs.
- **Encryption on the node:** every backup is gzip-compressed and encrypted with AES-256-GCM using a random per-backup key. The key is stored wrapped with the install's secret key, so the bucket provider never sees plaintext; restoring needs this install or its `TRAMLINE_SECRET_KEY`.
- **Restore:**
  - From the service's Backups tab, after a confirmation.
  - The backup must decrypt and authenticate completely before anything is applied.
  - Native dumps load into the running database. Postgres drops databases `WITH (FORCE)`, so connected apps can't make the restore load on top of the old data.
  - Volume archives replace the volume while the service's containers are held stopped, and the containers start again afterwards.
- **Schedules:** daily or weekly per volume, applied at once (no deploy), keeping the newest N scheduled backups and deleting older objects from the bucket. Jobs that don't finish within 6 hours are failed.
- **Exit:** `e2e/backups.e2e.ts`:
  - Postgres: a row is written, backed up, changed and restored; only the original row is back, and the object in the bucket is encrypted.
  - A plain Redis volume: the same round trip while the service is stopped and started again.
- **Restore drills:** proof that a backup can be restored, without touching the service. A drill runs weekly against each scheduled volume's newest backup, or on demand with "Verify".
  - Every backup must decrypt, authenticate and decompress completely.
  - Postgres dumps are loaded into a throwaway Postgres of the same image (no network), and the databases and tables that arrive are counted.
  - MySQL and MongoDB dumps are checked for their format.
  - Volume archives are read back to the end.
  - The result shows on the backup, e.g. "Verified 2 days ago: Loaded 1 database with 3 tables".
- **The control plane's own database:** `TRAMLINE_BACKUP_S3_*` points it at an install-wide bucket.
  - **Snapshots:** every `TRAMLINE_BACKUP_INTERVAL_MINUTES` (default 60) the database is snapshotted with `VACUUM INTO` (a consistent copy while it is in use), then gzip-compressed and encrypted. The encryption key is derived from `TRAMLINE_SECRET_KEY`, which is needed anyway since the database's secrets are encrypted with it. The newest `TRAMLINE_BACKUP_KEEP` (default 72) are kept.
  - **Drills:** a daily drill fetches the newest snapshot and runs SQLite's integrity check on it.
  - **Status:** both show in Settings → Backups.
  - **Restore:** `pnpm --filter @tramline/web restore-control-plane` lists snapshots (`--list`), runs a drill (`--check`), or restores while Tramline is stopped (`--yes`, keeping the current database beside it).
  - **Why snapshots rather than Litestream:** they run in-process with no sidecar, and are encrypted before upload like every other backup. The trade-off is losing up to one interval (an hour by default) rather than seconds. Litestream can still come with the installer in Phase 9.
- **Deferred:** single uploads are capped at 5 GB (S3's limit for one PUT; multipart comes later); backups of databases in images other than the templates are archives, not dumps.

**4c: networking and environments ✅** (the TCP proxy moves to Phase 6)

- **Custom domains**, in a service's Networking settings:
  - **Ownership is proven before any traffic is routed:** a `_tramline.<domain>` TXT record must hold the domain's token. Tramline checks on demand and every few minutes for a week, and the UI shows the TXT and CNAME records to create.
  - **No hijacking:** hostnames are unique across the install, names under the generated base domain and Tramline's own address are refused, and on a local `localhost` install no existing generated name can be claimed.
  - **Serving:** once verified, the domain routes to the live deployment straight away and Caddy obtains its certificate. Its HSTS header covers that host only, never the domain's other subdomains (generated domains keep `includeSubDomains`).
  - **Local development:** `.localhost` names need no proof.
- **Duplicate an environment:** "Start from: a copy of …" brings every service's config and variables (sealed ones stay sealed) and the shared variables.
  - Database services always get **new credentials**, so environments never share a password. This now applies to plain new environments too, which previously had none.
  - Volumes, custom domains and generated domains are not copied.
- **Cron services** (deferred from Phase 2): with a cron schedule (five fields or `@daily`-style, in UTC), a deployment goes live with no long-running container.
  - At each due minute the control plane starts a one-off run container (`restart: never`) and records its exit code.
  - A slot that comes round while a run is still going is skipped; slots missed during downtime collapse into one run; a run is failed after 24 hours.
  - The deployment shows the next run, recent runs and **Run now**. Output goes to the deployment log, including for runs that finish between two agent passes.
  - Invalid schedules are refused at deploy.
- **Watch paths** (deferred from Phase 3b): gitignore-style patterns in Build settings.
  - A push or poll deploys only if a changed file matches, in addition to the root directory.
  - `**` crosses directories, a pattern without `/` matches at any depth, and `!` excludes, with the last match deciding.
- **Postgres data browser:** a read-only "Data" tab on Postgres services lists tables and pages through rows, 50 at a time.
  - **How it runs:** the control plane builds the SQL and hands it to the node as a query job. It travels in memory only, alongside the desired state, and is never stored. The agent runs it with `psql` inside the database container, with the SQL passed in the environment.
  - **Safety:** every query is a `READ ONLY` transaction with a 5 s statement timeout. Table names must match the database's own list and are quoted, and long values are cut short.
- **TCP proxy → Phase 6:** the agreed design is TLS enforced by the database itself (Postgres and MySQL negotiate TLS inside their protocols, so a TLS-terminating proxy doesn't work with standard clients), plus an IP allowlist. Building that properly needs two things Tramline doesn't have yet: a fixed source address for proxied connections, so the database can require TLS from them without breaking internal apps; and a host firewall that sees real client IPs (Docker's port publishing can rewrite them). Both arrive with Phase 6's node hardening.

- **Exit:** add Postgres + an app that references `${{Postgres.DATABASE_URL}}`. The edge appears, the app connects over private networking, and data survives a redeploy. ✅ (4a)

### Phase 5: Agent access: API tokens + MCP server

**5a: API tokens, audit log and the MCP server ✅** (e2e in CI)

- **API tokens**, in Settings → API tokens:
  - **Format:** `tl_` plus 32 random bytes, shown once and stored only as a SHA-256 hash.
  - **Expiry:** 30 days, 90 days, a year, or never.
  - **Who it acts as:** the member who created it, in their organization. It stops working if they leave.
  - **Scopes:** `read` (every GET), `write` (stage changes) and `deploy` (deploy, redeploy, remove, run, restore and delete backups). Write and deploy each include read, so a token without `deploy` can only stage.
  - **Session only:** tokens can't create or list tokens, read the audit log, or touch backup storage or the GitHub app.
  - **Visibility:** members see and revoke their own tokens; owners and admins see and revoke everyone's.
- **Audit log:** every change through the API (any non-GET), by a person or a token, is recorded with the route, its parameters and the result. Owners and admins read it in Settings; events are kept for 90 days.
- **`packages/mcp`:** an MCP server (SDK 1.32.1) built only on `packages/client`, so an agent can do exactly what its token allows and never touches the database.
  - **Transports:** stdio (`TRAMLINE_URL=… TRAMLINE_TOKEN=… pnpm --filter @tramline/mcp start`), and stateless Streamable HTTP served by Tramline at `/mcp` with the token as a bearer.
  - **Tools:** `list_projects`, `list_environments`, `create_environment` (with `copyFrom`), `get_canvas`, `create_service` (image, repo or database), `update_service_config`, `set_variables`, `get_staged_changes`, `deploy`, `discard_changes`, `list_deployments` and `get_deployment_logs`.
    - `deploy` and `discard_changes` carry `destructiveHint`; reads carry `readOnlyHint`.
    - API errors (e.g. a missing scope) come back as tool errors the model can act on.
  - **Resources:** `tramline://environment/{id}/canvas` and `tramline://deployment/{id}/logs`.
  - **Prompt:** `deploy_repo_with_postgres`.
  - **Also new:** deployment logs have a JSON mode (`?format=json&tail=N`) for agents.
- **Exit:**
  - `e2e/mcp.e2e.ts`: a person creates a token in Settings. An MCP client over HTTP adds Postgres and an app, wires `DATABASE_URL` (the edge appears), reviews the staged changes, deploys and reads the logs, and the audit log shows it was the token.
  - Over stdio, a token without `deploy` stages a service but is refused the deploy.
  - Connecting Claude Code: `claude mcp add tramline --transport http https://<tramline>/mcp --header "Authorization: Bearer tl_…"`.

**5b: GitHub Actions OIDC, 2FA and passkeys ✅** (e2e in CI)

- **GitHub Actions OIDC** (no CI secrets), in Settings → GitHub Actions, for owners and admins.
  - **Trust rules:** trust a repository, optionally limited to a ref pattern (`refs/heads/main`, `refs/tags/v*`) and a GitHub deployment environment, with chosen scopes.
  - **The exchange:** a workflow posts its OIDC token, requested with this install's URL as the audience, to `POST /api/v1/oidc/github`.
  - **Verification:** RS256 only (no `none`, no HMAC), against GitHub's published keys, which are refetched when an unknown key appears. Tramline checks the issuer, audience, expiry and not-before, and that the repository, ref and environment match a rule.
  - **Renamed or re-created repos:** the rule pins the repository's numeric ID on first use.
  - **What the workflow gets:** a 15-minute API token with the rule's scopes, acting as the member who created the rule. Each exchange is audited, and expired tokens are cleaned up.
  - **New endpoint:** `POST /api/v1/services/:id/deploy { environmentId, commit? }` deploys a service as it is deployed now, at the exact commit CI tested.
  - **Example:** the Settings card shows a ready-made workflow step.
- **Two-factor authentication:** TOTP with backup codes, via better-auth's plugin, from Settings → Your account's security.
  - Enrolment shows a QR code (rendered as SVG, never injected markup) and the key, confirms a code, then shows the backup codes once.
  - Sign-in asks for a code, or a backup code, after the password.
- **Passkeys:** WebAuthn credentials tied to this install's hostname, via better-auth's passkey plugin. Add and remove them in Settings, and "Sign in with a passkey" needs no password.
- **Exit:** `e2e/security.e2e.ts`:
  - **2FA:** enrol with real TOTP codes, sign in with a code and with a backup code, and a wrong code is refused.
  - **Passkeys:** add one with Chromium's virtual authenticator, then sign in with it alone.
  - **GitHub Actions:** trust a repository in the UI, and the exchange refuses unsigned tokens.
  - Signature, claim, rule and pinning checks are unit-tested against a real RSA key.

**Later in Phase 5**

- OAuth for `/mcp`, so agents can sign in without pasting a token.
- Requiring 2FA for an organization.
- Tools for nodes and prices (`list_nodes`, `add_node`, `compare_prices`) arrive with Phases 6 to 8.

### Phase 6: Multi-node + adapter SDK + Proxmox adapter

Phase 6 is split in three: nodes and scheduling (6a), the mesh (6b), then adapters and Proxmox (6c).

**6a: nodes ✅** (verified on Docker with a second, Docker-in-Docker node; e2e in CI)

- **Enrollment:** an install admin creates a one-time **join token** under Nodes → Add node, optionally starting the node cordoned. The command it shows (`curl … /install.sh | sudo sh -s -- --url … --token …`) checks Docker and runs the agent as a container. The agent trades the join token for its own node token, saved with mode 600. Join tokens are stored as hashes, expire after an hour and work once.
- **The agent container** has no capabilities, no privilege escalation, a read-only filesystem and a PID limit. It still holds the Docker socket, so it is as powerful as root on the node, which is why nodes are managed only by install admins and never by API tokens. (Admins became an explicit grant in the hardening pass below.) The image is built for amd64 and arm64 and published to GHCR with signed build provenance.
- **Scheduling:**
  - **Hard rules:** a service with a volume runs where its data is; a service pinned to a node (Settings → Run on) runs only there; cordoned nodes take nothing else; a memory limit needs that much room.
  - **Preferences:** the node that built the image (anywhere else rebuilds the same commit), then the node already running the environment (its services share one Docker network until the mesh lands), then the least loaded node.
- **Nodes page:** status, CPUs, memory reserved by limits, deployment count, and Cordon, Drain and Remove. **Drain** cordons the node and redeploys its stateless deployments elsewhere with no downtime. Services with data or a pin stay, and the drain says which. **Remove** refuses while anything runs there or keeps its data there, and revokes the node token.
- **Still to come:** CPU requests, metrics and node hardening checks. (Cross-node networking and edge nodes arrived in 6b; the scheduler still prefers to keep an environment together, which saves a hop.)

**6b: mesh ✅** (verified on Docker with a Docker-in-Docker node; e2e in CI)

- **WireGuard between nodes:**
  - **Keys:** each agent creates its own key pair. The private key stays on the node, and the control plane only sees public keys and hands out addresses in `10.231.0.0/16`.
  - **The mesh container:** it holds the tunnel in its own network namespace, with `NET_ADMIN` and no other capability. Nothing on the host changes: no routes, no firewall rules, no IP forwarding.
  - **Reaching a node:** a node with an endpoint (`--endpoint host:port` in the install command, or set on the Nodes page) is reached directly. Nodes behind NAT connect out to it, and two NATed nodes reach each other through it as a relay. The Nodes page says when a pair has no way through.
- **Private names across nodes, one TCP port at a time:**
  - **Links:** a tiny socat container on the consumer's node answers to the remote service's private name (e.g. `postgres.production.tramline.internal`) on that environment's network only. It forwards to the mesh container, which carries the connection to the service's node.
  - **Isolation:** environments stay isolated as they are on one node, and only a service's declared port crosses nodes.
  - **Ports:** each service gets the same mesh port everywhere, from a hash, so adding one never moves another.
- **Edge nodes:** an edge serves every public domain, forwarding over the mesh to the node a service runs on. The local node is an edge by default. Other nodes serve their own services' domains as before.
- **Isolation of failures:** if the mesh can't start, a node still runs its services and serves its routes.

**6b.2: TCP proxy ✅** (unit-tested; e2e in CI)

- **Live deployments only:** traffic from other nodes (links and edge routes) goes to a service's live deployment, so it moves only once a new deployment passes its healthcheck.
- **The TCP proxy for Postgres** (Settings → Networking):
  - **Off by default:** it opens only when switched on with an allowlist of addresses (`0.0.0.0/0` has to be written out).
  - **Ports:** each proxied database gets its own edge port from 30000, kept across deploys. Every edge node publishes it through a small locked-down container (no capabilities, read-only filesystem).
  - **TLS only:** addresses outside the allowlist are dropped before anything is read. A client's first message must ask for TLS, and the database must agree to it, so a plaintext session can't start. TLS ends in Postgres itself; the proxy never holds a key.
  - **The certificate:** Postgres gets a TLS certificate the agent creates on its node (ECDSA P-256, ten years, kept across deploys; the key never leaves the node). It comes with the proxy, so it starts on a deploy, never by surprise on an upgrade. Clients use `sslmode=require`.
- **Later:** MySQL, Redis and MongoDB through the proxy; `verify-full` with a downloadable certificate; TLS for connections inside an environment too.
- **Moved to Phase 7:** spreading a service's replicas across nodes, which belongs with CPU and memory requests and node pools.

### Hardening: the 2026-10-26 review

An outside review found 11 issues (1 critical, 7 high, 3 medium). They are fixed before 6c starts.

**Hardening 1 ✅** (unit-tested; e2e in CI)

- **R1 (critical), GitHub installations:**
  - **Ownership:** an installation ID only counts for the organization that connected it, checked when a source is set and again before any token is issued.
  - **Tokens:** they're restricted to the one repository a build needs, and go only to `https://github.com`. The agent also refuses to send one anywhere else.
- **R2, destructive operations:** deleting anything that runs (services, environments, projects, domains, backups) needs the `deploy` scope; `write` only stages and discards changes.
- **R3, install admins:** an explicit, stored grant. The first is claimed with a one-time setup token the server writes to its data directory; later ones are granted by an admin. Email addresses no longer grant anything, since Tramline doesn't verify them.
- **R5, node reports:** an agent's container and build reports count only for deployments assigned to its node. (A deployment's node never changes once scheduled, so no assignment generation is needed.)
- **R6, backups:**
  - Dumps and loads fail when any part of the pipeline fails (these images' `sh` has no `pipefail`), and Postgres restores and drills stop at the first SQL error.
  - Drills check their own verification queries.
  - Retention keeps the newest N _successful_ backups, and trims failures separately.
- **R7, sealed values:** deploys track which values came from a sealed variable through any chain of references, and record it on the deployment. Log masking uses that record plus today's seals, so a sealed value copied under another name is masked, old snapshots stay protected after a seal goes, and a new seal applies at once.
- **R8, logs:**
  - **Agent:** a byte-budgeted queue (the oldest lines are dropped first, with a note saying how many) and a line-size cap.
  - **Containers:** Docker log rotation on every container the agent runs.
  - **Control plane:** log files rotate at 10 MB, tails are read from the end of the file, and logs are deleted after 30 days.
- **R9, failed starts:** a container that fails to start is retried with backoff (10 seconds, doubling to 5 minutes), and at once when its spec changes.
- **R11, referenced values:** a deploy redeploys every service whose resolved variables changed (through another service's variable, a shared one, a chain of references, or a built-in), and the changes summary lists those services.
- **Also:**
  - The service panel and the variables editor ignore responses for a service or environment no longer shown.
  - Comments and `SECURITY.md` now match tested behaviour and state their trust assumptions: masking stops accidental disclosure only, builds share a builder, and there must be one control-plane process.

**Hardening 2 ✅** (unit-tested; e2e in CI)

- **R4, build isolation:**
  - **A builder per job:** every build and registry-image scan runs in a fresh rootless BuildKit container of its own, removed afterwards. BuildKit's process sandbox is on (with `/proc` unmasked, BuildKit's documented way to run rootless with it), so build steps run in containers of their own and can't see the builder, its tools or another job.
  - **Caches:** BuildKit's cache is a volume per organization; registry scans, which run no user code, share one.
  - **Tools:** Railpack, Trivy and Trivy's database sit on that volume, installed once per version and out of reach of build steps.
  - **Limits:** memory (`TRAMLINE_BUILD_MEMORY_MB`, 4 GB by default) and processes.
  - **Clean-up:** builders left behind by a previous run, and the old shared builder, are removed when the agent starts.
- **R10, job lifecycle:**
  - **Queues:** builds, scans and data jobs (backups, restores, drills) run through a job queue with explicit states and deadlines: 30 minutes for builds, 20 for scans, 2 hours for data jobs.
  - **Cancellation:** a build or scan the control plane stops asking for (timed out or removed) is cancelled. Its builder is removed, so the work really stops, and the next job starts.
  - **Data jobs:** after their deadline the queue moves on and the job is reported failed. A command still running inside a database container isn't killed yet.
- **R1, second part:** connecting a GitHub installation goes through GitHub's user authorization. The one-time code is traded for a user token, used once and never stored, and the installation must be among those that person can access. New apps ask during install; older ones are sent to authorize after setup and need their callback URL set.
- **Sign-up policy:**
  - **`TRAMLINE_SIGNUP=invite` (the default):** once the install has an admin, a new account needs an invite link from an organization's owner or admin. Links work once, expire after a week, and carry a role. Set it to `open` for anyone.
  - **Accepting:** a signed-in person who opens a link is asked to confirm before joining that organization, so no other site can send them through one and add them to an organization of its choosing.
- **Still to do:** disk limits for builds (a per-job quota needs a volume driver that supports one), and killing a timed-out command inside a database container.

**Later**

- **Backup code:** split `domain/backups.ts` by responsibility (storage settings, job planning, report handling, scheduling, retention), and share one implementation of the encrypted backup format between the agent and the control plane.
- **UI:** collection updates that roll back only their own change when they fail.
- **Efficiency:** coalesce reconcile passes instead of running one per agent report, cache desired-state planning by revision, and load environment state in batched queries, with query-count checks.
- **Resource accounting:** default requests and limits, capacity reserved for infrastructure, and per-organization limits (with Phase 7's requests).

**6c: adapters and Proxmox**

6c is split in three: the adapter contract and accounts (6c.1), the Proxmox adapter (6c.2), then metrics (6c.3).

**6c.1: adapter SDK and compute accounts ✅** (unit-tested; e2e in CI)

- **`packages/adapter-sdk`:**
  - **The contract:** what an adapter declares (credentials schema, capabilities) and does (validate, regions, offers, create, get, list and destroy machines). Adapter failures carry messages a person can act on.
  - **GPUs from the start:** an adapter says whether it has GPUs, and each offer carries the GPU model, count and VRAM alongside vCPUs, memory, disk, arch and prices (on-demand, spot, egress).
  - **Cloud-init:** a new machine installs Docker from its distribution's packages if needed, then enrolls with its join token.
  - **A fake adapter** for tests, and a **conformance suite** every adapter passes. It checks credentials, regions and offers, then runs a machine through its whole life: create, find it, enroll (optional), destroy twice, and check it's gone (no orphans).
- **`packages/adapters/manual`:** 6a's join command behind the same contract, built in and needing no account. It passes the conformance suite.
- **Compute accounts** (Nodes → Compute accounts, install admins only):
  - **The form** is generated from the adapter's zod credentials schema. Secret fields are stored encrypted and never shown again; left blank, they keep their value.
  - **Test connection** has the adapter check the credentials with the provider.
  - **Removing an account** is refused while it has nodes, so no machine loses the account that would destroy it.
- **Adding a node with an account:** pick a region and a size (GPU sizes included), and the adapter creates a machine that enrolls itself. Until it does, it's listed as waiting to enroll, or as never enrolled once its token expires, with a Destroy button either way. If the adapter fails, the join token goes too.
- **Removing a node** an adapter created destroys its machine first; if that fails, the node stays.
- **GPUs at hello:** agents report the NVIDIA GPUs their kernel driver describes, and the Nodes page shows them.
- **Tests:** `TRAMLINE_FAKE_ADAPTER=1` offers the fake adapter, and the e2e suite connects an account, tests it and creates a machine with it.

**6c.2: Proxmox ✅** (unit-tested against a fake Proxmox API over real HTTPS; not yet run against a real cluster)

- **The `proxmox` adapter:** clones a cloud-init template (across hosts too), sets CPUs and memory per size, tags the VM `tramline` and starts it. Removing the node stops and deletes the VM with its disks. It only ever destroys VMs with that tag, and removes a clone it couldn't set up.
- **Enrolling without uploads:** Proxmox's API can't upload user data, so each VM's SMBIOS serial points cloud-init at its seed on Tramline (`ds=nocloud;s=…/api/agent/v1/seed/<id>/`). The seed is random, stored encrypted, and works only until the VM enrolls or its token expires.
- **Sizes and prices:** Small to X-Large, offered on each host that fits them. They're priced by their share of a host's memory from a $/month entered on the account (or $0).
- **TLS:** certificate chain, expiry and hostname validation always run; private hosts use a supplied CA certificate, with optional fingerprint pinning before the API token is sent.
- **The guide:** `docs/adapters/proxmox.md` covers the template, a least-privilege API token and connecting the account. The conformance suite runs against a real cluster when `TRAMLINE_PROXMOX_*` is set.
- **Also:** a machine that enrolls before its adapter has answered is still linked to its machine, so removing it destroys the VM.
- **Later:** the VM's address from the guest agent, GPU passthrough sizes, and creating the template from a cloud image in Tramline.

**6c.3: metrics**

- Agent stats → SQLite rollups (1m/1h), Metrics tab charts, basic alerts.

**Exit (6c):** add a Proxmox account → "Add node" provisions a VM that enrolls itself. Two nodes (local + Proxmox VM): a service on node A reaches Postgres on node B by its private name, and draining a node reschedules stateless services. Proxmox passes the conformance suite.

### Phase 7: Cloud adapters, GPU nodes and node pools

- Further adapters on the same contract, in order: **Hetzner**, **AWS EC2**, **GCP Compute**, **Azure VMs**. Each one is a package that passes the conformance suite, with no changes to core.
- **GPU nodes:**
  - **Agent:** the agent detects NVIDIA GPUs and the container toolkit, reports them, and passes requested GPUs to containers.
  - **Services:** a service can ask for GPUs (count, optional model, minimum VRAM), and the scheduler only places it on a node that has them free.
  - **Neocloud adapters:** for providers that hand you a machine (VM or bare metal), starting with **Lambda**, then Crusoe, Hyperstack, CoreWeave bare metal and Vast.ai VMs, alongside the hyperscalers' GPU instances.
  - **Spending guardrails** matter more at GPU prices: a confirmation before provisioning, a spend cap per pool, idle shutdown, and opt-in spot for training and batch jobs with checkpoints to a volume or bucket.
  - **Later:** providers that run the container for you (RunPod pods and serverless, Modal, Vast.ai containers) can't run the agent, so they need a different "runtime adapter" contract. That waits until after Phase 8.
- **Requests and spreading:** services get CPU and memory requests (defaults per template), the scheduler packs by them, and a service's replicas spread across nodes.
- Node pools per environment (adapter account + region + size, min/max) and auto-provisioning when the scheduler can't fit a workload. Idle nodes are destroyed, with a guardrail confirmation and a spend cap. Orphan detection via `listNodes`.
- **Exit:** add a Hetzner/AWS account → deploy a service with no capacity available → a VM is provisioned, the service runs on it, and removing the pool cleans up the VM. A service asking for one GPU lands on a Lambda (or other GPU) node and sees the GPU with `nvidia-smi`.

### Phase 8: Price engine and placement

- Catalog sync jobs call each adapter's `listOffers`, GPU offers included, so the same card can be compared across providers. Behind them: AWS Price List bulk API, GCP Cloud Billing Catalog API, Azure Retail Prices API (public), Hetzner API, and a Proxmox cost entered by the user. Results are cached in `price_offer` (vcpu, mem, arch, on-demand/spot $/hr, egress $/GB, fetchedAt).
- Placement engine: requirements (cpu/mem/arch/region constraints) → use existing capacity first (zero marginal cost) → otherwise ranked offers, including an egress estimate for cross-group traffic.
- UI: a "Where should this run?" comparison when creating node pools, a $/mo estimate per service and project, actual usage cost tracking, and opt-in spot for stateless services.
- **Exit:** for a given set of service requirements, Tramline shows a ranked provider/region/instance list with monthly cost and provisions the chosen option in one click.

### Phase 8.5: Tramline Templates

A gallery of ready-to-go infrastructure: pick a template, and a whole stack lands on the canvas with its services, volumes, references and generated secrets wired up. Review it, then deploy it in one click.

- **The format:** a template is a versioned `tramline.json` (Phase 9's config-as-code format, pulled forward):
  - **Contents:** services, images pinned by digest, volumes, ports, public domains, healthchecks and start order.
  - **Variables:** `${{Service.KEY}}` references, plus generated values: random secrets, and secrets derived from others, like JWTs signed with a generated key.
  - **Questions:** a few to ask on install, e.g. a site URL or an SMTP host.
- **Supabase first:**
  - **The stack:** Postgres, Auth (GoTrue), the REST API (PostgREST), Realtime, Storage, the meta API and Studio, behind its Kong gateway.
  - **Generated values:** the JWT secret, and anon and service-role keys signed with it.
  - **Reaching it:** one public domain on the gateway, and Postgres through the TLS-only TCP proxy for outside tools.
  - **Security:** Studio has no login of its own, so it is never given a public domain. It stays private, reachable through Tramline itself (a sign-in-gated route, or a port-forward from the CLI).
  - **Backups:** the Postgres volume is backed up like any database.
- **Then:** more stacks on the same format (e.g. Plausible, n8n, Metabase, Grafana with Prometheus), plus organization-private templates, and exporting an environment as a template.
- **Security for all templates:**
  - Images are pinned by digest and scanned like any other.
  - Generated secrets are sealed by default.
  - A template can't ask for anything a hand-built service couldn't: no host mounts, no privileges.
- **Exit:** "Supabase" from the gallery deploys a working stack. Its Auth and REST endpoints answer on the gateway's domain, an app on the canvas reaches it through references, and the data survives a redeploy.

### Phase 9: Production readiness and ecosystem

- PR preview environments, `tram` CLI (`login`, `link`, `up`, `logs`, `vars`, `run`) on the Phase 5 tokens, RBAC roles, notifications.
- Config-as-code (`tramline.json`), project templates (export/import), Litestream backups for the control plane, and a one-line installer (compose).
- Docs site, contribution guide, security review (agent token rotation, rate limits, CSRF, least-privilege IAM docs per cloud).

---

## Verification strategy (all phases)

- **Coverage gates in CI** (GitHub Actions): Vitest v8 coverage for `packages/*` and the server domain, with thresholds that only ratchet up; the report is uploaded as an artifact. The Playwright report is uploaded when e2e fails.
- **Unit (Vitest, server project)**: domain services, variable resolution and cycle detection, encryption, the reconciler and scheduler against a **fake agent/driver** (pure desired→actual diffing), and placement scoring.
- **Component (Vitest browser)**: canvas nodes, context menu, variables editor.
- **Integration**: agent against real Docker (CI job with the Docker socket), and the full deploy of `traefik/whoami` asserting an HTTP 200.
- **E2E (Playwright)**: each phase's exit scenario above becomes a test.
- `pnpm check`, `pnpm lint` and `pnpm test` stay green in CI on every PR.

## Open decisions

- **License**: AGPL-3.0 (stops closed SaaS forks) or Apache-2.0/MIT (maximum adoption).
- **Base domain** for generated URLs on your own install (wildcard DNS record).

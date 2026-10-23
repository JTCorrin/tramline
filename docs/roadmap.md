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

### Phase 2: Agent and local Docker deploys (image services)

- `packages/contracts` agent protocol: `hello/auth`, `desiredState`, `actualState`, `logChunk`, `stats`, `exec` (later).
- `apps/agent`: wss connection with node token, a dockerode-based local convergence loop, log streaming, a Docker events watcher, and a Caddy sidecar driven over its admin API.
- Control plane: SQLite job queue, agent gateway, **reconciler** (one node for now), deployment state machine, healthchecks, zero-downtime swap, rollback, restart policy.
- Networking v1: one Docker network per environment with aliases as `<service>.<env>.tramline.internal`. A generated public domain `<svc>-<hash>.<baseDomain>` (wildcard DNS, falling back to `sslip.io`) goes through Caddy with automatic TLS.
- Deployments tab: live status, build/deploy logs (append-only files per deployment, tailed over SSE), redeploy/rollback/remove.
- **Exit:** right-click → Docker Image `traefik/whoami` → Deploy. Status moves queued → deploying → active, logs stream, and the generated URL returns 200. Killing the container triggers a restart.

### Phase 3: Builds from source

- GitHub App (install, repo picker, push webhooks → auto-deploy on the chosen branch), plus public Git URLs.
- Builds run on the node's BuildKit: **Railpack** by default, Dockerfile when present, root-directory/watch-paths support, and build cache.
- Internal registry (`registry:2` managed by Tramline) and image retention/GC.
- **Exit:** connect a GitHub repo (Node/Python/Go sample) → push → it builds and deploys automatically with live build logs.

### Phase 4: Data, variables and networking depth

- Database templates (Postgres/MySQL/Redis/Mongo): image, volume, generated credentials, connection vars, and a canvas "Data" tab with a simple table browser for Postgres.
- Volumes (attach, size, mount path), sticky placement, and scheduled backups to S3-compatible storage.
- Full reference-variable resolution snapshotted at deploy time; custom domains (CNAME verification, certs); TCP proxy for databases; duplicate environment.
- **Exit:** add Postgres + an app that references `${{Postgres.DATABASE_URL}}`. The edge appears, the app connects over private networking, and data survives a redeploy.

### Phase 5: Agent access: API tokens + MCP server

- **API tokens** (moved forward from the last phase): org-scoped bearer tokens with optional scopes (read, write, deploy) and expiry, managed in organization settings. `endpoint()` accepts a token as well as a session cookie, and every token action goes to the audit log.
- **`apps/mcp`**: an MCP server built on `@modelcontextprotocol/sdk` that wraps `packages/client`, so agents use the same public API as the UI and CLI. It never touches the database directly.
  - **Transports:** stdio for local agents (`npx @tramline/mcp`, with `TRAMLINE_URL` and `TRAMLINE_TOKEN`), and Streamable HTTP served by Tramline itself at `/mcp`, authenticated with tokens and, later, OAuth.
  - **Tools** (zod input schemas taken from `packages/contracts`): `list_projects`, `get_canvas`, `create_service`, `update_service_config`, `set_variables`, `get_staged_changes`, `deploy`, `discard_changes`, `list_deployments`, `get_deployment_logs`, `create_environment`. Later phases add `list_nodes`, `add_node` and `compare_prices`.
  - **Resources:** `tramline://project/{id}/canvas` and `tramline://deployment/{id}/logs`.
  - **Prompts:** for example "deploy this repo with a Postgres database".
  - **Safety:** mutations go through staged changes. `deploy` and anything destructive are separate tools marked with MCP's `destructiveHint`, and a token without the deploy scope can only stage changes.
- **Tests:** a tool-level contract test for every tool against an in-process Tramline, plus an e2e test in which an MCP client creates a service, stages a variable and deploys.
- **Exit:** from Claude Code, `claude mcp add tramline …` lets an agent add Postgres and an app, wire `DATABASE_URL`, deploy, and read the deployment logs.

### Phase 6: Multi-node + adapter SDK + Proxmox adapter

- `packages/adapter-sdk` (contract, conformance suite, fake adapter), adapter registry, `adapter_account` UI with a form generated from each adapter's zod credentials schema and a "Test connection" button.
- **`manual` adapter**: join token + install script for any Linux box. **`proxmox` adapter**: provisions VMs from a cloud-init template via the Proxmox API, and they enroll on their own. Node list/health UI, drain/cordon.
- WireGuard mesh managed by agents and coordinated by the control plane; per-node DNS for `*.tramline.internal` across nodes; edge/ingress node role.
- Scheduler: bin-packing by cpu/mem requests, placement pins, volume affinity, replicas spread across nodes.
- Metrics: agent stats → SQLite rollups (1m/1h), Metrics tab charts, basic alerts.
- **Exit:** add a Proxmox account → "Add node" provisions a VM that enrolls itself. Two nodes (local + Proxmox VM): a service on node A reaches Postgres on node B by its private name, and draining a node reschedules stateless services. Proxmox passes the conformance suite.

### Phase 7: Cloud adapters + node pools

- Further adapters on the same contract, in order: **Hetzner**, **AWS EC2**, **GCP Compute**, **Azure VMs**. Each one is a package that passes the conformance suite, with no changes to core.
- Node pools per environment (adapter account + region + size, min/max) and auto-provisioning when the scheduler can't fit a workload. Idle nodes are destroyed, with a guardrail confirmation and a spend cap. Orphan detection via `listNodes`.
- **Exit:** add a Hetzner/AWS account → deploy a service with no capacity available → a VM is provisioned, the service runs on it, and removing the pool cleans up the VM.

### Phase 8: Price engine and placement

- Catalog sync jobs call each adapter's `listOffers`. Behind them: AWS Price List bulk API, GCP Cloud Billing Catalog API, Azure Retail Prices API (public), Hetzner API, and a Proxmox cost entered by the user. Results are cached in `price_offer` (vcpu, mem, arch, on-demand/spot $/hr, egress $/GB, fetchedAt).
- Placement engine: requirements (cpu/mem/arch/region constraints) → use existing capacity first (zero marginal cost) → otherwise ranked offers, including an egress estimate for cross-group traffic.
- UI: a "Where should this run?" comparison when creating node pools, a $/mo estimate per service and project, actual usage cost tracking, and opt-in spot for stateless services.
- **Exit:** for a given set of service requirements, Tramline shows a ranked provider/region/instance list with monthly cost and provisions the chosen option in one click.

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

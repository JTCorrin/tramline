# The Tramline agent, for machines enrolled as nodes. Build from the repository root:
#   docker build -f apps/agent/Dockerfile -t tramline-agent .
FROM node:24-alpine AS build
RUN corepack enable
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/contracts/package.json packages/contracts/
COPY apps/agent/package.json apps/agent/
RUN pnpm install --frozen-lockfile --filter @tramline/agent...
COPY packages/contracts packages/contracts
COPY apps/agent apps/agent
RUN pnpm --filter @tramline/agent bundle

FROM node:24-alpine
# tini forwards signals, so the agent shuts down cleanly on `docker stop`; the same
# image runs each node's mesh container (`mesh`), which needs ip and wg, and its
# firewall container (`firewall`), which needs iptables in whichever flavour Docker uses
RUN apk add --no-cache tini iproute2 wireguard-tools-wg iptables iptables-legacy \
	&& mkdir -p /etc/tramline
COPY --from=build /src/apps/agent/dist/agent.mjs /opt/tramline/agent.mjs
# the commit it was built from, which the Nodes page shows (CI passes it; else 0.1.0)
ARG VERSION=
ENV NODE_ENV=production \
	TRAMLINE_AGENT_VERSION=$VERSION \
	TRAMLINE_AGENT_STATE_DIR=/var/lib/tramline
VOLUME /var/lib/tramline
ENTRYPOINT ["/sbin/tini", "--", "node", "/opt/tramline/agent.mjs"]

import type { RequestHandler } from './$types';

/** The agent image nodes run; `--image` (or TRAMLINE_AGENT_IMAGE) overrides it. */
const AGENT_IMAGE = 'ghcr.io/jtcorrin/tramline-agent:latest';

/**
 * Enrolls a Linux machine as a node: checks Docker, then runs the agent as a
 * container that trades its join token for a node token. Served as text so
 * it can be read before it's run:
 *
 *   curl -fsSL https://tramline.example.com/install.sh | less
 */
const script = `#!/bin/sh
# Tramline node installer. Usage:
#   curl -fsSL <tramline>/install.sh | sudo sh -s -- --url <tramline> --token <join token>
# Add --endpoint <public ip or name>:51820 when other nodes can reach this one over UDP;
# without it the node connects out to those that can.
#
# To move a node's agent to the latest image, keeping its identity and settings:
#   curl -fsSL <tramline>/install.sh | sudo sh -s -- --update
# (Agents from November 2026 on can also be updated from the Nodes page.)
set -eu

URL=""
TOKEN=""
ENDPOINT=""
IMAGE="\${TRAMLINE_AGENT_IMAGE:-}"
NAME="tramline-agent"
UPDATE=""

while [ $# -gt 0 ]; do
	case "$1" in
		--url) URL="$2"; shift 2 ;;
		--token) TOKEN="$2"; shift 2 ;;
		--image) IMAGE="$2"; shift 2 ;;
		--endpoint) ENDPOINT="$2"; shift 2 ;;
		--update) UPDATE=1; shift ;;
		*) echo "Unknown option: $1" >&2; exit 2 ;;
	esac
done

fail() { echo "tramline: $1" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || fail "Docker isn't installed. Install Docker Engine first: https://docs.docker.com/engine/install/"
docker info >/dev/null 2>&1 || fail "Can't reach the Docker daemon. Is it running, and are you root (or in the docker group)?"

# Starts the agent. The agent needs the Docker socket to run workloads, so it is
# as powerful as root on this machine. Everything else is locked down: no
# capabilities, no privilege escalation, a read-only filesystem, and a volume
# for its token.
run_agent() {
	docker run -d \\
		--name "$NAME" \\
		--hostname "$(hostname)" \\
		--restart unless-stopped \\
		--cap-drop ALL \\
		--security-opt no-new-privileges:true \\
		--read-only \\
		--tmpfs /tmp:rw,noexec,nosuid,size=64m \\
		--pids-limit 512 \\
		--log-opt max-size=10m --log-opt max-file=3 \\
		-v /var/run/docker.sock:/var/run/docker.sock \\
		-v "$NAME":/var/lib/tramline \\
		-e TRAMLINE_URL="$URL" \\
		-e TRAMLINE_JOIN_TOKEN="$TOKEN" \\
		-e TRAMLINE_MESH_IMAGE="$IMAGE" \\
		-e TRAMLINE_MESH_ENDPOINT="$ENDPOINT" \\
		"$IMAGE" >/dev/null
}

pull() {
	echo "tramline: pulling $IMAGE"
	docker pull "$IMAGE" >/dev/null 2>&1 || docker image inspect "$IMAGE" >/dev/null 2>&1 || fail "Couldn't pull $IMAGE"
}

if [ -n "$UPDATE" ]; then
	docker inspect "$NAME" >/dev/null 2>&1 || fail "There's no Tramline agent on this machine to update. Enroll it with --url and --token instead."
	setting() { docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$NAME" | sed -n "s/^$1=//p" | head -1; }
	URL="$(setting TRAMLINE_URL)"
	ENDPOINT="$(setting TRAMLINE_MESH_ENDPOINT)"
	[ -n "$IMAGE" ] || IMAGE="$(docker inspect -f '{{.Config.Image}}' "$NAME")"
	[ -n "$URL" ] || fail "Couldn't read TRAMLINE_URL from the running agent"
	pull
	if [ "$(docker image inspect -f '{{.Id}}' "$IMAGE")" = "$(docker inspect -f '{{.Image}}' "$NAME")" ]; then
		echo "tramline: the agent is already on the latest $IMAGE"
		exit 0
	fi
	# the node token is in the volume, so the new agent carries on as the same node
	docker rm -f "$NAME" >/dev/null
	run_agent
	for _ in $(seq 1 30); do
		if docker logs "$NAME" 2>&1 | grep -q "starting"; then
			sleep 5
			if [ "$(docker inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null)" = "true" ]; then
				echo "tramline: updated. The node shows the new agent under Nodes in a few seconds."
				exit 0
			fi
		fi
		sleep 1
	done
	docker logs "$NAME" 2>&1 | tail -5 >&2
	fail "the new agent didn't start (see above). Follow it with: docker logs -f $NAME"
fi

[ -n "$URL" ] || fail "--url is required"
[ -n "$TOKEN" ] || fail "--token is required (create one under Nodes → Add node)"
[ -n "$IMAGE" ] || IMAGE="${AGENT_IMAGE}"

if docker inspect "$NAME" >/dev/null 2>&1; then
	fail "This machine already runs a Tramline agent. To update it: add --update instead of --url and --token. To enroll it again: docker rm -f $NAME && docker volume rm $NAME"
fi

pull
run_agent

# the join token works once; wait to hear whether it did
for _ in $(seq 1 30); do
	if docker logs "$NAME" 2>&1 | grep -q "joined as node"; then
		docker logs "$NAME" 2>&1 | grep "joined as node" | tail -1 | sed 's/^\\[agent\\] /tramline: /'
		echo "tramline: done. The node shows up under Nodes in a few seconds."
		exit 0
	fi
	if [ "$(docker inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null)" != "true" ]; then
		docker logs "$NAME" 2>&1 | tail -5 >&2
		docker rm -f "$NAME" >/dev/null 2>&1 || true
		docker volume rm "$NAME" >/dev/null 2>&1 || true
		fail "the agent couldn't enroll this machine (see above)"
	fi
	sleep 1
done
echo "tramline: the agent is running but hasn't reached $URL yet. Follow it with: docker logs -f $NAME"
`;

export const GET: RequestHandler = () =>
	new Response(script, {
		headers: {
			'content-type': 'text/plain; charset=utf-8',
			'cache-control': 'no-store'
		}
	});

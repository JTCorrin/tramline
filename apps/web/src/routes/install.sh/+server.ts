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
set -eu

URL=""
TOKEN=""
IMAGE="\${TRAMLINE_AGENT_IMAGE:-${AGENT_IMAGE}}"
NAME="tramline-agent"

while [ $# -gt 0 ]; do
	case "$1" in
		--url) URL="$2"; shift 2 ;;
		--token) TOKEN="$2"; shift 2 ;;
		--image) IMAGE="$2"; shift 2 ;;
		*) echo "Unknown option: $1" >&2; exit 2 ;;
	esac
done

fail() { echo "tramline: $1" >&2; exit 1; }

[ -n "$URL" ] || fail "--url is required"
[ -n "$TOKEN" ] || fail "--token is required (create one under Nodes → Add node)"
command -v docker >/dev/null 2>&1 || fail "Docker isn't installed. Install Docker Engine first: https://docs.docker.com/engine/install/"
docker info >/dev/null 2>&1 || fail "Can't reach the Docker daemon. Is it running, and are you root (or in the docker group)?"

if docker inspect "$NAME" >/dev/null 2>&1; then
	fail "This machine already runs a Tramline agent. To enroll it again: docker rm -f $NAME && docker volume rm $NAME"
fi

echo "tramline: pulling $IMAGE"
docker pull "$IMAGE" >/dev/null 2>&1 || docker image inspect "$IMAGE" >/dev/null 2>&1 || fail "Couldn't pull $IMAGE"

# The agent needs the Docker socket to run workloads, so it is as powerful as
# root on this machine. Everything else is locked down: no capabilities, no
# privilege escalation, a read-only filesystem, and a volume for its token.
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
	"$IMAGE" >/dev/null

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

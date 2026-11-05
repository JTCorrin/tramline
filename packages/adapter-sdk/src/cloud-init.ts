/** About 45 minutes of retries, inside the join token's hour. */
export const ENROLL_ATTEMPTS = 180;
export const ENROLL_DELAY_SECONDS = 15;

/**
 * Cloud-init user data for a new machine: install Docker from the
 * distribution's packages when it's missing, then enroll with the join
 * token. Any image with cloud-init (Debian, Ubuntu, Fedora, Rocky…) works.
 * A VM with a QEMU guest agent channel (Proxmox's "QEMU Guest Agent" option)
 * also gets the agent, so its host can see its addresses and shut it down
 * cleanly; that part is best-effort and never stops enrollment.
 *
 * `publicAddress` is a shell command that prints the machine's public
 * address, e.g. from a cloud's metadata server. When it prints one, the node
 * offers `<address>:51820` as its mesh endpoint, so other nodes can reach it.
 */
export function cloudInit(install: { url: string; token: string; publicAddress?: string }) {
	const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;
	const script = [
		'set -eu',
		'if ! command -v docker >/dev/null 2>&1; then',
		'  if command -v apt-get >/dev/null 2>&1; then apt-get update -q && DEBIAN_FRONTEND=noninteractive apt-get install -yq docker.io curl',
		'  elif command -v dnf >/dev/null 2>&1; then dnf install -yq moby-engine curl || dnf install -yq docker curl',
		'  else echo "tramline: no package manager to install Docker with" >&2; exit 1; fi',
		'fi',
		'systemctl enable --now docker',
		'if [ -e /dev/virtio-ports/org.qemu.guest_agent.0 ]; then',
		'  { if ! command -v qemu-ga >/dev/null 2>&1; then',
		'    if command -v apt-get >/dev/null 2>&1; then apt-get update -q && DEBIAN_FRONTEND=noninteractive apt-get install -yq qemu-guest-agent',
		'    else dnf install -yq qemu-guest-agent; fi',
		'    fi',
		'    systemctl start qemu-guest-agent; } || echo "tramline: could not set up the QEMU guest agent" >&2',
		'fi',
		...(install.publicAddress
			? [
					`ADDRESS=$(${install.publicAddress} || true)`,
					'ENDPOINT=""; [ -n "$ADDRESS" ] && ENDPOINT="--endpoint $ADDRESS:51820"'
				]
			: []),
		// Tramline may not be reachable yet (a tunnel whose connector isn't
		// running, DNS still propagating), so keep trying for most of the join
		// token's hour instead of giving up after one attempt. The install
		// script removes what it made when enrolling fails, so a retry starts clean.
		'attempt=1',
		`until curl -fsSL --max-time 60 -o /run/tramline-install.sh ${quote(`${install.url}/install.sh`)} && sh /run/tramline-install.sh --url ${quote(install.url)} --token ${quote(install.token)}${install.publicAddress ? ' $ENDPOINT' : ''}; do`,
		`  [ "$attempt" -lt ${ENROLL_ATTEMPTS} ] || { echo "tramline: couldn't enroll after $attempt attempts; can this machine reach Tramline?" >&2; exit 1; }`,
		`  echo "tramline: couldn't enroll yet (attempt $attempt), retrying in ${ENROLL_DELAY_SECONDS} seconds" >&2`,
		'  attempt=$((attempt + 1))',
		`  sleep ${ENROLL_DELAY_SECONDS}`,
		'done'
	].join('\n');
	return [
		'#cloud-config',
		'write_files:',
		'  - path: /run/tramline-enroll.sh',
		"    permissions: '0700'",
		'    content: |',
		...script.split('\n').map((line) => `      ${line}`),
		'runcmd:',
		'  - [sh, /run/tramline-enroll.sh]',
		''
	].join('\n');
}

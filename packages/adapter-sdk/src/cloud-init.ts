/**
 * Cloud-init user data for a new machine: install Docker from the
 * distribution's packages when it's missing, then enroll with the join
 * token. Any image with cloud-init (Debian, Ubuntu, Fedora, Rocky…) works.
 */
export function cloudInit(install: { url: string; token: string }) {
	const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;
	const script = [
		'set -eu',
		'if ! command -v docker >/dev/null 2>&1; then',
		'  if command -v apt-get >/dev/null 2>&1; then apt-get update -q && DEBIAN_FRONTEND=noninteractive apt-get install -yq docker.io curl',
		'  elif command -v dnf >/dev/null 2>&1; then dnf install -yq moby-engine curl || dnf install -yq docker curl',
		'  else echo "tramline: no package manager to install Docker with" >&2; exit 1; fi',
		'fi',
		'systemctl enable --now docker',
		`curl -fsSL ${quote(`${install.url}/install.sh`)} | sh -s -- --url ${quote(install.url)} --token ${quote(install.token)}`
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

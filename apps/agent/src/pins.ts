/**
 * Exact versions of the third-party build tools the agent runs, pinned by
 * checksum or digest so a compromised tag or release can't change what runs.
 * Bump them together, with the checksums from each project's release.
 */
export const RAILPACK = {
	version: 'v0.43.0',
	/** sha256 of each release tarball, from the release's checksums.txt. */
	sha256: {
		aarch64: '732ece14eb4f4676a43ebba19431f954edf7b130acb76159ef0f2ff86ac42ac9',
		x86_64: '248a8f60f36854aabed6124113631078a802de3461660855fc4de9c26065c1fb'
	} as Record<string, string>,
	/** Docker reports `aarch64`/`x86_64`; Railpack names its releases `arm64`/`x86_64`. */
	target: { aarch64: 'arm64-unknown-linux-musl', x86_64: 'x86_64-unknown-linux-musl' } as Record<
		string,
		string
	>,
	/** BuildKit frontend matching the CLI version that wrote the plan. */
	frontend:
		'ghcr.io/railwayapp/railpack-frontend:v0.43.0@sha256:355ef61fae6f2551103cd8b10c710cb07167dd353d561f15c69b8d7ac1c676cc'
};

/** Rootless BuildKit: builds run as an unprivileged user, never --privileged. */
export const BUILDKIT_IMAGE =
	'moby/buildkit:v0.34.1-rootless@sha256:f68752a5a94acfcdad2d07867b7075601a421638e17fc5f28efc1c814d0c4f89';

/** Runs `tar` against a volume for backups and restores, so service images don't need it. */
export const HELPER_IMAGE =
	'busybox:1.37.0@sha256:bdf57e528e45e4433820e045b29b4597825a1c9e38353532d90a01445013f82e';

/** Trivy, the vulnerability scanner, run inside the rootless builder. */
export const TRIVY = {
	version: '0.75.0',
	/** sha256 of each release tarball, from the release's checksums.txt. */
	sha256: {
		aarch64: 'a1ee9f6ffb7d112b64ff726a2a0717c21175c1114361391f4a132956751a13b3',
		x86_64: 'c6e65abddb348e25f10549df887045629cf28cc72453cd1c63acb717316b3f3f'
	} as Record<string, string>,
	target: { aarch64: 'Linux-ARM64', x86_64: 'Linux-64bit' } as Record<string, string>
};

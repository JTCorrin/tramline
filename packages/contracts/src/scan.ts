import { z } from 'zod';

/**
 * Image vulnerability scanning. `warn` deploys and shows what was found,
 * `block` refuses images with critical vulnerabilities that have a fix,
 * `off` skips the scan.
 */
export const SCAN_MODES = ['warn', 'block', 'off'] as const;
export const ScanMode = z.enum(SCAN_MODES);
export type ScanMode = z.infer<typeof ScanMode>;

export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'unknown'] as const;
export const Severity = z.enum(SEVERITIES);
export type Severity = z.infer<typeof Severity>;

export const ScanFinding = z.object({
	/** e.g. `CVE-2024-1234` or `GHSA-…`. */
	id: z.string(),
	severity: Severity,
	package: z.string(),
	installed: z.string(),
	/** First fixed version, or null when there is no fix yet. */
	fixed: z.string().nullable(),
	title: z.string().nullable()
});

export type ScanFinding = z.infer<typeof ScanFinding>;

/** Most findings kept per scan; counts always cover everything. */
export const MAX_SCAN_FINDINGS = 50;

export const ScanResult = z.object({
	/** e.g. `Trivy 0.75.0`. */
	scanner: z.string(),
	/**
	 * `clean`: nothing high or critical. `warned`: high or critical findings, deployed anyway.
	 * `blocked`: fixable critical findings in block mode. `error`: the scan itself failed.
	 */
	outcome: z.enum(['clean', 'warned', 'blocked', 'error']),
	counts: z.record(Severity, z.number().int().nonnegative()),
	/** Critical findings with a fixed version available; what `block` mode refuses. */
	fixableCritical: z.number().int().nonnegative(),
	/** The most severe findings first, at most MAX_SCAN_FINDINGS. */
	findings: z.array(ScanFinding),
	error: z.string().nullable(),
	scannedAt: z.iso.datetime()
});

export type ScanResult = z.infer<typeof ScanResult>;

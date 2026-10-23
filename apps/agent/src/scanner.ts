import {
	MAX_SCAN_FINDINGS,
	SEVERITIES,
	type ScanFinding,
	type ScanMode,
	type ScanResult,
	type Severity
} from '@tramline/contracts';
import { TRIVY } from './pins';

export const SCANNER = `Trivy ${TRIVY.version}`;

/** What Trivy's JSON report (`--format json`) contains that the summary needs. */
export interface TrivyReport {
	Results?: {
		Target?: string;
		Vulnerabilities?: {
			VulnerabilityID: string;
			PkgName: string;
			InstalledVersion?: string;
			FixedVersion?: string;
			Severity?: string;
			Title?: string;
		}[];
	}[];
}

const rank = (severity: Severity) => SEVERITIES.indexOf(severity);

function severityOf(value: string | undefined): Severity {
	const lower = value?.toLowerCase() as Severity | undefined;
	return lower && SEVERITIES.includes(lower) ? lower : 'unknown';
}

/**
 * Condenses a Trivy report: counts per severity (each vulnerability counted
 * once per package), the most severe findings, and whether `mode` lets the
 * image run.
 */
export function summarise(report: TrivyReport, mode: ScanMode, now = new Date()): ScanResult {
	const unique = new Map<string, ScanFinding>();
	for (const result of report.Results ?? []) {
		for (const v of result.Vulnerabilities ?? []) {
			const key = `${v.VulnerabilityID}|${v.PkgName}|${v.InstalledVersion ?? ''}`;
			if (unique.has(key)) continue;
			unique.set(key, {
				id: v.VulnerabilityID,
				severity: severityOf(v.Severity),
				package: v.PkgName,
				installed: v.InstalledVersion ?? '',
				// Trivy lists every fixed line, e.g. "1.2.3, 2.0.1"
				fixed: v.FixedVersion?.split(',')[0]?.trim() || null,
				title: v.Title ?? null
			});
		}
	}
	const findings = [...unique.values()].sort(
		(a, b) =>
			rank(a.severity) - rank(b.severity) ||
			Number(b.fixed !== null) - Number(a.fixed !== null) ||
			a.id.localeCompare(b.id)
	);
	const counts = Object.fromEntries(SEVERITIES.map((s) => [s, 0])) as Record<Severity, number>;
	for (const finding of findings) counts[finding.severity]++;
	const fixableCritical = findings.filter((f) => f.severity === 'critical' && f.fixed).length;

	const outcome =
		mode === 'block' && fixableCritical > 0
			? 'blocked'
			: counts.critical + counts.high > 0
				? 'warned'
				: 'clean';
	return {
		scanner: SCANNER,
		outcome,
		counts,
		fixableCritical,
		findings: findings.slice(0, MAX_SCAN_FINDINGS),
		error: null,
		scannedAt: now.toISOString()
	};
}

/** A scan that couldn't run. Block mode refuses the image, since nothing was verified. */
export function scanError(error: string, now = new Date()): ScanResult {
	return {
		scanner: SCANNER,
		outcome: 'error',
		counts: Object.fromEntries(SEVERITIES.map((s) => [s, 0])) as Record<Severity, number>,
		fixableCritical: 0,
		findings: [],
		error,
		scannedAt: now.toISOString()
	};
}

/** One line for the deployment log, e.g. "2 critical (1 fixable), 5 high, 12 medium". */
export function describe(result: ScanResult) {
	if (result.error) return `Scan failed: ${result.error}`;
	const parts = SEVERITIES.filter((s) => result.counts[s] > 0).map((s) =>
		s === 'critical' && result.fixableCritical
			? `${result.counts[s]} critical (${result.fixableCritical} fixable)`
			: `${result.counts[s]} ${s}`
	);
	return parts.length ? `Found ${parts.join(', ')}` : 'No known vulnerabilities';
}

/** Why a blocked image was refused, for the deployment's status message. */
export const blockedMessage = (result: ScanResult) =>
	`Blocked: ${result.fixableCritical} critical ${result.fixableCritical === 1 ? 'vulnerability' : 'vulnerabilities'} with a fix available`;

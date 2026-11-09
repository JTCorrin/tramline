import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { isIPv4, isIPv6 } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';

/**
 * Who an address belongs to: the network (autonomous system) announcing it,
 * e.g. AS15169 "GOOGLE". From an offline table (iptoasn.com's, public domain
 * by default), downloaded into the data directory and refreshed weekly;
 * addresses are looked up here and never leave the install.
 *
 * The file is tab-separated: range start, range end, AS number, country,
 * description. AS 0 marks ranges nobody announces.
 */

export interface Network {
	asn: number;
	name: string;
}

export interface AsnTable {
	lookup(address: string): Network | null;
	/** Ranges loaded. */
	readonly size: number;
}

/** How long a downloaded table is used before it's fetched again. */
export const REFRESH_MS = 7 * 86_400_000;
/** After a failed download, wait this long before trying again. */
export const RETRY_MS = 3_600_000;

export function ipv4ToNumber(address: string) {
	const parts = address.split('.');
	return (
		((Number(parts[0]) << 24) >>> 0) +
		(Number(parts[1]) << 16) +
		(Number(parts[2]) << 8) +
		Number(parts[3])
	);
}

export function ipv6ToBigInt(address: string): bigint {
	let text = address;
	// an IPv4 tail (::ffff:1.2.3.4) becomes two groups
	const v4 = text.match(/(\d+\.\d+\.\d+\.\d+)$/);
	if (v4) {
		const n = ipv4ToNumber(v4[1]!);
		text =
			text.slice(0, -v4[1]!.length) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
	}
	const [head, tail] = text.split('::') as [string, string | undefined];
	const left = head ? head.split(':') : [];
	const right = tail === undefined ? [] : tail ? tail.split(':') : [];
	const groups =
		tail === undefined
			? left
			: [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
	return groups.reduce((value, group) => (value << 16n) | BigInt(parseInt(group || '0', 16)), 0n);
}

/** Last index whose start is at or below `value`, or -1. */
function floor<T>(starts: ArrayLike<T>, value: T) {
	let lo = 0;
	let hi = starts.length - 1;
	let found = -1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		if (starts[mid]! <= value) {
			found = mid;
			lo = mid + 1;
		} else hi = mid - 1;
	}
	return found;
}

/**
 * Builds the table from the file's text. Parsing yields to the event loop
 * every so often, so loading a few hundred thousand ranges doesn't stall
 * requests.
 */
export async function parseAsnTable(text: string): Promise<AsnTable> {
	const names = new Map<number, string>();
	const v4: [number, number, number][] = [];
	const v6: [bigint, bigint, number][] = [];
	let at = 0;
	let lines = 0;
	while (at < text.length) {
		let end = text.indexOf('\n', at);
		if (end < 0) end = text.length;
		const line = text.slice(at, end);
		at = end + 1;
		if (++lines % 50_000 === 0) await new Promise((resolve) => setImmediate(resolve));
		const [start, last, asText, , name] = line.split('\t');
		const asn = Number(asText);
		if (!start || !last || !Number.isInteger(asn) || asn === 0) continue;
		if (!names.has(asn)) names.set(asn, (name ?? '').trim() || `AS${asn}`);
		if (isIPv4(start) && isIPv4(last)) v4.push([ipv4ToNumber(start), ipv4ToNumber(last), asn]);
		else if (isIPv6(start) && isIPv6(last)) v6.push([ipv6ToBigInt(start), ipv6ToBigInt(last), asn]);
	}
	v4.sort((a, b) => a[0] - b[0]);
	v6.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
	const v4Starts = Uint32Array.from(v4, (r) => r[0]);
	const v4Ends = Uint32Array.from(v4, (r) => r[1]);
	const v4As = Uint32Array.from(v4, (r) => r[2]);
	const v6Starts = v6.map((r) => r[0]);
	const network = (asn: number) => ({ asn, name: names.get(asn)! });
	return {
		size: v4.length + v6.length,
		lookup(address) {
			const a =
				address.startsWith('::ffff:') && isIPv4(address.slice(7)) ? address.slice(7) : address;
			if (isIPv4(a)) {
				const n = ipv4ToNumber(a);
				const i = floor(v4Starts, n);
				return i >= 0 && n <= v4Ends[i]! ? network(v4As[i]!) : null;
			}
			if (isIPv6(a)) {
				const n = ipv6ToBigInt(a);
				const i = floor(v6Starts, n);
				return i >= 0 && n <= v6[i]![1] ? network(v6[i]![2]) : null;
			}
			return null;
		}
	};
}

const decode = async (data: Buffer, name: string) =>
	(name.endsWith('.gz') ? await promisify(gunzip)(data) : data).toString('utf8');

/**
 * Keeps the table loaded and fresh: downloads it when the copy in the data
 * directory is missing or a week old, and loads it once per new file.
 * Failures leave the previous table (or none) in place; they're logged and
 * retried an hour later.
 */
export class AsnData {
	#table: AsnTable | null = null;
	#loadedMtime = 0;
	#busy: Promise<void> | null = null;
	#retryAt = 0;

	constructor(
		private dataDir: string,
		private url: string | null,
		private fetcher: typeof fetch = fetch,
		private log: (message: string) => void = (m) => console.error(`[asn] ${m}`)
	) {}

	get table() {
		return this.#table;
	}

	lookup(address: string) {
		return this.#table?.lookup(address) ?? null;
	}

	get #file() {
		const name = this.url?.endsWith('.gz') ? 'ip2asn.tsv.gz' : 'ip2asn.tsv';
		return path.join(this.dataDir, 'asn', name);
	}

	/** Downloads or loads the table when due; safe to call often, e.g. every minute. */
	refresh(now = Date.now()) {
		if (!this.url || this.#busy || now < this.#retryAt) return this.#busy ?? Promise.resolve();
		this.#busy = this.#refresh(now)
			.catch((error) => {
				this.#retryAt = now + RETRY_MS;
				this.log(error instanceof Error ? error.message : String(error));
			})
			.finally(() => (this.#busy = null));
		return this.#busy;
	}

	async #refresh(now: number) {
		const url = this.url!;
		if (url.startsWith('file:')) {
			const source = fileURLToPath(url);
			const mtime = statSync(source).mtimeMs;
			if (this.#table && mtime === this.#loadedMtime) return;
			this.#table = await parseAsnTable(await decode(readFileSync(source), source));
			this.#loadedMtime = mtime;
			return;
		}
		const file = this.#file;
		const age = existsSync(file) ? now - statSync(file).mtimeMs : Infinity;
		if (age >= REFRESH_MS) {
			const response = await this.fetcher(url, { signal: AbortSignal.timeout(120_000) });
			if (!response.ok) throw new Error(`downloading ${url} failed: HTTP ${response.status}`);
			const data = Buffer.from(await response.arrayBuffer());
			// check it reads before replacing the copy we have
			const table = await parseAsnTable(await decode(data, file));
			if (!table.size) throw new Error(`${url} has no address ranges`);
			mkdirSync(path.dirname(file), { recursive: true });
			writeFileSync(`${file}.tmp`, data);
			renameSync(`${file}.tmp`, file);
			this.#table = table;
			this.#loadedMtime = statSync(file).mtimeMs;
			return;
		}
		const mtime = statSync(file).mtimeMs;
		if (this.#table && mtime === this.#loadedMtime) return;
		this.#table = await parseAsnTable(await decode(readFileSync(file), file));
		this.#loadedMtime = mtime;
	}
}

/**
 * An address without its last part: the last number of an IPv4 address, or
 * everything after the first 48 bits of an IPv6 one (a typical site prefix).
 */
export function anonymize(address: string) {
	if (isIPv4(address)) return address.replace(/\.\d+$/, '.0');
	if (isIPv6(address)) {
		const n = ipv6ToBigInt(address) >> 80n;
		const groups = [n >> 32n, (n >> 16n) & 0xffffn, n & 0xffffn].map((g) => g.toString(16));
		return `${groups.join(':')}::`;
	}
	return address;
}

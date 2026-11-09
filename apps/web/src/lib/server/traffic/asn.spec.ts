import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import {
	AsnData,
	REFRESH_MS,
	RETRY_MS,
	anonymize,
	ipv4ToNumber,
	ipv6ToBigInt,
	parseAsnTable
} from './asn';

/** A few rows in iptoasn.com's format: start, end, AS number, country, description. */
const TABLE = [
	'1.0.0.0\t1.0.0.255\t13335\tUS\tCLOUDFLARENET',
	'8.8.8.0\t8.8.8.255\t15169\tUS\tGOOGLE',
	'8.8.9.0\t8.8.9.255\t0\tNone\tNot routed',
	'34.0.0.0\t34.127.255.255\t396982\tUS\tGOOGLE-CLOUD-PLATFORM',
	'2001:4860::\t2001:4860:ffff:ffff:ffff:ffff:ffff:ffff\t15169\tUS\tGOOGLE',
	'2a01:4f8::\t2a01:4f8:ffff:ffff:ffff:ffff:ffff:ffff\t24940\tDE\tHETZNER-AS',
	'',
	'garbage line',
	'9.9.9.0\t9.9.9.255\tnot-a-number\tUS\tQUAD9'
].join('\n');

describe('the IP-to-network table', () => {
	it('finds the network an address belongs to', async () => {
		const table = await parseAsnTable(TABLE);
		expect(table.size).toBe(5);
		expect(table.lookup('8.8.8.8')).toEqual({ asn: 15169, name: 'GOOGLE' });
		expect(table.lookup('34.100.1.2')).toEqual({ asn: 396982, name: 'GOOGLE-CLOUD-PLATFORM' });
		expect(table.lookup('::ffff:1.0.0.1')).toEqual({ asn: 13335, name: 'CLOUDFLARENET' });
		expect(table.lookup('2a01:4f8:c17:1::1')).toEqual({ asn: 24940, name: 'HETZNER-AS' });
		expect(table.lookup('2001:4860:4860::8888')).toEqual({ asn: 15169, name: 'GOOGLE' });
		// gaps, unrouted ranges, before the first range and non-addresses
		expect(table.lookup('8.8.9.1')).toBeNull();
		expect(table.lookup('9.9.9.9')).toBeNull();
		expect(table.lookup('0.0.0.1')).toBeNull();
		expect(table.lookup('2a02::1')).toBeNull();
		expect(table.lookup('::1')).toBeNull();
		expect(table.lookup('nope')).toBeNull();
	});

	it('reads addresses as numbers', () => {
		expect(ipv4ToNumber('255.255.255.255')).toBe(0xffffffff);
		expect(ipv6ToBigInt('::1')).toBe(1n);
		expect(ipv6ToBigInt('1::')).toBe(1n << 112n);
		expect(ipv6ToBigInt('::ffff:1.2.3.4')).toBe(0xffff01020304n);
		expect(ipv6ToBigInt('1:2:3:4:5:6:7:8')).toBe(0x00010002000300040005000600070008n);
	});

	it('anonymises addresses', () => {
		expect(anonymize('203.0.113.9')).toBe('203.0.113.0');
		expect(anonymize('2a01:4f8:c17:1::1')).toBe('2a01:4f8:c17::');
		expect(anonymize('nonsense')).toBe('nonsense');
	});
});

describe('keeping the table fresh', () => {
	const URL = 'https://iptoasn.example/ip2asn.tsv.gz';
	const dir = () => mkdtempSync(path.join(tmpdir(), 'tramline-asn-'));
	const ok = () => new Response(gzipSync(TABLE));

	it('downloads it once, then loads the copy until it is a week old', async () => {
		const fetcher = vi.fn(async () => ok());
		const dataDir = dir();
		const data = new AsnData(dataDir, URL, fetcher as unknown as typeof fetch);
		expect(data.lookup('8.8.8.8')).toBeNull();
		await data.refresh();
		expect(data.lookup('8.8.8.8')?.asn).toBe(15169);
		await data.refresh();
		expect(fetcher).toHaveBeenCalledTimes(1);

		// a restart loads the downloaded copy without fetching
		const restarted = new AsnData(dataDir, URL, fetcher as unknown as typeof fetch);
		await restarted.refresh();
		expect(restarted.lookup('8.8.8.8')?.asn).toBe(15169);
		expect(fetcher).toHaveBeenCalledTimes(1);

		await data.refresh(Date.now() + REFRESH_MS + 1000);
		expect(fetcher).toHaveBeenCalledTimes(2);
	});

	it('keeps what it has when a download fails, and tries again an hour later', async () => {
		const log = vi.fn();
		const fetcher = vi.fn(async () => new Response('nope', { status: 503 }));
		const data = new AsnData(dir(), URL, fetcher as unknown as typeof fetch, log);
		const now = Date.now();
		await data.refresh(now);
		expect(log).toHaveBeenCalledWith(expect.stringContaining('HTTP 503'));
		await data.refresh(now + 1000);
		expect(fetcher).toHaveBeenCalledTimes(1);

		// an empty file is refused too
		fetcher.mockImplementation(async () => new Response(gzipSync('')));
		await data.refresh(now + RETRY_MS);
		expect(log).toHaveBeenLastCalledWith(expect.stringContaining('no address ranges'));
		expect(data.table).toBeNull();
	});

	it('reads a local file, again only when it changes', async () => {
		const dataDir = dir();
		const file = path.join(dataDir, 'mirror.tsv');
		writeFileSync(file, TABLE);
		const data = new AsnData(dataDir, pathToFileURL(file).href);
		await data.refresh();
		expect(data.lookup('8.8.8.8')?.name).toBe('GOOGLE');
		const first = data.table;
		await data.refresh();
		expect(data.table).toBe(first);
		writeFileSync(file, '8.8.8.0\t8.8.8.255\t64512\tZZ\tMIRROR');
		utimesSync(file, new Date(), new Date(Date.now() + 5000));
		await data.refresh();
		expect(data.lookup('8.8.8.8')?.name).toBe('MIRROR');
	});

	it('does nothing when turned off', async () => {
		const fetcher = vi.fn();
		const data = new AsnData(dir(), null, fetcher as unknown as typeof fetch);
		await data.refresh();
		expect(fetcher).not.toHaveBeenCalled();
		expect(data.lookup('8.8.8.8')).toBeNull();
	});

	it('shares one refresh between callers', async () => {
		const fetcher = vi.fn(async () => ok());
		const data = new AsnData(dir(), URL, fetcher as unknown as typeof fetch);
		await Promise.all([data.refresh(), data.refresh()]);
		expect(fetcher).toHaveBeenCalledTimes(1);
	});
});

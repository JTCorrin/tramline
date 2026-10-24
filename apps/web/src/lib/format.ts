const units: [Intl.RelativeTimeFormatUnit, number][] = [
	['year', 31_536_000],
	['month', 2_592_000],
	['day', 86_400],
	['hour', 3_600],
	['minute', 60]
];

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

/** "3 minutes ago", "yesterday", … */
export function timeAgo(iso: string, now = Date.now()) {
	const seconds = Math.round((new Date(iso).getTime() - now) / 1000);
	for (const [unit, size] of units) {
		if (Math.abs(seconds) >= size) return relative.format(Math.round(seconds / size), unit);
	}
	return 'just now';
}

/** "512 B", "1.4 MB", … */
export function formatBytes(bytes: number) {
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	let value = bytes;
	let unit = 0;
	while (value >= 1000 && unit < units.length - 1) {
		value /= 1000;
		unit++;
	}
	return `${unit && value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

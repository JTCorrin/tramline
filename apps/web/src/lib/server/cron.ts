/**
 * Five-field cron expressions (minute hour day-of-month month day-of-week),
 * evaluated in UTC. Supports `*`, lists (`1,15`), ranges (`1-5`), steps
 * (`*\/15`, `0-30/10`) and the usual macros (`@hourly`, `@daily`…).
 */
export interface Cron {
	minutes: Set<number>;
	hours: Set<number>;
	days: Set<number>;
	months: Set<number>;
	weekdays: Set<number>;
	/** Both day fields restricted: a day matches if either does (standard cron). */
	eitherDay: boolean;
}

const MACROS: Record<string, string> = {
	'@hourly': '0 * * * *',
	'@daily': '0 0 * * *',
	'@midnight': '0 0 * * *',
	'@weekly': '0 0 * * 0',
	'@monthly': '0 0 1 * *',
	'@yearly': '0 0 1 1 *',
	'@annually': '0 0 1 1 *'
};

const FIELDS = [
	{ name: 'minute', min: 0, max: 59 },
	{ name: 'hour', min: 0, max: 23 },
	{ name: 'day of month', min: 1, max: 31 },
	{ name: 'month', min: 1, max: 12 },
	{ name: 'day of week', min: 0, max: 7 }
] as const;

function field(text: string, { name, min, max }: (typeof FIELDS)[number]) {
	const values = new Set<number>();
	for (const part of text.split(',')) {
		const [range, stepText] = part.split('/');
		const step = stepText === undefined ? 1 : Number(stepText);
		if (!Number.isInteger(step) || step < 1) throw new Error(`Invalid step in the ${name} field`);
		let [from, to] = [min, max] as number[];
		if (range !== '*') {
			const [a, b] = range!.split('-');
			from = Number(a);
			to = b === undefined ? (stepText === undefined ? from : max) : Number(b);
		}
		if (![from, to].every((n) => Number.isInteger(n) && n >= min && n <= max) || from! > to!) {
			throw new Error(`The ${name} field must be between ${min} and ${max}`);
		}
		for (let n = from!; n <= to!; n += step) values.add(n);
	}
	return values;
}

/** Parses an expression, throwing a readable error when it is invalid. */
export function parseCron(expression: string): Cron {
	const text = MACROS[expression.trim().toLowerCase()] ?? expression.trim();
	const parts = text.split(/\s+/);
	if (parts.length !== 5) throw new Error('A cron schedule has five fields, e.g. 0 * * * *');
	const [minutes, hours, days, months, weekdays] = parts.map((part, i) => field(part, FIELDS[i]!));
	// 7 is Sunday too
	if (weekdays!.delete(7)) weekdays!.add(0);
	return {
		minutes: minutes!,
		hours: hours!,
		days: days!,
		months: months!,
		weekdays: weekdays!,
		eitherDay: parts[2] !== '*' && parts[4] !== '*'
	};
}

export function matches(cron: Cron, at: Date) {
	if (!cron.minutes.has(at.getUTCMinutes()) || !cron.hours.has(at.getUTCHours())) return false;
	if (!cron.months.has(at.getUTCMonth() + 1)) return false;
	const day = cron.days.has(at.getUTCDate());
	const weekday = cron.weekdays.has(at.getUTCDay());
	return cron.eitherDay ? day || weekday : day && weekday;
}

/** The first matching minute strictly after `after`, searching up to a year ahead. */
export function nextRun(cron: Cron, after: Date): Date | null {
	const at = new Date(after);
	at.setUTCSeconds(0, 0);
	for (let i = 0; i < 366 * 24 * 60; i++) {
		at.setUTCMinutes(at.getUTCMinutes() + 1);
		if (matches(cron, at)) return new Date(at);
	}
	return null;
}

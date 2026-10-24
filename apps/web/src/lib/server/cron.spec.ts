import { describe, expect, it } from 'vitest';
import { matches, nextRun, parseCron } from './cron';

const at = (iso: string) => new Date(`${iso}Z`);

describe('parseCron', () => {
	it('expands lists, ranges, steps and macros', () => {
		expect([...parseCron('*/15 * * * *').minutes]).toEqual([0, 15, 30, 45]);
		expect([...parseCron('0 9-17/4 * * *').hours]).toEqual([9, 13, 17]);
		expect([...parseCron('5,10 * * * *').minutes]).toEqual([5, 10]);
		expect([...parseCron('30/10 * * * *').minutes]).toEqual([30, 40, 50]);
		expect([...parseCron('@daily').hours]).toEqual([0]);
		expect([...parseCron('0 0 * * 7').weekdays]).toEqual([0]);
	});

	it.each([
		['* * * *', 'A cron schedule has five fields, e.g. 0 * * * *'],
		['60 * * * *', 'The minute field must be between 0 and 59'],
		['* 5-2 * * *', 'The hour field must be between 0 and 23'],
		['*/0 * * * *', 'Invalid step in the minute field'],
		['* * 0 * *', 'The day of month field must be between 1 and 31'],
		['x * * * *', 'The minute field must be between 0 and 59']
	])('refuses %s', (expression, message) => {
		expect(() => parseCron(expression)).toThrow(message);
	});
});

describe('matches and nextRun', () => {
	it('finds the next minute in UTC', () => {
		const hourly = parseCron('0 * * * *');
		expect(nextRun(hourly, at('2026-10-24T09:00:00'))).toEqual(at('2026-10-24T10:00:00'));
		expect(nextRun(hourly, at('2026-10-24T09:59:30'))).toEqual(at('2026-10-24T10:00:00'));
		expect(nextRun(parseCron('*/5 * * * *'), at('2026-10-24T09:02:00'))).toEqual(
			at('2026-10-24T09:05:00')
		);
		expect(nextRun(parseCron('0 0 1 1 *'), at('2026-10-24T00:00:00'))).toEqual(
			at('2027-01-01T00:00:00')
		);
		// February 30th never comes
		expect(nextRun(parseCron('0 0 30 2 *'), at('2026-10-24T00:00:00'))).toBeNull();
	});

	it('matches either day field when both are restricted, as cron does', () => {
		// the 1st of the month, or any Monday
		const cron = parseCron('0 12 1 * 1');
		expect(matches(cron, at('2026-11-01T12:00:00'))).toBe(true); // a Sunday, the 1st
		expect(matches(cron, at('2026-10-26T12:00:00'))).toBe(true); // a Monday
		expect(matches(cron, at('2026-10-27T12:00:00'))).toBe(false);
		// one restricted: both must hold
		expect(matches(parseCron('0 12 * * 1'), at('2026-11-01T12:00:00'))).toBe(false);
		expect(matches(parseCron('0 12 * 11 *'), at('2026-10-26T12:00:00'))).toBe(false);
	});
});

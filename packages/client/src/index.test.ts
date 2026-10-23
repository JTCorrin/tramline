import { describe, expect, it, vi } from 'vitest';
import { ApiError, createClient } from './index';

function mockFetch(status: number, body: unknown) {
	return vi.fn<typeof fetch>(
		async () =>
			new Response(status === 204 ? null : JSON.stringify(body), {
				status,
				headers: { 'content-type': 'application/json' }
			})
	);
}

describe('createClient', () => {
	it('maps getAll/get/create/update/remove onto REST calls', async () => {
		const fetch = mockFetch(200, { id: 'prj_1' });
		const client = createClient({ baseUrl: '/api/v1/', fetch });

		await client.projects.getAll();
		await client.projects.get('prj_1');
		await client.projects.create({ name: 'Demo' });
		await client.projects.update('prj_1', { name: 'Renamed' });
		await client.projects.remove('prj_1');

		const calls = fetch.mock.calls.map(([url, init]) => [init?.method, url, init?.body]);
		expect(calls).toEqual([
			['GET', '/api/v1/projects', undefined],
			['GET', '/api/v1/projects/prj_1', undefined],
			['POST', '/api/v1/projects', JSON.stringify({ name: 'Demo' })],
			['PATCH', '/api/v1/projects/prj_1', JSON.stringify({ name: 'Renamed' })],
			['DELETE', '/api/v1/projects/prj_1', undefined]
		]);
	});

	it('sends a bearer token when configured', async () => {
		const fetch = mockFetch(200, []);
		await createClient({
			baseUrl: 'https://t.example/api/v1',
			fetch,
			token: 'tok'
		}).projects.getAll();

		const headers = fetch.mock.calls[0]?.[1]?.headers as Record<string, string>;
		expect(headers.authorization).toBe('Bearer tok');
	});

	it('returns undefined for 204 responses', async () => {
		const client = createClient({ baseUrl: '/api/v1', fetch: mockFetch(204, null) });
		await expect(client.projects.remove('prj_1')).resolves.toBeUndefined();
	});

	it('throws ApiError with the error envelope', async () => {
		const fetch = mockFetch(422, {
			error: {
				code: 'validation_failed',
				message: 'Invalid input',
				issues: [{ path: 'name', message: 'Name is required' }]
			}
		});
		const client = createClient({ baseUrl: '/api/v1', fetch });

		const error = await client.projects.create({ name: '' }).catch((e) => e);
		expect(error).toBeInstanceOf(ApiError);
		expect(error).toMatchObject({
			status: 422,
			code: 'validation_failed',
			issues: [{ path: 'name', message: 'Name is required' }]
		});
	});

	it('falls back to a generic error when the body is not an envelope', async () => {
		const client = createClient({ baseUrl: '/api/v1', fetch: mockFetch(502, 'bad gateway') });
		await expect(client.projects.getAll()).rejects.toMatchObject({ status: 502, code: 'internal' });
	});
});

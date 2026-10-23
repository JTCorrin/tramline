import { describe, expect, it } from 'vitest';
import { CSP_DIRECTIVES, securityHeaders } from './security';

describe('securityHeaders', () => {
	it('sets the baseline headers, and HSTS only over HTTPS', () => {
		const http = securityHeaders(new URL('http://localhost:5173/'));
		expect(http).toMatchObject({
			'x-content-type-options': 'nosniff',
			'x-frame-options': 'DENY',
			'referrer-policy': 'strict-origin-when-cross-origin'
		});
		expect(http).not.toHaveProperty('strict-transport-security');
		expect(securityHeaders(new URL('https://tramline.example.com/'))).toHaveProperty(
			'strict-transport-security',
			'max-age=31536000; includeSubDomains'
		);
	});

	it('never allows inline or eval scripts, framing or plugins', () => {
		expect(CSP_DIRECTIVES['script-src']).not.toContain('unsafe-inline');
		expect(CSP_DIRECTIVES['script-src']).not.toContain('unsafe-eval');
		expect(CSP_DIRECTIVES['frame-ancestors']).toEqual(['none']);
		expect(CSP_DIRECTIVES['object-src']).toEqual(['none']);
	});
});

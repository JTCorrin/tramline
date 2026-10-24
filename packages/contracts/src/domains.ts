import { z } from 'zod';

/** A hostname: lowercase labels of letters, digits and hyphens, with a dot. */
export const Hostname = z
	.string()
	.trim()
	.toLowerCase()
	.transform((value) => value.replace(/\.$/, ''))
	.pipe(
		z
			.string()
			.max(253)
			.regex(
				/^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/,
				'Enter a domain like app.example.com'
			)
			.refine((value) => !/^\d+(\.\d+){3}$/.test(value), 'Use a domain name, not an IP address')
	);

/**
 * A domain of the user's that serves a service. Ownership is proven with a
 * TXT record before any traffic is routed to it.
 */
export const CustomDomain = z.object({
	id: z.string(),
	serviceId: z.string(),
	environmentId: z.string(),
	hostname: z.string(),
	status: z.enum(['pending', 'verified']),
	/** The TXT record that proves ownership. */
	verification: z.object({ name: z.string(), value: z.string() }),
	/** Where the CNAME should point: the service's generated domain, once it has one. */
	target: z.string().nullable(),
	/** Why the last check didn't verify it. */
	error: z.string().nullable(),
	checkedAt: z.iso.datetime().nullable(),
	verifiedAt: z.iso.datetime().nullable()
});

export type CustomDomain = z.infer<typeof CustomDomain>;

export const AddCustomDomain = z.object({
	serviceId: z.string(),
	environmentId: z.string(),
	hostname: Hostname
});

export type AddCustomDomain = z.input<typeof AddCustomDomain>;

export type CustomDomainQuery = { serviceId: string; environmentId: string };

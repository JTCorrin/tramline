import { z } from 'zod';

export const GitHubInstallation = z.object({
	id: z.string(),
	account: z.string(),
	accountType: z.string(),
	/** Where to change which repositories it can access. */
	htmlUrl: z.string()
});

export type GitHubInstallation = z.infer<typeof GitHubInstallation>;

export const GitHubStatus = z.object({
	/** The install's GitHub App, once created. */
	app: z.object({ name: z.string(), slug: z.string(), htmlUrl: z.string() }).nullable(),
	/** Installations connected to the caller's organization. */
	installations: z.array(GitHubInstallation),
	/** Whether GitHub can reach this install for webhooks; otherwise Tramline polls. */
	webhooks: z.boolean(),
	/** Owners and admins can connect GitHub. */
	canManage: z.boolean()
});

export type GitHubStatus = z.infer<typeof GitHubStatus>;

export const GitHubRepo = z.object({
	installationId: z.string(),
	fullName: z.string(),
	private: z.boolean(),
	defaultBranch: z.string(),
	/** https URL used as the service's repository. */
	url: z.string()
});

export type GitHubRepo = z.infer<typeof GitHubRepo>;

/** A form the browser posts to GitHub to create the app from a manifest. */
export const GitHubManifestForm = z.object({ action: z.string(), manifest: z.string() });
export type GitHubManifestForm = z.infer<typeof GitHubManifestForm>;

import type { GitHubManifestForm, GitHubRepo, GitHubStatus } from '@tramline/contracts';
import type { Http } from '../http';

export const github = (http: Http) => ({
	status: () => http.get<GitHubStatus>('/github'),
	/** The form to post to GitHub to create the app (sets a CSRF cookie). */
	manifest: (owner?: string | null) => http.post<GitHubManifestForm>('/github/manifest', { owner }),
	repos: () => http.get<GitHubRepo[]>('/github/repos'),
	disconnect: (installationId: string) =>
		http.delete<void>(`/github/installations/${installationId}`)
});

import type { Http, Query } from './http';

export interface Resource<T, Create, Update, ListQuery extends Query | void = void> {
	getAll(query?: ListQuery): Promise<T[]>;
	get(id: string): Promise<T>;
	create(input: Create): Promise<T>;
	update(id: string, patch: Update): Promise<T>;
	remove(id: string): Promise<void>;
}

/**
 * Standard CRUD over a REST collection. Resources needing extra verbs
 * (e.g. `deploy`, `rollback`) spread this and add their own methods.
 */
export function defineResource<T, Create, Update, ListQuery extends Query | void = void>(
	path: string
) {
	return (http: Http): Resource<T, Create, Update, ListQuery> => ({
		getAll: (query) => http.get<T[]>(path, query ?? undefined),
		get: (id) => http.get<T>(`${path}/${encodeURIComponent(id)}`),
		create: (input) => http.post<T>(path, input),
		update: (id, patch) => http.patch<T>(`${path}/${encodeURIComponent(id)}`, patch),
		remove: (id) => http.delete<void>(`${path}/${encodeURIComponent(id)}`)
	});
}

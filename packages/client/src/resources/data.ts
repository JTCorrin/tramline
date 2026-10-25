import type { DataRows, DataTable } from '@tramline/contracts';
import type { Http } from '../http';

/** The read-only Postgres data browser. */
export const data = (http: Http) => ({
	tables: (query: { serviceId: string; environmentId: string }) =>
		http.get<DataTable[]>('/data/tables', query),
	rows: (query: {
		serviceId: string;
		environmentId: string;
		schema: string;
		table: string;
		offset?: number;
	}) =>
		http.get<DataRows>('/data/rows', {
			...query,
			offset: String(query.offset ?? 0)
		})
});

import type { StageVariables, Variable, VariableQuery } from '@tramline/contracts';
import type { Http } from '../http';

export const variables = (http: Http) => ({
	/** Omit `serviceId` for the environment's shared variables. */
	getAll: (query: VariableQuery) => http.get<Variable[]>('/variables', query),
	/** Stages sets and unsets; returns the updated list. */
	stage: (input: StageVariables) => http.patch<Variable[]>('/variables', input)
});

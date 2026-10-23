import { ID_PREFIXES, type IdKind } from '@tramline/contracts';
import { ulid } from 'ulid';

/** Creates a prefixed ULID, e.g. `newId('project')` → `prj_01JB8Z…`. */
export function newId(kind: IdKind) {
	return `${ID_PREFIXES[kind]}_${ulid().toLowerCase()}`;
}

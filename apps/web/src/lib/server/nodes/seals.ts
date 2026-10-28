/**
 * Bumped whenever a variable is sealed, so cached log redactors are rebuilt
 * and a newly sealed value is masked from the next log line on.
 */
let version = 0;

export const sealVersion = () => version;
export const sealsChanged = () => {
	version++;
};

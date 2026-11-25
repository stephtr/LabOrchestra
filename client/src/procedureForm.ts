/** The form of a procedure: what its parameters offer (the server's description), what the user typed, and the parameters of the run. Pure, tested. */
export type ProcedureParam = { name: string; type: 'bool' | 'int' | 'float' | 'str' | 'list' | 'json'; items?: string; default: unknown; required: boolean; doc: string | null };
export type Procedure = { name: string; title: string; doc: string | null; devices: string[]; /** events that start it by itself */ on?: string[]; params: ProcedureParam[]; file: string };
/** A file of procedures/ that could not be loaded is listed with its error instead. */
export type ProcedureListing = Procedure | { file: string; error: string; name?: undefined };
export type FormValues = Record<string, string | boolean>;

export function initialValues(params: ProcedureParam[]): FormValues {
	return Object.fromEntries(
		params.map((p) => {
			if (p.type === 'bool') return [p.name, Boolean(p.default)];
			if (p.default === null || p.default === undefined) return [p.name, ''];
			return [p.name, p.type === 'list' && Array.isArray(p.default) ? p.default.join(', ') : p.type === 'json' ? JSON.stringify(p.default) : String(p.default)];
		}),
	);
}

function number(text: string, whole: boolean): number {
	const n = Number(text.replace(',', '.'));
	if (!Number.isFinite(n)) throw new Error('must be a number');
	if (whole && !Number.isInteger(n)) throw new Error('must be a whole number');
	return n;
}

/** The parameters to send: a field left empty is left out (the procedure's default applies, or it is an error when the parameter is required). A
 *  value equal to the default is sent as it is: what was run is then in the record of the run. */
export function buildParams(params: ProcedureParam[], values: FormValues): { params: Record<string, unknown>; errors: Record<string, string> } {
	const result: Record<string, unknown> = {};
	const errors: Record<string, string> = {};
	for (const p of params) {
		const raw = values[p.name];
		try {
			if (p.type === 'bool') {
				result[p.name] = raw === true;
				continue;
			}
			const text = String(raw ?? '').trim();
			if (text === '') {
				if (p.required) throw new Error('is required');
				continue;
			}
			if (p.type === 'int' || p.type === 'float') result[p.name] = number(text, p.type === 'int');
			else if (p.type === 'str') result[p.name] = text;
			else if (p.type === 'list') {
				const parts = text.split(/[,;\n]/).map((x) => x.trim()).filter((x) => x !== '');
				result[p.name] = p.items === 'str' || p.items === 'json' ? parts : p.items === 'bool' ? parts.map((x) => /^(true|yes|1)$/i.test(x)) : parts.map((x) => number(x, p.items === 'int'));
			} else {
				try {
					result[p.name] = JSON.parse(text);
				} catch {
					throw new Error('must be JSON');
				}
			}
		} catch (e) {
			errors[p.name] = (e as Error).message;
		}
	}
	return { params: result, errors };
}

/** "3 min 12 s", "45 s", "1 h 02 min". */
export function duration(seconds: number): string {
	const s = Math.max(0, Math.round(seconds));
	if (s < 60) return `${s} s`;
	if (s < 3600) return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`;
	return `${Math.floor(s / 3600)} h ${String(Math.floor(s / 60) % 60).padStart(2, '0')} min`;
}

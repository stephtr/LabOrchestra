/** Settings of a widget instance ("props"): what a widget declares, what the user types, and what ends up in the view. Pure, so it is tested. */
export type PropSpec = {
	name: string;
	label?: string;
	type: 'text' | 'number' | 'integer' | 'boolean' | 'select';
	/** What the widget uses when the prop is not set. */
	default?: unknown;
	options?: string[];
	min?: number;
	max?: number;
	help?: string;
};

/** Every widget can be given a label. */
export const LABEL: PropSpec = { name: 'label', label: 'Label', type: 'text', help: 'Shown in the widget; empty: the default' };

export type Values = Record<string, string | boolean>;

export function initialValues(specs: PropSpec[], props: Record<string, unknown> | undefined): Values {
	return Object.fromEntries(
		specs.map((s) => {
			const value = props?.[s.name] ?? s.default;
			return [s.name, s.type === 'boolean' ? Boolean(value) : value === undefined || value === null ? '' : String(value)];
		}),
	);
}

/** The props for the view: what was typed, checked against the specs. A value that equals the default or is empty is left out; props the
 *  specs do not mention (set by the picker, or by an older version of the widget) are kept as they are. */
export function buildProps(specs: PropSpec[], values: Values, existing: Record<string, unknown> | undefined): { props: Record<string, unknown>; errors: Record<string, string> } {
	const props: Record<string, unknown> = { ...existing };
	const errors: Record<string, string> = {};
	for (const spec of specs) {
		const raw = values[spec.name];
		delete props[spec.name];
		if (spec.type === 'boolean') {
			if (raw === true && spec.default !== true) props[spec.name] = true;
			else if (raw === false && spec.default === true) props[spec.name] = false;
			continue;
		}
		const text = String(raw ?? '').trim();
		if (text === '') continue;
		if (spec.type === 'number' || spec.type === 'integer') {
			const number = Number(text);
			if (!Number.isFinite(number)) errors[spec.name] = 'must be a number';
			else if (spec.type === 'integer' && !Number.isInteger(number)) errors[spec.name] = 'must be a whole number';
			else if (spec.min !== undefined && number < spec.min) errors[spec.name] = `must be at least ${spec.min}`;
			else if (spec.max !== undefined && number > spec.max) errors[spec.name] = `must be at most ${spec.max}`;
			else if (number !== spec.default) props[spec.name] = number;
		} else if (spec.type === 'select') {
			if (!spec.options?.includes(text)) errors[spec.name] = `must be one of ${spec.options?.join(', ')}`;
			else if (text !== spec.default) props[spec.name] = text;
		} else if (text !== spec.default) props[spec.name] = text;
	}
	return { props, errors };
}

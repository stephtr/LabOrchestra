/** The unit of a state field, from the schema's units ("channels.*.pressure": "mbar"); a list index in the path stands for any index. */
export function unitFor(units: Record<string, string> | undefined, path: string): string | undefined {
	if (!units) return undefined;
	return units[path] ?? units[path.replace(/(^|\.)\d+(?=\.|$)/g, '$1*')];
}

export function formatNumber(value: number): string {
	if (value === 0 || !Number.isFinite(value)) return String(value);
	const abs = Math.abs(value);
	if (abs >= 1e5 || abs < 1e-3) return value.toExponential(2);
	return String(Number(value.toPrecision(5)));
}

const SI_PREFIX: Record<string, number> = { '': 1, k: 1e3, K: 1e3, M: 1e6, G: 1e9 };

/** "867 kHz", "1.5MHz", "2e6" or "100" (Hz) -> Hz; NaN if it is not a frequency. */
export function parseFrequency(text: string): number {
	const match = /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*([kKMG]?)(?:Hz)?\s*$/.exec(text.replace(',', '.'));
	if (!match) return NaN;
	return Number(match[1]) * SI_PREFIX[match[2]!]!;
}

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

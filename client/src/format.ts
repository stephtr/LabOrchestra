export function formatNumber(value: number): string {
	if (value === 0 || !Number.isFinite(value)) return String(value);
	const abs = Math.abs(value);
	if (abs >= 1e5 || abs < 1e-3) return value.toExponential(2);
	return String(Number(value.toPrecision(5)));
}

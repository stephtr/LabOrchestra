/** The numbers behind a trace widget: summary of a history, a trend, nice axis ticks. Pure, so it is tested. */
export type Point = [time: number, value: number];

export const RANGES = { '1h': 3600, '6h': 6 * 3600, '24h': 24 * 3600, '7d': 7 * 24 * 3600 } as const;
export type RangeName = keyof typeof RANGES;

/** The points that can be drawn: finite, and positive on a logarithmic axis. */
export function drawable(points: Point[], log: boolean): Point[] {
	return points.filter(([t, v]) => Number.isFinite(t) && Number.isFinite(v) && (!log || v > 0));
}

export type Summary = { min: number; max: number; last: number; /** change per hour (a factor per hour on a log axis), from the last hour; null without enough data */ trend: number | null };

export function summarize(points: Point[], log: boolean): Summary | null {
	const p = drawable(points, log);
	if (p.length === 0) return null;
	let min = Infinity;
	let max = -Infinity;
	for (const [, v] of p) {
		min = Math.min(min, v);
		max = Math.max(max, v);
	}
	const [tLast, last] = p[p.length - 1]!;
	// the last hour, or the whole series when it is shorter: the first point at least 5 minutes before the end
	const from = p.find(([t]) => t >= tLast - 3600);
	let trend: number | null = null;
	if (from && tLast - from[0] >= 300) {
		const hours = (tLast - from[0]) / 3600;
		trend = log ? Math.pow(last / from[1], 1 / hours) : (last - from[1]) / hours;
	}
	return { min, max, last, trend };
}

/** 10 to the power e, exactly (`10 ** -7` is not exactly 1e-7 on every JavaScript engine). */
const pow10 = (e: number) => Number(`1e${e}`);

/** Round numbers between min and max for an axis (about `count` of them). */
export function niceTicks(min: number, max: number, count: number): number[] {
	const span = max - min;
	if (!(span > 0)) return [min];
	const rough = span / count;
	const base = pow10(Math.floor(Math.log10(rough)));
	const step = [1, 2, 5, 10].map((m) => m * base).find((s) => s >= rough) ?? rough;
	const ticks: number[] = [];
	for (let t = Math.ceil(min / step) * step; t <= max + step * 1e-9; t += step) ticks.push(Number(t.toPrecision(12)));
	return ticks;
}

/** Powers of ten between min and max (for a logarithmic axis); at least the two around the range. */
export function decadeTicks(min: number, max: number): number[] {
	const lo = Math.floor(Math.log10(min));
	const hi = Math.ceil(Math.log10(max));
	const ticks: number[] = [];
	for (let e = lo; e <= hi; e++) ticks.push(pow10(e));
	return ticks;
}

/** The value range of the axis: the data with a margin (linear), or the surrounding decades' extent (log). A flat series gets a range around it. */
export function axisRange(min: number, max: number, log: boolean): [number, number] {
	if (log) {
		const [lo, hi] = [Math.log10(min), Math.log10(max)];
		const pad = Math.max(0.1, (hi - lo) * 0.1);
		return [10 ** (lo - pad), 10 ** (hi + pad)];
	}
	const pad = max > min ? (max - min) * 0.1 : Math.max(Math.abs(max) * 0.05, 1e-9);
	return [min - pad, max + pad];
}

/** What to draw for a history. The server records a field when it changes, so a value that does not change has a single point (or none in the
 *  range): the last value is held up to `now`, and with no point at all the live value stands for the whole range. The axis starts at the first
 *  point when the history is shorter than the range, so that a new curve fills the widget. */
export function drawSeries(points: Point[], live: number | null, now: number, rangeSeconds: number, log: boolean): { data: Point[]; from: number } {
	const p = drawable(points, log);
	const usable = live !== null && Number.isFinite(live) && (!log || live > 0);
	const start = now - rangeSeconds;
	if (p.length === 0) return usable ? { data: [[start, live], [now, live]], from: start } : { data: [], from: start };
	const data: Point[] = [...p];
	const last = data[data.length - 1]!;
	data.push([now, usable ? live : last[1]]);
	return { data, from: Math.max(start, data[0]![0]) };
}

/** Ticks of a logarithmic axis: the powers of ten inside the range, or round numbers when the range is narrower than a decade. */
export function logTicks(lo: number, hi: number, count: number): number[] {
	const decades = decadeTicks(lo, hi).filter((v) => v >= lo && v <= hi);
	return decades.length >= 2 ? decades : niceTicks(lo, hi, count);
}

/** "46 s ago", "3 min ago", "2 h ago". */
export function ago(seconds: number): string {
	if (seconds < 5) return 'just now';
	if (seconds < 90) return `${Math.round(seconds)} s ago`;
	if (seconds < 5400) return `${Math.round(seconds / 60)} min ago`;
	return `${Math.round(seconds / 3600)} h ago`;
}

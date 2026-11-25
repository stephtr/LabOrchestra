import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import { formatNumber, unitFor } from './format';
import { getPath } from './generic';
import { formatSI } from './OscilloscopeWidget';
import { ago, axisRange, logTicks, niceTicks, Point, RANGES, RangeName, drawSeries, summarize } from './trace';
import type { WidgetProps } from './widgets';

const REFRESH_MS = 15_000;
/** A time on the axis: with the date when the span is days, with seconds when it is minutes. */
const clock = (t: number, span: number) => {
	const d = new Date(t * 1000);
	const time = d.toLocaleTimeString([], span < 900 ? { hour: '2-digit', minute: '2-digit', second: '2-digit' } : { hour: '2-digit', minute: '2-digit' });
	return span > 2 * 86400 ? `${d.toLocaleDateString([], { day: 'numeric', month: 'numeric' })} ${time}` : time;
};

/** The history of a state field of a device: the value now, how it changes, and the curve of the last hours (from the server's history, which it
 *  keeps for every numeric field, also while nothing is recording). In the strip it is a card with a sparkline, in a pane it has axes. */
export function TraceWidget({ device, info, props }: WidgetProps) {
	const path = String(props.path ?? '');
	const range = (props.range as RangeName) in RANGES ? (props.range as RangeName) : '6h';
	const log = props.scale === 'log';
	const [points, setPoints] = useState<Point[] | null>(null);
	const [problem, setProblem] = useState<string | null>(null);
	const [now, setNow] = useState(() => Date.now() / 1000);
	const box = useRef<HTMLDivElement>(null);
	const [size, setSize] = useState({ width: 0, height: 0 });

	useEffect(() => {
		let current = true;
		const load = async () => {
			try {
				const until = Date.now() / 1000;
				const data = await api.history(device, path, until - RANGES[range], until, 600);
				if (!current) return;
				setPoints(data as Point[]);
				setNow(until);
				setProblem(null);
			} catch (e) {
				if (current) setProblem(e instanceof Error ? e.message : String(e));
			}
		};
		void load();
		const timer = setInterval(load, REFRESH_MS);
		return () => {
			current = false;
			clearInterval(timer);
		};
	}, [device, path, range]);

	useEffect(() => {
		const element = box.current;
		if (!element) return;
		const observer = new ResizeObserver(([entry]) => entry && setSize({ width: entry.contentRect.width, height: entry.contentRect.height }));
		observer.observe(element);
		return () => observer.disconnect();
	}, []);

	const live = getPath(info.state, path);
	const unit = unitFor(info.schema?.units, path) ?? '';
	const shown = (v: number, withUnit = true) => (unit === 'Hz' ? formatSI(v, 'Hz') : `${formatNumber(v)}${unit && withUnit ? ` ${unit}` : ''}`);
	const label = typeof props.label === 'string' && props.label ? props.label : `${device} · ${path.replaceAll('_', ' ')}`;
	const { data, from: t0 } = drawSeries(points ?? [], typeof live === 'number' ? live : null, now, RANGES[range], log);
	const summary = summarize(data, log);
	const full = size.height >= 170; // a pane: with axes; the strip: a card
	const left = full ? 56 : 0;
	const bottom = full ? 22 : 0;
	const width = Math.max(0, size.width - left - (full ? 12 : 0));
	const height = Math.max(0, size.height - bottom - (full ? 8 : 0));

	let curve: React.ReactNode = null;
	if (data.length >= 2 && summary && width > 20 && height > 10) {
		const [lo, hi] = axisRange(summary.min, summary.max, log);
		const span = Math.max(1, now - t0);
		const x = (t: number) => ((t - t0) / span) * width;
		const scale = (v: number) => (log ? (Math.log10(v) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo)) : (v - lo) / (hi - lo));
		const y = (v: number) => height - scale(v) * height;
		const line = data.map(([t, v], i) => `${i ? 'L' : 'M'}${x(t).toFixed(1)},${y(v).toFixed(1)}`).join('');
		const [xl, yl] = [x(data[data.length - 1]![0]), y(data[data.length - 1]![1])];
		const yTicks = (log ? logTicks : niceTicks)(lo, hi, Math.max(2, Math.floor(height / 40)));
		const xTicks = niceTicks(0, 1, Math.max(2, Math.floor(width / 90))).map((f) => t0 + f * span);
		curve = (
			<svg data-testid={`trace-svg-${device}-${path}`} data-points={data.length} width={size.width} height={size.height} className="block overflow-visible text-accent">
				<defs>
					<linearGradient id={`fade-${device}-${path}`} x1="0" y1="0" x2="0" y2="1">
						<stop offset="0" stopColor="currentColor" stopOpacity="0.28" />
						<stop offset="1" stopColor="currentColor" stopOpacity="0" />
					</linearGradient>
				</defs>
				<g transform={`translate(${left},${full ? 8 : 0})`}>
					{full && yTicks.map((v) => (
						<g key={v}>
							<line x1={0} x2={width} y1={y(v)} y2={y(v)} className="stroke-line" strokeDasharray="2 4" />
							<text x={-8} y={y(v) + 4} textAnchor="end" className="fill-faint text-[10px]">{log && Number.isInteger(Math.log10(v)) ? v.toExponential(0).replace('e-', 'e−').replace('e+', 'e') : formatNumber(v)}</text>
						</g>
					))}
					{full && xTicks.map((t) => <text key={t} x={x(t)} y={height + 16} textAnchor={x(t) > width - 36 ? 'end' : x(t) < 36 ? 'start' : 'middle'} className="fill-faint text-[10px]">{clock(t, span)}</text>)}
					<path d={`${line}L${x(data[data.length - 1]![0]).toFixed(1)},${height}L${x(data[0]![0]).toFixed(1)},${height}Z`} fill={`url(#fade-${device}-${path})`} stroke="none" />
					<path d={line} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
					<circle cx={xl} cy={yl} r={3} fill="currentColor" />
				</g>
			</svg>
		);
	}

	const trend = summary?.trend;
	const trendText =
		trend == null ? null : log ? `× ${trend.toPrecision(2)} / h` : `${trend >= 0 ? '+' : '−'}${formatNumber(Math.abs(trend))}${unit ? ` ${unit}` : ''} / h`;
	const lastTime = points?.length ? points[points.length - 1]![0] : null;
	return (
		<div data-testid={`trace-${device}-${path}`} title={problem ?? undefined} className={`@container flex h-full min-h-0 flex-col gap-1 rounded-lg border bg-panel px-3 py-2 ${problem ? 'border-warn' : 'border-line'}`}>
			<div className="flex flex-none items-baseline gap-2">
				<span className="min-w-0 flex-1 truncate text-xs text-muted">{label}</span>
				<span className="flex-none text-xs text-faint">{lastTime != null ? ago(now - lastTime) : ''}</span>
			</div>
			<div className="flex flex-none items-center gap-x-3">
				<span data-testid={`trace-value-${device}-${path}`} className="whitespace-nowrap text-2xl leading-8 tabular-nums @max-[340px]:text-xl">
					{typeof live === 'number' ? shown(live) : summary ? shown(summary.last) : '—'}
				</span>
				<span className="flex-1" />
				{summary && (
					<span className="flex min-w-0 flex-col items-end whitespace-nowrap text-xs leading-4 tabular-nums">
						{trendText && <span className="max-w-full truncate text-muted" title="Change in the last hour">{trendText}</span>}
						{/* short enough for the narrowest card: the unit is the one of the value beside it; the words are in the tooltip */}
						<span data-testid={`trace-range-${device}-${path}`} className="max-w-full truncate text-faint" title={`Lowest ${shown(summary.min)} and highest ${shown(summary.max)} in the shown range`}>
							{shown(summary.min, false)} – {shown(summary.max, false)}
						</span>
					</span>
				)}
			</div>
			<div ref={box} className="min-h-0 flex-1">
				{curve ?? <span className="text-xs text-faint">{problem ? 'No history available' : points === null ? 'Loading…' : 'No numeric value yet'}</span>}
			</div>
		</div>
	);
}

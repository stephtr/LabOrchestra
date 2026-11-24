import { useEffect, useRef, useState } from 'react';
import { callAction, DeviceInfo } from './store';
import { StreamFrame, subscribeStream, StreamSubscription } from './stream';

const COLORS = ['#3b82f6', '#ef4444', '#22c55e', '#f59e0b'];
const FFT_LENGTHS = Array.from({ length: 12 }, (_, i) => 2 ** (i + 9));
const WINDOWS = ['rectangular', 'hann', 'blackman', 'nuttall', 'blackman-nuttall'];
const AVERAGING = [0, 50, 100, 200, 500, 1000, 2000, 5000, 10000, -1];
const RANGES = [50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
const SELECT = 'rounded border border-zinc-300 bg-transparent px-1 py-0.5 text-sm dark:border-slate-700';

/** 1.5e6 -> "1.5 MHz", 2e-4 -> "200 µs" */
export function formatSI(value: number, unit: string): string {
	if (value === 0 || !Number.isFinite(value)) return `${value} ${unit}`;
	const prefixes = ['p', 'n', 'µ', 'm', '', 'k', 'M', 'G'];
	const exponent = Math.max(-4, Math.min(3, Math.floor(Math.log10(Math.abs(value)) / 3)));
	const scaled = value / 10 ** (exponent * 3);
	return `${Number(scaled.toPrecision(4))} ${prefixes[exponent + 4]}${unit}`;
}

function niceTicks(min: number, max: number, count: number): number[] {
	const span = max - min;
	if (!(span > 0)) return [min];
	const rough = span / count;
	const base = 10 ** Math.floor(Math.log10(rough));
	const step = [1, 2, 5, 10].map((m) => m * base).find((s) => s >= rough) ?? rough;
	const ticks: number[] = [];
	for (let t = Math.ceil(min / step) * step; t <= max + step * 1e-9; t += step) ticks.push(t);
	return ticks;
}

function draw(canvas: HTMLCanvasElement, frame: StreamFrame, view: { min: number; max: number } | null) {
	const ratio = window.devicePixelRatio || 1;
	const width = canvas.clientWidth;
	const height = canvas.clientHeight;
	if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
		canvas.width = Math.round(width * ratio);
		canvas.height = Math.round(height * ratio);
	}
	const context = canvas.getContext('2d')!;
	context.setTransform(ratio, 0, 0, ratio, 0, 0);
	context.fillStyle = '#05070d';
	context.fillRect(0, 0, width, height);

	const { meta, data } = frame;
	const channels: number[] = meta.channels;
	const length: number = meta.length;
	const isFft = meta.mode === 'fft';
	const left = 62, right = 10, top = 8, bottom = 24;
	const plotW = width - left - right;
	const plotH = height - top - bottom;
	const xMin: number = view?.min ?? meta.x_min_decimated;
	const xMax: number = view?.max ?? meta.x_max_decimated;
	let yMin = Infinity, yMax = -Infinity;
	for (let i = 0; i < data.length; i++) {
		const v = data[i]!;
		if (v < yMin) yMin = v;
		if (v > yMax) yMax = v;
	}
	if (!(yMax > yMin)) [yMin, yMax] = [yMin - 1, yMax + 1];
	const pad = 0.05 * (yMax - yMin);
	[yMin, yMax] = [yMin - pad, yMax + pad];

	context.font = '11px ui-sans-serif, system-ui, sans-serif';
	context.strokeStyle = '#1f2937';
	context.fillStyle = '#9ca3af';
	context.lineWidth = 1;
	for (const t of niceTicks(xMin, xMax, 8)) {
		const x = left + ((t - xMin) / (xMax - xMin)) * plotW;
		context.beginPath(); context.moveTo(x, top); context.lineTo(x, top + plotH); context.stroke();
		context.textAlign = 'center';
		context.fillText(formatSI(t, isFft ? 'Hz' : 's'), x, height - 8);
	}
	for (const t of niceTicks(yMin, yMax, 6)) {
		const y = top + plotH - ((t - yMin) / (yMax - yMin)) * plotH;
		context.beginPath(); context.moveTo(left, y); context.lineTo(left + plotW, y); context.stroke();
		context.textAlign = 'right';
		context.fillText(isFft ? `${Number(t.toPrecision(4))} dB` : formatSI(t, 'V'), left - 6, y + 4);
	}
	const dx = (meta.x_max_decimated - meta.x_min_decimated) / Math.max(1, length - 1);
	context.save();
	context.beginPath();
	context.rect(left, top, plotW, plotH);
	context.clip();
	channels.forEach((channel, row) => {
		context.strokeStyle = COLORS[channel % COLORS.length]!;
		context.lineWidth = 1.2;
		context.beginPath();
		for (let i = 0; i < length; i++) {
			const x = left + ((meta.x_min_decimated + i * dx - xMin) / (xMax - xMin)) * plotW;
			const y = top + plotH - ((data[row * length + i]! - yMin) / (yMax - yMin)) * plotH;
			if (i === 0) context.moveTo(x, y); else context.lineTo(x, y);
		}
		context.stroke();
	});
	context.restore();
	context.strokeStyle = '#374151';
	context.strokeRect(left, top, plotW, plotH);
}

/** The oscilloscope: spectrum or time trace from the display stream, with the controls of the instrument. */
export function OscilloscopeWidget({ id, info }: { id: string; info: DeviceInfo }) {
	const state = (info.state ?? {}) as Record<string, any>;
	const ready = info.status === 'ready';
	const canvas = useRef<HTMLCanvasElement>(null);
	const stream = useRef<StreamSubscription | null>(null);
	const lastFrame = useRef<StreamFrame | null>(null);
	const frames = useRef(0);
	const counter = useRef<HTMLSpanElement>(null);
	const range = useRef<HTMLSpanElement>(null);
	const [view, setView] = useState<{ min: number; max: number } | null>(null);
	const viewRef = useRef(view);
	viewRef.current = view;
	const [error, setError] = useState<string | null>(null);

	const call = (action: string, ...args: unknown[]) => callAction(id, action, args).then(() => setError(null), (e: Error) => setError(e.message));

	useEffect(() => {
		if (!ready) return;
		const subscription = subscribeStream(id, 'display', {}, (frame) => {
			lastFrame.current = frame;
			frames.current += 1;
			const el = canvas.current;
			if (!el) return;
			draw(el, frame, viewRef.current);
			el.dataset.mode = frame.meta.mode;
			el.dataset.channels = frame.meta.channels.join(',');
			el.dataset.fftLength = String(frame.meta.fft_length);
			el.dataset.length = String(frame.meta.length);
			if (counter.current) counter.current.textContent = String(frames.current);
			if (range.current) range.current.textContent = `${formatSI(viewRef.current?.min ?? frame.meta.x_min_decimated, frame.meta.mode === 'fft' ? 'Hz' : 's')} to ${formatSI(viewRef.current?.max ?? frame.meta.x_max_decimated, frame.meta.mode === 'fft' ? 'Hz' : 's')}`;
		});
		stream.current = subscription;
		return () => {
			subscription.close();
			stream.current = null;
		};
	}, [id, ready]);

	// the zoom: the server renders just the part that is asked for
	useEffect(() => {
		stream.current?.update(view ? { x_min: view.min, x_max: view.max } : {});
	}, [view]);

	useEffect(() => setView(null), [state.display_mode]);

	function zoom(event: React.WheelEvent<HTMLCanvasElement>) {
		const frame = lastFrame.current;
		if (!frame) return;
		const rect = event.currentTarget.getBoundingClientRect();
		const fraction = Math.min(1, Math.max(0, (event.clientX - rect.left - 62) / (rect.width - 72)));
		const [lo, hi] = view ? [view.min, view.max] : [frame.meta.x_min, frame.meta.x_max];
		const at = lo + fraction * (hi - lo);
		const factor = event.deltaY < 0 ? 0.7 : 1 / 0.7;
		const next = { min: Math.max(frame.meta.x_min, at - (at - lo) * factor), max: Math.min(frame.meta.x_max, at + (hi - at) * factor) };
		setView(next.max - next.min >= frame.meta.x_max - frame.meta.x_min ? null : next);
	}

	const drag = useRef<{ x: number; min: number; max: number } | null>(null);
	function startDrag(event: React.MouseEvent<HTMLCanvasElement>) {
		const frame = lastFrame.current;
		if (!frame || !view) return;
		drag.current = { x: event.clientX, min: view.min, max: view.max };
	}
	function moveDrag(event: React.MouseEvent<HTMLCanvasElement>) {
		const frame = lastFrame.current;
		if (!drag.current || !frame) return;
		const span = drag.current.max - drag.current.min;
		let shift = -((event.clientX - drag.current.x) / (event.currentTarget.clientWidth - 72)) * span;
		shift = Math.min(frame.meta.x_max - drag.current.max, Math.max(frame.meta.x_min - drag.current.min, shift));
		setView({ min: drag.current.min + shift, max: drag.current.max + shift });
	}

	const channels: { channel_active: boolean; range_in_millivolts: number }[] = state.channels ?? [];
	return (
		<section data-testid={`device-${id}`} className="rounded-lg bg-white p-3 shadow dark:bg-slate-900 md:col-span-2">
			<div className="mb-2 flex flex-wrap items-center gap-2">
				<h2 className="font-mono text-lg">{id}</h2>
				<span data-testid={`status-${id}`} className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300" hidden={ready}>
					{info.status}
				</span>
				<button data-testid="osc-run" className="rounded bg-brand px-3 py-1 text-sm text-white disabled:opacity-50" disabled={!ready} onClick={() => void call(state.running ? 'stop' : 'start')}>
					{state.running ? 'Stop' : 'Start'}
				</button>
				<span className="flex overflow-hidden rounded border border-zinc-300 dark:border-slate-700" role="group" aria-label="Display">
					{(['time', 'fft'] as const).map((mode) => (
						<button key={mode} data-testid={`osc-mode-${mode}`} aria-pressed={state.display_mode === mode} disabled={!ready}
							className={`px-2 py-1 text-sm ${state.display_mode === mode ? 'bg-zinc-200 dark:bg-slate-700' : ''}`} onClick={() => void call('set_display_mode', mode)}>
							{mode === 'time' ? 'Time trace' : 'FFT'}
						</button>
					))}
				</span>
				<select aria-label="FFT length" data-testid="osc-fft-length" className={SELECT} disabled={!ready} value={state.fft_length ?? 8192} onChange={(e) => void call('set_fft_bin_count', Number(e.target.value))}>
					{FFT_LENGTHS.map((n) => <option key={n} value={n}>{n}</option>)}
				</select>
				<select aria-label="Window function" className={SELECT} disabled={!ready} value={state.fft_window_function ?? 'blackman'} onChange={(e) => void call('set_fft_window_function', e.target.value)}>
					{WINDOWS.map((w) => <option key={w}>{w}</option>)}
				</select>
				<select aria-label="Averaging" className={SELECT} disabled={!ready} value={state.fft_averaging_duration_ms ?? 200} onChange={(e) => void call('set_fft_averaging_duration', Number(e.target.value))}>
					{AVERAGING.map((a) => <option key={a} value={a}>{a === 0 ? 'no averaging' : a < 0 ? 'average all' : `average ${a} ms`}</option>)}
				</select>
				<span className="flex-1" />
				{state.recording && <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs text-red-800 dark:bg-red-950 dark:text-red-300">recording</span>}
			</div>
			<div className="mb-2 flex flex-wrap items-center gap-2">
				{channels.map((ch, i) => (
					<span key={i} className="flex items-center overflow-hidden rounded border" style={{ borderColor: COLORS[i % COLORS.length] }}>
						<button data-testid={`osc-channel-${i}`} aria-pressed={ch.channel_active} disabled={!ready} onClick={() => void call('set_channel_active', i, !ch.channel_active)}
							className="px-2 py-1 text-sm" style={ch.channel_active ? { background: COLORS[i % COLORS.length], color: 'white' } : undefined}>
							C{i + 1}
						</button>
						{ch.channel_active && (
							<select aria-label={`Range of channel ${i + 1}`} className="bg-transparent px-1 text-xs" disabled={!ready} value={ch.range_in_millivolts} onChange={(e) => void call('set_range', i, Number(e.target.value))}>
								{(RANGES.includes(ch.range_in_millivolts) ? RANGES : [...RANGES, ch.range_in_millivolts].sort((a, b) => a - b)).map((r) => <option key={r} value={r}>{r >= 1000 ? `${r / 1000} V` : `${r} mV`}</option>)}
							</select>
						)}
					</span>
				))}
				<span className="text-xs text-zinc-500">
					{state.sample_rate ? formatSI(state.sample_rate, 'S/s') : ''} {state.ffts_per_second ? `· ${state.ffts_per_second} FFT/s` : ''}
					{state.overruns > 0 && <span className="text-amber-600"> · {state.overruns} overruns (the FFT is behind)</span>}
					{state.recording_overruns > 0 && <span className="text-red-600"> · {state.recording_overruns} overruns in the recording: samples lost!</span>}
				</span>
				<span className="flex-1" />
				<span className="text-xs text-zinc-500">
					<span data-testid="osc-range" ref={range} /> · frames <span data-testid="osc-frames" ref={counter}>0</span>
					{view && <button className="ml-2 underline" onClick={() => setView(null)}>whole range</button>}
				</span>
			</div>
			<canvas
				ref={canvas}
				data-testid="osc-canvas"
				className="h-80 w-full cursor-crosshair rounded bg-[#05070d]"
				onWheel={zoom}
				onMouseDown={startDrag}
				onMouseMove={moveDrag}
				onMouseUp={() => (drag.current = null)}
				onMouseLeave={() => (drag.current = null)}
				onDoubleClick={() => setView(null)}
			/>
			{error && <p role="alert" className="mt-1 text-sm text-red-600">{error}</p>}
			{info.error && <pre className="mt-1 overflow-x-auto rounded bg-red-50 p-2 text-xs text-red-800 dark:bg-red-950 dark:text-red-300">{info.error}</pre>}
		</section>
	);
}

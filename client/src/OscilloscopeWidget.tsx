import { useContext, useEffect, useRef, useState } from 'react';
import { DockContext } from './dock';
import { callAction, DeviceInfo } from './store';
import { Button, Icon, IconButton, Segmented, Select, StatusBadge } from './ui';
import { StreamFrame, subscribeStream, StreamSubscription } from './stream';

const COLORS = ['#3b82f6', '#ef4444', '#22c55e', '#f59e0b'];
const FFT_LENGTHS = Array.from({ length: 12 }, (_, i) => 2 ** (i + 9));
const WINDOWS = ['rectangular', 'hann', 'blackman', 'nuttall', 'blackman-nuttall'];
const AVERAGING = [0, 50, 100, 200, 500, 1000, 2000, 5000, 10000, -1];
const RANGES = [50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];

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
	context.clearRect(0, 0, width, height); // the background is the canvas' own, so that the plot follows the theme
	const style = getComputedStyle(canvas);
	const [gridColor, textColor] = [style.borderTopColor, style.color];

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

	context.font = '11px system-ui, sans-serif';
	context.strokeStyle = gridColor;
	context.fillStyle = textColor;
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
	context.strokeStyle = gridColor;
	context.strokeRect(left, top, plotW, plotH);
}

/** The oscilloscope: spectrum or time trace from the display stream, with the controls of the instrument. */
export function OscilloscopeWidget({ id, instanceId, info }: { id: string; /** the device */ instanceId?: string; info: DeviceInfo }) {
	const dock = useContext(DockContext);
	const state = (info.state ?? {}) as Record<string, any>;
	const ready = info.status === 'ready' || info.status === 'degraded';
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
	const [expanded, setExpanded] = useState<number[]>([]);
	const [settings, setSettings] = useState(false);
	const toggleExpanded = (i: number) => setExpanded((e) => (e.includes(i) ? e.filter((x) => x !== i) : [...e, i]));
	const active = channels.filter((c) => c.channel_active).length;
	const volts = (mV: number) => (mV >= 1000 ? `${mV / 1000} V` : `${mV} mV`);
	return (
		<section data-testid={`device-${id}`} className="flex h-full min-h-0 flex-col gap-1.5 bg-ground p-1.5">
			<div className="flex flex-none flex-wrap items-center gap-1.5">
				<Button data-testid="osc-run" variant={state.running ? 'default' : 'primary'} icon={state.running ? 'stop' : 'play'} className="min-w-24" disabled={!ready} onClick={() => void call(state.running ? 'stop' : 'start')}>
					{state.running ? 'Stop' : 'Start'}
				</Button>
				<Segmented label="Display" disabled={!ready} value={state.display_mode} onChange={(mode) => void call('set_display_mode', mode)}
					options={[{ value: 'time', label: 'Time trace', testId: 'osc-mode-time' }, { value: 'fft', label: 'FFT', testId: 'osc-mode-fft' }]} />
				{state.display_mode === 'fft' && (
					<>
						<Select aria-label="FFT length" title="FFT length (points)" data-testid="osc-fft-length" disabled={!ready} value={state.fft_length ?? 8192} onChange={(e) => void call('set_fft_bin_count', Number(e.target.value))}>
							{FFT_LENGTHS.map((n) => <option key={n} value={n}>{n} pts</option>)}
						</Select>
						<IconButton data-testid="osc-settings" icon="settings" label="FFT settings" variant={settings ? 'default' : 'ghost'} aria-expanded={settings} onClick={() => setSettings(!settings)} />
						{settings && (
							<>
								<Select aria-label="Window function" title="Window function" disabled={!ready} value={state.fft_window_function ?? 'blackman'} onChange={(e) => void call('set_fft_window_function', e.target.value)}>
									{WINDOWS.map((w) => <option key={w}>{w}</option>)}
								</Select>
								<Select aria-label="Averaging" title="Averaging" disabled={!ready} value={state.fft_averaging_duration_ms ?? 200} onChange={(e) => void call('set_fft_averaging_duration', Number(e.target.value))}>
									{AVERAGING.map((a) => <option key={a} value={a}>{a === 0 ? 'no averaging' : a < 0 ? 'average all' : `average ${a >= 1000 ? `${a / 1000} s` : `${a} ms`}`}</option>)}
								</Select>
							</>
						)}
					</>
				)}
				<StatusBadge status={info.status} testId={`status-${id}`} hidden={ready} />
				<span className="flex-1" />
				{state.overruns > 0 && <span className="inline-flex items-center gap-1 text-xs text-warn" title="The FFT cannot keep up: some samples are left out of the spectrum"><Icon name="warning" size={12} /> {state.overruns} overruns</span>}
				{state.recording_overruns > 0 && <span className="inline-flex items-center gap-1 text-xs text-bad"><Icon name="warning" size={12} /> {state.recording_overruns} overruns in the recording: samples lost!</span>}
				{state.recording && <span className="inline-flex items-center gap-1 text-xs text-bad"><Icon name="record" size={10} /> recording</span>}
				{view && <Button variant="ghost" className="!h-7 !px-2 text-xs" title="Show the whole range (or double click the plot)" onClick={() => setView(null)}>Reset zoom</Button>}
				<span className="pr-1 text-xs tabular-nums text-faint">
					<span ref={range} data-testid="osc-range" className={view ? '' : 'sr-only'} />
					{view ? ' · ' : ''}{state.sample_rate ? formatSI(state.sample_rate, 'S/s') : ''}{state.running && state.ffts_per_second ? ` · ${Math.round(state.ffts_per_second)} FFT/s` : ''}
					<span ref={counter} data-testid="osc-frames" className="hidden">0</span>
				</span>
			</div>
			<div className="flex min-h-0 flex-1 gap-1.5">
				<div className={`flex flex-none flex-col gap-1 overflow-y-auto ${instanceId && dock?.count(instanceId) ? 'w-40' : 'w-28'}`}>
					{channels.map((ch, i) => {
						const color = COLORS[i % COLORS.length];
						const open = expanded.includes(i);
						return (
							<div key={i} className={`flex-none rounded-lg border bg-panel ${ch.channel_active ? 'border-line' : 'border-transparent'}`}>
								<div className="flex items-center pr-1">
									<button data-testid={`osc-channel-${i}`} aria-pressed={ch.channel_active} disabled={!ready} onClick={() => void call('set_channel_active', i, !ch.channel_active)}
										className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pl-2 text-left text-sm disabled:opacity-40"
										title={ch.channel_active ? `Switch channel ${i + 1} off` : `Switch channel ${i + 1} on`}>
										<span className="size-2.5 flex-none rounded-full border-2" style={{ borderColor: color, background: ch.channel_active ? color : 'transparent' }} />
										<span className={ch.channel_active ? '' : 'text-faint'}>C{i + 1}</span>
										<span className="truncate text-xs text-faint">{ch.channel_active ? volts(ch.range_in_millivolts) : ''}</span>
									</button>
									<IconButton small icon={open ? 'chevron-down' : 'chevron-right'} label={`Settings of channel ${i + 1}`} aria-expanded={open} onClick={() => toggleExpanded(i)} />
								</div>
								{open && (
									<label className="flex flex-col gap-1 px-2 pb-2 text-xs text-muted">Range
										<Select aria-label={`Range of channel ${i + 1}`} disabled={!ready} value={ch.range_in_millivolts} onChange={(e) => void call('set_range', i, Number(e.target.value))}>
											{(RANGES.includes(ch.range_in_millivolts) ? RANGES : [...RANGES, ch.range_in_millivolts].sort((a, b) => a - b)).map((r) => <option key={r} value={r}>{volts(r)}</option>)}
										</Select>
									</label>
								)}
							</div>
						);
					})}
					{instanceId && dock?.render(instanceId)}
				</div>
				<div className="relative min-h-0 min-w-0 flex-1">
					<canvas
						ref={canvas}
						data-testid="osc-canvas"
						className="absolute inset-0 h-full w-full cursor-crosshair rounded-lg border-line bg-plot text-muted"
						onWheel={zoom}
						onMouseDown={startDrag}
						onMouseMove={moveDrag}
						onMouseUp={() => (drag.current = null)}
						onMouseLeave={() => (drag.current = null)}
						onDoubleClick={() => setView(null)}
					/>
					{ready && (!state.running || active === 0) && (
						<span className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-faint">{!state.running ? 'Stopped' : 'No channel is on'}</span>
					)}
				</div>
			</div>
			{error && <p role="alert" className="flex-none text-sm text-bad">{error}</p>}
			{info.error && <pre className="max-h-24 flex-none overflow-auto rounded-md bg-bad/10 p-2 text-xs text-bad">{info.error}</pre>}
		</section>
	);
}

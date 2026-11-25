import { ReactNode, useEffect, useState } from 'react';
import { formatNumber, parseFrequency } from './format';
import { formatSI } from './OscilloscopeWidget';
import { callAction, invokeHub, useStore } from './store';
import { profileState, type WidgetProps } from './widgets';

/** The compact widgets: small, for the strip, bound to profiles (so any driver of the profile works) and to one channel each. */

const INPUT = 'min-w-0 rounded border border-zinc-300 bg-transparent px-1 text-right font-mono text-sm tabular-nums dark:border-slate-700';
const BUTTON_BASE = 'rounded px-1.5 text-sm disabled:opacity-40';
const BUTTON = `${BUTTON_BASE} bg-zinc-200 hover:bg-brand hover:text-white dark:bg-slate-800`;

export function Tile({ label, testId, children, problem }: { label: string; testId: string; children: ReactNode; problem?: string | null }) {
	return (
		<div data-testid={testId} title={problem ?? undefined} className={`flex h-full flex-col justify-center rounded-lg bg-white px-3 py-1 shadow dark:bg-slate-900 ${problem ? 'ring-1 ring-amber-500' : ''}`}>
			<div className="truncate text-xs text-zinc-500">{label}</div>
			{children}
		</div>
	);
}

/** Runs actions of a device and remembers the last failure (shown as a tooltip and a red outline). */
export function useRun(device: string) {
	const [error, setError] = useState<string | null>(null);
	const run = async (action: string, ...args: unknown[]) => {
		try {
			await callAction(device, action, args);
			setError(null);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	};
	return { run, error };
}

/** A number the user can type: shows the device's value until the user starts editing, applies on Enter or when leaving the field. */
export function Field({ value, format, parse, onCommit, testId, label }: { value: number | null | undefined; format: (v: number) => string; parse: (text: string) => number; onCommit: (v: number) => void; testId: string; label: string }) {
	const [draft, setDraft] = useState<string | null>(null);
	const shown = draft ?? (typeof value === 'number' ? format(value) : '—');
	const commit = () => {
		if (draft === null) return;
		const parsed = parse(draft);
		setDraft(null);
		if (Number.isFinite(parsed) && parsed !== value) onCommit(parsed);
	};
	return (
		<input
			data-testid={testId}
			aria-label={label}
			className={`${INPUT} w-28`}
			value={shown}
			onChange={(e) => setDraft(e.target.value)}
			onFocus={(e) => e.target.select()}
			onBlur={commit}
			onKeyDown={(e) => {
				if (e.key === 'Enter') e.currentTarget.blur();
				if (e.key === 'Escape') {
					setDraft(null);
					e.currentTarget.blur();
				}
			}}
		/>
	);
}

const channelOf = (props: WidgetProps) => (typeof props.props.channel === 'number' ? props.props.channel : 0);
const labelOf = ({ props, device }: WidgetProps, channel: number, many: boolean) =>
	typeof props.label === 'string' && props.label ? props.label : many ? `${device} ${channel}` : device;

export function PressureWidget(p: WidgetProps) {
	const channel = channelOf(p);
	const channels = (profileState(p.info, 'pressure_sensor').channels ?? []) as { pressure: number | null; status: string }[];
	const c = channels[channel];
	const unit = p.info.schema?.units?.['channels.*.pressure'] ?? 'mbar';
	const bad = c && c.status !== 'ok';
	return (
		<Tile label={labelOf(p, channel, channels.length > 1)} testId={`pressure-${p.device}-${channel}`} problem={!c ? `no channel ${channel}` : bad ? c.status : null}>
			<div className="flex items-baseline gap-1">
				<span data-testid={`pressure-value-${p.device}-${channel}`} className="font-mono text-lg tabular-nums">
					{c && typeof c.pressure === 'number' ? formatNumber(c.pressure) : '—'}
				</span>
				<span className="text-xs text-zinc-500">{unit}</span>
				{bad && <span className="text-xs text-amber-600">{c.status}</span>}
			</div>
		</Tile>
	);
}

const POSITION_UNIT: Record<string, string> = { deg: '°', um: 'µm', slot: '', percent: '%', steps: 'steps', none: '' };

export function PositionerWidget(p: WidgetProps) {
	const channel = channelOf(p);
	const { run, error } = useRun(p.device);
	const channels = (profileState(p.info, 'positioner').channels ?? []) as { type: string; unit: string; target_position: number | null; actual_position: number | null; status: string }[];
	const c = channels[channel];
	const step = typeof p.props.step === 'number' ? p.props.step : c?.unit === 'um' ? 10 : 1;
	const position = c?.actual_position ?? c?.target_position ?? null;
	const move = (to: number) => run('set_position', channel, to);
	const problem = error ?? (!c ? `no channel ${channel}` : c.status !== 'ok' ? c.status : null);
	return (
		<Tile label={`${labelOf(p, channel, channels.length > 1)}${c ? ` · ${c.type}` : ''}`} testId={`positioner-${p.device}-${channel}`} problem={problem}>
			<div className="flex items-center gap-1">
				<button className={BUTTON} aria-label="Step down" disabled={!c} onClick={() => move((c?.target_position ?? position ?? 0) - step)}>−</button>
				<Field value={position} format={(v) => String(Number(v.toFixed(3)))} parse={Number} onCommit={move} testId={`positioner-input-${p.device}-${channel}`} label="Position" />
				<button className={BUTTON} aria-label="Step up" disabled={!c} onClick={() => move((c?.target_position ?? position ?? 0) + step)}>+</button>
				<span className="w-8 text-xs text-zinc-500">{POSITION_UNIT[c?.unit ?? 'none']}</span>
			</div>
		</Tile>
	);
}

export function FrequencyWidget(p: WidgetProps) {
	const channel = channelOf(p);
	const { run, error } = useRun(p.device);
	const channels = (profileState(p.info, 'frequency_generator').channels ?? []) as { frequency: number; power: number; is_on: boolean }[];
	const c = channels[channel];
	return (
		<Tile label={labelOf(p, channel, channels.length > 1)} testId={`frequency-${p.device}-${channel}`} problem={error ?? (!c ? `no channel ${channel}` : null)}>
			<div className="flex items-center gap-1">
				<Field value={c?.frequency} format={(v) => formatSI(v, 'Hz')} parse={parseFrequency} onCommit={(v) => run('set_frequency', channel, v)} testId={`frequency-input-${p.device}-${channel}`} label="Frequency" />
				<button
					data-testid={`frequency-on-${p.device}-${channel}`}
					aria-pressed={c?.is_on ?? false}
					disabled={!c}
					className={c?.is_on ? `${BUTTON_BASE} bg-emerald-600 text-white` : BUTTON}
					onClick={() => run('set_on', channel, !c?.is_on)}
				>
					{c?.is_on ? 'On' : 'Off'}
				</button>
			</div>
		</Tile>
	);
}

export function PolarimeterWidget(p: WidgetProps) {
	const s = profileState(p.info, 'polarimeter');
	const deg = (v: unknown) => (typeof v === 'number' ? `${Number(((v * 180) / Math.PI).toFixed(1))}°` : '—');
	return (
		<Tile label={labelOf(p, 0, false)} testId={`polarimeter-${p.device}`} problem={s.status && s.status !== 'ok' ? String(s.status) : null}>
			<div className="flex gap-3 font-mono text-sm tabular-nums">
				<span title="azimuth">θ {deg(s.theta)}</span>
				<span title="ellipticity">η {deg(s.eta)}</span>
				<span title="degree of polarization">{typeof s.dop === 'number' ? `${Math.round(s.dop * 100)} %` : '—'}</span>
				<span title="power">{typeof s.power === 'number' ? formatSI(s.power, 'W') : '—'}</span>
			</div>
		</Tile>
	);
}

/** Start and stop a recording, take a snapshot: the recording of the whole server, not of one device. */
export function RecordingWidget(_: WidgetProps) {
	const { recording } = useStore();
	const [name, setName] = useState('');
	const [error, setError] = useState<string | null>(null);
	const [now, setNow] = useState(Date.now());
	useEffect(() => {
		if (!recording.active) return;
		const timer = setInterval(() => setNow(Date.now()), 500);
		return () => clearInterval(timer);
	}, [recording.active]);
	const call = async (method: string, ...args: unknown[]) => {
		try {
			await invokeHub(method, ...args);
			setError(null);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	};
	const elapsed = recording.active && recording.start_time ? Math.max(0, Math.round((now - Date.parse(recording.start_time)) / 1000)) : 0;
	return (
		<Tile label="Recording" testId="recording-widget" problem={error}>
			<div className="flex items-center gap-1">
				<input
					data-testid="recording-name"
					aria-label="Filename"
					placeholder="Filename"
					className="w-40 rounded border border-zinc-300 bg-transparent px-1 text-sm dark:border-slate-700"
					value={recording.active ? (recording.name ?? '') : name}
					disabled={recording.active}
					onChange={(e) => setName(e.target.value)}
				/>
				<button className={BUTTON} data-testid="snapshot" disabled={!name.trim() && !recording.active} onClick={() => call('snapshot', name.trim() || recording.name, null)}>Snapshot</button>
				{recording.active ? (
					<>
						<button className={`${BUTTON_BASE} bg-red-600 text-white`} data-testid="record-stop" onClick={() => call('stop_recording')}>
							■ {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')}
						</button>
						<button className={BUTTON} data-testid="record-discard" title="Stop and delete the recording" onClick={() => call('abort_recording', true)}>Discard</button>
					</>
				) : (
					<button className={BUTTON} data-testid="record-start" disabled={!name.trim()} onClick={() => call('start_recording', name.trim(), null)}>● Record</button>
				)}
			</div>
		</Tile>
	);
}

type Pump = {
	name: string;
	status: string;
	is_running: boolean | null;
	is_standby: boolean | null;
	actual_speed: number | null;
	target_speed: number | null;
	current: number | null;
	power: number | null;
	voltage: number | null;
	operating_hours: number | null;
	error_code: string | null;
};

function pumpMode(c: Pump): { text: string; color: string } {
	if (c.status !== 'ok') return { text: '? NO DATA', color: 'text-zinc-500' };
	if (c.error_code) return { text: '⚠ ERROR', color: 'text-red-600' };
	if (c.is_running) return { text: c.is_standby ? '▶ STANDBY' : '▶ RUN', color: c.is_standby ? 'text-yellow-600' : 'text-emerald-600' };
	return { text: '■ STOP', color: 'text-orange-600' };
}

const number = (v: number | null, digits = 0) => (typeof v === 'number' ? v.toFixed(digits) : '—');

function PumpPanel({ p, channel, c, onClose }: { p: WidgetProps; channel: number; c: Pump; onClose: () => void }) {
	const { run, error } = useRun(p.device);
	const [speed, setSpeed] = useState<string | null>(null);
	useEffect(() => {
		const close = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
		window.addEventListener('keydown', close);
		return () => window.removeEventListener('keydown', close);
	}, [onClose]);
	const mode = pumpMode(c);
	const stat = (label: string, value: string, unit: string, extra?: string) => (
		<div className="rounded-lg bg-zinc-100 p-3 dark:bg-slate-800">
			<div className="text-xs text-zinc-500">{label}</div>
			<div className="font-mono text-2xl tabular-nums">{value}<span className="ml-1 text-sm text-zinc-500">{unit}</span></div>
			{extra && <div className="text-xs text-zinc-500">{extra}</div>}
		</div>
	);
	return (
		<div data-testid={`pump-panel-${p.device}-${channel}`} role="dialog" aria-label={c.name} className="fixed bottom-24 left-1/2 z-50 w-[28rem] max-w-[95vw] -translate-x-1/2 rounded-xl bg-white p-4 shadow-2xl ring-1 ring-zinc-300 dark:bg-slate-900 dark:ring-slate-700">
			<div className="mb-3 flex items-center gap-2">
				<h2 className="text-lg font-semibold">{typeof p.props.label === 'string' && p.props.label ? p.props.label : c.name}</h2>
				<span className={`font-bold ${mode.color}`} data-testid={`pump-mode-${p.device}-${channel}`}>{mode.text}</span>
				<span className="flex-1" />
				<button className={BUTTON} aria-label="Close" onClick={onClose}>✕</button>
			</div>
			{c.status !== 'ok' && <p className="mb-2 text-sm text-amber-700">{c.status}</p>}
			{c.error_code && <p className="mb-2 text-sm text-red-600">The controller reports the error {c.error_code}.</p>}
			<div className="grid grid-cols-2 gap-2">
				{stat('Speed', number(c.actual_speed), 'Hz', `target ${number(c.target_speed)} Hz`)}
				{stat('Motor current', number(c.current, 2), 'A')}
				{stat('Power', number(c.power), 'W')}
				{stat('Voltage', number(c.voltage, 1), 'V')}
			</div>
			<p className="mt-2 text-xs text-zinc-500">Operating hours: {number(c.operating_hours)} h</p>
			<div className="mt-3 flex gap-2">
				<button className={`${BUTTON} flex-1 py-1`} data-testid="pump-start" disabled={c.is_running === true} onClick={() => run('start', channel)}>▶ Start</button>
				<button className={`${BUTTON} flex-1 py-1`} data-testid="pump-stop" disabled={c.is_running === false} onClick={() => run('stop', channel)}>■ Stop</button>
				<button className="flex-1 rounded bg-red-600 py-1 text-sm text-white hover:bg-red-700" data-testid="pump-emergency" onClick={() => window.confirm('Emergency stop?') && run('emergency_stop', channel)}>⚠ Emergency stop</button>
			</div>
			<div className="mt-3 flex items-center gap-2">
				<label className="text-sm" htmlFor={`pump-speed-${p.device}-${channel}`}>Target speed (Hz)</label>
				<input id={`pump-speed-${p.device}-${channel}`} data-testid="pump-speed" type="number" min={0} className={`${INPUT} w-24 flex-none`} value={speed ?? (c.target_speed ?? '')} onChange={(e) => setSpeed(e.target.value)} />
				<button className={BUTTON} data-testid="pump-set-speed" disabled={speed === null || speed === ''} onClick={() => run('set_speed', channel, Number(speed)).then(() => setSpeed(null))}>Set</button>
				<span className="flex-1" />
				<label className="flex items-center gap-1 text-sm">
					<input type="checkbox" data-testid="pump-standby" checked={c.is_standby ?? false} onChange={(e) => run('set_standby', channel, e.target.checked)} /> Standby
				</label>
			</div>
			{error && <p role="alert" className="mt-2 text-xs text-red-600">{error}</p>}
		</div>
	);
}

/** One pump: state, speed and current in the tile; double click for all values and the controls. */
export function TurboPumpWidget(p: WidgetProps) {
	const channel = channelOf(p);
	const [open, setOpen] = useState(false);
	const channels = (profileState(p.info, 'turbo_pump').channels ?? []) as Pump[];
	const c = channels[channel];
	const mode = c ? pumpMode(c) : null;
	return (
		<>
			<div onDoubleClick={() => setOpen(true)} className="h-full cursor-pointer" title="Double click for details and controls">
				<Tile label={typeof p.props.label === 'string' && p.props.label ? p.props.label : (c?.name ?? labelOf(p, channel, channels.length > 1))} testId={`turbo-${p.device}-${channel}`} problem={!c ? `no pump ${channel}` : c.status !== 'ok' ? c.status : null}>
					{c && mode && (
						<div className="flex items-center gap-3 text-xs">
							<span className={`font-bold ${mode.color}`} data-testid={`turbo-mode-${p.device}-${channel}`}>{mode.text}</span>
							<span><span className="text-zinc-500">Speed:</span> <span className="font-bold text-sky-600" data-testid={`turbo-speed-${p.device}-${channel}`}>{number(c.actual_speed)} Hz</span></span>
							<span><span className="text-zinc-500">I:</span> <span className="font-bold text-emerald-600">{number(c.current, 2)} A</span></span>
						</div>
					)}
				</Tile>
			</div>
			{open && c && <PumpPanel p={p} channel={channel} c={c} onClose={() => setOpen(false)} />}
		</>
	);
}

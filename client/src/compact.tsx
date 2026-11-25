import { ReactNode, useEffect, useState } from 'react';
import { formatNumber, parseFrequency } from './format';
import { formatSI } from './OscilloscopeWidget';
import { callAction, invokeHub, useStore } from './store';
import type { WidgetProps } from './widgets';

/** The compact widgets: small, for the strip, bound to profiles (so any driver of the profile works) and to one channel each. */

const INPUT = 'w-full min-w-0 rounded border border-zinc-300 bg-transparent px-1 text-right font-mono text-sm tabular-nums dark:border-slate-700';
const BUTTON = 'rounded bg-zinc-200 px-1.5 text-sm hover:bg-brand hover:text-white disabled:opacity-40 dark:bg-slate-800';

function Tile({ label, testId, children, problem }: { label: string; testId: string; children: ReactNode; problem?: string | null }) {
	return (
		<div data-testid={testId} title={problem ?? undefined} className={`flex h-full flex-col justify-center rounded-lg bg-white px-3 py-1 shadow dark:bg-slate-900 ${problem ? 'ring-1 ring-amber-500' : ''}`}>
			<div className="truncate text-xs text-zinc-500">{label}</div>
			{children}
		</div>
	);
}

/** Runs actions of a device and remembers the last failure (shown as a tooltip and a red outline). */
function useRun(device: string) {
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
function Field({ value, format, parse, onCommit, testId, label }: { value: number | null | undefined; format: (v: number) => string; parse: (text: string) => number; onCommit: (v: number) => void; testId: string; label: string }) {
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
			className={INPUT}
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
	const channels = (p.info.state?.channels ?? []) as { pressure: number | null; status: string }[];
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
	const channels = (p.info.state?.channels ?? []) as { type: string; unit: string; target_position: number | null; actual_position: number | null; status: string }[];
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
	const channels = (p.info.state?.channels ?? []) as { frequency: number; power: number; is_on: boolean }[];
	const c = channels[channel];
	return (
		<Tile label={labelOf(p, channel, channels.length > 1)} testId={`frequency-${p.device}-${channel}`} problem={error ?? (!c ? `no channel ${channel}` : null)}>
			<div className="flex items-center gap-1">
				<Field value={c?.frequency} format={(v) => formatSI(v, 'Hz')} parse={parseFrequency} onCommit={(v) => run('set_frequency', channel, v)} testId={`frequency-input-${p.device}-${channel}`} label="Frequency" />
				<button
					data-testid={`frequency-on-${p.device}-${channel}`}
					aria-pressed={c?.is_on ?? false}
					disabled={!c}
					className={`${BUTTON} ${c?.is_on ? 'bg-emerald-600 text-white dark:bg-emerald-700' : ''}`}
					onClick={() => run('set_on', channel, !c?.is_on)}
				>
					{c?.is_on ? 'On' : 'Off'}
				</button>
			</div>
		</Tile>
	);
}

export function PolarimeterWidget(p: WidgetProps) {
	const s = p.info.state ?? {};
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
						<button className={`${BUTTON} bg-red-600 text-white`} data-testid="record-stop" onClick={() => call('stop_recording')}>
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

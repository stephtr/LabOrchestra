import { ReactNode, useEffect, useState } from 'react';
import { formatNumber, parseFrequency } from './format';
import { useRecordingTime } from './Header';
import { formatSI } from './OscilloscopeWidget';
import { callAction, invokeHub, useStore } from './store';
import { Button, Icon, IconButton, Input } from './ui';
import { profileState, type WidgetProps } from './widgets';

/** The compact widgets: small, for the strip, bound to profiles (so any driver of the profile works) and to one channel each. */

/** The small card every compact widget sits in: a label, the content in one row below. A problem outlines it and is its tooltip. */
export function Tile({ label, testId, children, problem }: { label: string; testId: string; children: ReactNode; problem?: string | null }) {
	return (
		<div data-testid={testId} title={problem ?? undefined} className={`flex h-full flex-col justify-center gap-0.5 rounded-lg border bg-panel px-3 ${problem ? 'border-warn' : 'border-line'}`}>
			<div className="flex items-center gap-1 text-xs leading-4 text-muted">
				<span className="truncate">{label}</span>
				{problem && <Icon name="warning" size={12} className="text-warn" />}
			</div>
			<div className="flex min-h-7 items-center">{children}</div>
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
export function Field({ value, format, parse, onCommit, testId, label, suffix, className = 'w-24 rounded-md' }: { value: number | null | undefined; format: (v: number) => string; parse: (text: string) => number; onCommit: (v: number) => void; testId: string; label: string; suffix?: string; className?: string }) {
	const [draft, setDraft] = useState<string | null>(null);
	const shown = draft ?? (typeof value === 'number' ? format(value) : '—');
	const commit = () => {
		if (draft === null) return;
		const parsed = parse(draft);
		setDraft(null);
		if (Number.isFinite(parsed) && parsed !== value) onCommit(parsed);
	};
	return (
		<span className={`inline-flex h-7 items-center border border-line bg-field px-2 focus-within:border-accent ${className}`}>
			<input
				data-testid={testId}
				aria-label={label}
				className="w-full min-w-0 bg-transparent text-right text-sm tabular-nums outline-none"
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
			{suffix && <span className="flex-none pl-1 text-xs text-faint">{suffix}</span>}
		</span>
	);
}

const channelOf = (props: WidgetProps) => (typeof props.props.channel === 'number' ? props.props.channel : 0);
/** What a compact widget calls itself: a label of the instance if it has one (older views), else the name of the channel (the device's), else the device. */
const labelOf = ({ props, device }: WidgetProps, name: unknown, channel: number, many: boolean) =>
	typeof props.label === 'string' && props.label ? props.label : typeof name === 'string' && name ? name : many ? `${device} ${channel}` : device;

export function PressureWidget(p: WidgetProps) {
	const channel = channelOf(p);
	const channels = (profileState(p.info, 'pressure_sensor').channels ?? []) as { name?: string; pressure: number | null; status: string }[];
	const c = channels[channel];
	const unit = p.info.schema?.units?.['channels.*.pressure'] ?? 'mbar';
	const bad = c && c.status !== 'ok';
	return (
		<Tile label={labelOf(p, c?.name, channel, channels.length > 1)} testId={`pressure-${p.device}-${channel}`} problem={!c ? `no channel ${channel}` : bad ? c.status : null}>
			<div className="flex items-baseline gap-1.5 whitespace-nowrap">
				<span data-testid={`pressure-value-${p.device}-${channel}`} className="text-lg leading-7 tabular-nums">
					{c && typeof c.pressure === 'number' ? formatNumber(c.pressure) : '—'}
				</span>
				<span className="text-xs text-faint">{unit}</span>
				{bad && <span className="text-xs text-warn">{c.status}</span>}
			</div>
		</Tile>
	);
}

const POSITION_UNIT: Record<string, string> = { deg: '°', um: 'µm', slot: '', percent: '%', steps: 'steps', none: '' };

export function PositionerWidget(p: WidgetProps) {
	const channel = channelOf(p);
	const { run, error } = useRun(p.device);
	const channels = (profileState(p.info, 'positioner').channels ?? []) as { name?: string; type: string; unit: string; target_position: number | null; actual_position: number | null; status: string }[];
	const c = channels[channel];
	const step = typeof p.props.step === 'number' ? p.props.step : c?.unit === 'um' ? 10 : 1;
	const position = c?.actual_position ?? c?.target_position ?? null;
	const move = (to: number) => run('set_position', channel, to);
	const problem = error ?? (!c ? `no channel ${channel}` : c.status !== 'ok' ? c.status : null);
	return (
		<Tile label={labelOf(p, c?.name, channel, channels.length > 1)} testId={`positioner-${p.device}-${channel}`} problem={problem}>
			<div className="flex items-center">
				<IconButton icon="minus" label="Step down" small variant="default" className="!h-7 rounded-r-none" disabled={!c} onClick={() => move((c?.target_position ?? position ?? 0) - step)} />
				<Field value={position} format={(v) => String(Number(v.toFixed(3)))} parse={Number} onCommit={move} testId={`positioner-input-${p.device}-${channel}`} label="Position" suffix={POSITION_UNIT[c?.unit ?? 'none']} className="w-20 border-x-0" />
				<IconButton icon="plus" label="Step up" small variant="default" className="!h-7 rounded-l-none" disabled={!c} onClick={() => move((c?.target_position ?? position ?? 0) + step)} />
			</div>
		</Tile>
	);
}

export function FrequencyWidget(p: WidgetProps) {
	const channel = channelOf(p);
	const { run, error } = useRun(p.device);
	const channels = (profileState(p.info, 'frequency_generator').channels ?? []) as { name?: string; frequency: number; power: number; is_on: boolean }[];
	const c = channels[channel];
	return (
		<Tile label={labelOf(p, c?.name, channel, channels.length > 1)} testId={`frequency-${p.device}-${channel}`} problem={error ?? (!c ? `no channel ${channel}` : null)}>
			<div className="flex items-center gap-1">
				<Field value={c?.frequency} format={(v) => formatSI(v, 'Hz')} parse={parseFrequency} onCommit={(v) => run('set_frequency', channel, v)} testId={`frequency-input-${p.device}-${channel}`} label="Frequency" />
				<Button
					data-testid={`frequency-on-${p.device}-${channel}`}
					aria-pressed={c?.is_on ?? false}
					disabled={!c}
					className={`!h-7 w-11 !px-0 ${c?.is_on ? '!bg-good !text-white dark:!text-ground' : ''}`}
					title={c?.is_on ? 'The output is on: switch it off' : 'The output is off: switch it on'}
					onClick={() => run('set_on', channel, !c?.is_on)}
				>
					{c?.is_on ? 'On' : 'Off'}
				</Button>
			</div>
		</Tile>
	);
}

export function PolarimeterWidget(p: WidgetProps) {
	const s = profileState(p.info, 'polarimeter');
	const deg = (v: unknown) => (typeof v === 'number' ? `${Number(((v * 180) / Math.PI).toFixed(1))}°` : '—');
	return (
		<Tile label={labelOf(p, undefined, 0, false)} testId={`polarimeter-${p.device}`} problem={s.status && s.status !== 'ok' ? String(s.status) : null}>
			<div className="flex gap-3 whitespace-nowrap text-sm tabular-nums">
				<span title="azimuth">θ {deg(s.theta)}</span>
				<span title="ellipticity">η {deg(s.eta)}</span>
				<span title="degree of polarization">{typeof s.dop === 'number' ? `${Math.round(s.dop * 100)} %` : '—'}</span>
				<span title="power">{typeof s.power === 'number' ? formatSI(s.power, 'W') : '—'}</span>
			</div>
		</Tile>
	);
}

/** Start and stop a recording, take a snapshot: the recording of the whole server, not of one device. */
export function RecordingWidget({ props }: WidgetProps) {
	const { recording } = useStore();
	const [name, setName] = useState('');
	const [error, setError] = useState<string | null>(null);
	const time = useRecordingTime();
	const call = async (method: string, ...args: unknown[]) => {
		try {
			await invokeHub(method, ...args);
			setError(null);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	};
	return (
		<Tile label={typeof props.label === 'string' && props.label ? props.label : 'Recording'} testId="recording-widget" problem={error}>
			<div className="flex items-center gap-1">
				<Input
					data-testid="recording-name"
					aria-label="Filename"
					placeholder="Filename"
					className="!h-7 w-28"
					value={recording.active ? (recording.name ?? '') : name}
					disabled={recording.active}
					onChange={(e) => setName(e.target.value)}
				/>
				{recording.active ? (
					<>
						<Button className="!h-7 !bg-bad/15 !px-2 tabular-nums !text-bad" icon="stop" data-testid="record-stop" title="Stop the recording" onClick={() => call('stop_recording')}>{time}</Button>
						<IconButton className="!size-7" icon="trash" variant="danger" label="Stop and delete the recording" data-testid="record-discard" onClick={() => window.confirm('Stop and delete this recording?') && call('abort_recording', true)} />
					</>
				) : (
					<Button className="!h-7 !px-2" icon="record" data-testid="record-start" disabled={!name.trim()} onClick={() => call('start_recording', name.trim(), null)}>Record</Button>
				)}
				<IconButton className="!size-7" icon="camera" variant="default" label="Snapshot" data-testid="snapshot" disabled={!name.trim() && !recording.active} onClick={() => call('snapshot', name.trim() || recording.name, null)} />
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
	if (c.status !== 'ok') return { text: 'No data', color: 'text-faint' };
	if (c.error_code) return { text: 'Error', color: 'text-bad' };
	if (c.is_running) return c.is_standby ? { text: 'Standby', color: 'text-warn' } : { text: 'Running', color: 'text-good' };
	return { text: 'Stopped', color: 'text-warn' };
}

const number = (v: number | null, digits = 0) => (typeof v === 'number' ? v.toFixed(digits) : '—');

function Mode({ c, testId }: { c: Pump; testId: string }) {
	const mode = pumpMode(c);
	return (
		<span className={`inline-flex items-center gap-1.5 ${mode.color}`}>
			<span className="size-2 rounded-full bg-current" />
			<span data-testid={testId}>{mode.text}</span>
		</span>
	);
}

function PumpPanel({ p, channel, c, onClose }: { p: WidgetProps; channel: number; c: Pump; onClose: () => void }) {
	const { run, error } = useRun(p.device);
	const [speed, setSpeed] = useState<string | null>(null);
	useEffect(() => {
		const close = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
		window.addEventListener('keydown', close);
		return () => window.removeEventListener('keydown', close);
	}, [onClose]);
	const stat = (label: string, value: string, unit: string, extra?: string) => (
		<div className="rounded-lg bg-ground px-3 py-2">
			<div className="text-xs text-muted">{label}</div>
			<div className="text-xl tabular-nums">{value}<span className="ml-1 text-sm text-faint">{unit}</span></div>
			{extra && <div className="text-xs tabular-nums text-faint">{extra}</div>}
		</div>
	);
	const speedId = `pump-speed-${p.device}-${channel}`;
	return (
		<div data-testid={`pump-panel-${p.device}-${channel}`} role="dialog" aria-label={c.name} className="fixed bottom-40 right-4 z-50 w-[26rem] max-w-[calc(100vw-2rem)] rounded-xl border border-line bg-panel shadow-2xl">
			<div className="flex items-center gap-3 border-b border-line py-2 pl-4 pr-2">
				<h2 className="font-semibold">{typeof p.props.label === 'string' && p.props.label ? p.props.label : c.name}</h2>
				<span className="flex-1 text-sm"><Mode c={c} testId={`pump-mode-${p.device}-${channel}`} /></span>
				<IconButton icon="close" label="Close" onClick={onClose} />
			</div>
			<div className="flex flex-col gap-3 p-4">
				{c.status !== 'ok' && <p className="text-sm text-warn">{c.status}</p>}
				{c.error_code && <p className="text-sm text-bad">The controller reports the error {c.error_code}.</p>}
				<div className="grid grid-cols-2 gap-2">
					{stat('Speed', number(c.actual_speed), 'Hz', `target ${number(c.target_speed)} Hz`)}
					{stat('Motor current', number(c.current, 2), 'A')}
					{stat('Power', number(c.power), 'W')}
					{stat('Voltage', number(c.voltage, 1), 'V', `${number(c.operating_hours)} operating hours`)}
				</div>
				<div className="flex items-center gap-2">
					<label className="flex-1 text-sm text-muted" htmlFor={speedId}>Target speed (Hz)</label>
					<Input id={speedId} data-testid="pump-speed" type="number" min={0} className="w-24 text-right tabular-nums" value={speed ?? (c.target_speed ?? '')} onChange={(e) => setSpeed(e.target.value)} />
					<Button data-testid="pump-set-speed" disabled={speed === null || speed === ''} onClick={() => run('set_speed', channel, Number(speed)).then(() => setSpeed(null))}>Set</Button>
				</div>
				<label className="flex items-center justify-between text-sm text-muted">
					Standby (reduced speed)
					<input type="checkbox" className="size-4" data-testid="pump-standby" checked={c.is_standby ?? false} onChange={(e) => run('set_standby', channel, e.target.checked)} />
				</label>
				<div className="flex gap-2">
					<Button className="!flex-1" variant={c.is_running ? 'default' : 'primary'} icon="play" data-testid="pump-start" disabled={c.is_running === true} onClick={() => run('start', channel)}>Start</Button>
					<Button className="!flex-1" icon="stop" data-testid="pump-stop" disabled={c.is_running === false} onClick={() => run('stop', channel)}>Stop</Button>
					<Button className="!bg-bad/15 !text-bad hover:!bg-bad/25" icon="warning" data-testid="pump-emergency" onClick={() => window.confirm('Emergency stop?') && run('emergency_stop', channel)}>Emergency stop</Button>
				</div>
				{error && <p role="alert" className="text-xs text-bad">{error}</p>}
			</div>
		</div>
	);
}

/** One pump: state, speed and current in the tile; a click shows all values and the controls. */
export function TurboPumpWidget(p: WidgetProps) {
	const channel = channelOf(p);
	const [open, setOpen] = useState(false);
	const channels = (profileState(p.info, 'turbo_pump').channels ?? []) as Pump[];
	const c = channels[channel];
	return (
		<>
			<div role="button" tabIndex={0} onClick={() => setOpen(true)} onKeyDown={(e) => e.key === 'Enter' && setOpen(true)} className="h-full rounded-lg" title="Details and controls">
				<Tile label={typeof p.props.label === 'string' && p.props.label ? p.props.label : labelOf(p, c?.name, channel, channels.length > 1)} testId={`turbo-${p.device}-${channel}`} problem={!c ? `no pump ${channel}` : c.status !== 'ok' ? c.status : null}>
					{c && (
						<div className="flex items-center gap-3 whitespace-nowrap text-sm tabular-nums">
							<Mode c={c} testId={`turbo-mode-${p.device}-${channel}`} />
							<span data-testid={`turbo-speed-${p.device}-${channel}`}>{number(c.actual_speed)} Hz</span>
							<span className="text-muted">{number(c.current, 2)} A</span>
						</div>
					)}
				</Tile>
			</div>
			{open && c && <PumpPanel p={p} channel={channel} c={c} onClose={() => setOpen(false)} />}
		</>
	);
}

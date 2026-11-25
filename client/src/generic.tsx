import { useState } from 'react';
import { formatNumber, parseFrequency, unitFor } from './format';
import { widget, WidgetInstance } from './layout';
import { formatSI } from './OscilloscopeWidget';
import { ActionSchema, callAction, DeviceInfo } from './store';
import { Field, Tile, useRun } from './compact';
import type { WidgetProps } from './widgets';

/**
 * Widgets that work for any device, configured by the user (they need the picker's form): show a state field, set a number with an
 * action, press a button that calls an action. They cover what no profile describes (a voltage output, the test signal of an
 * oscilloscope, "reset", "lock").
 */

/** The value at a path like "channels.0.pressure" (undefined when there is none). */
export function getPath(state: unknown, path: string): unknown {
	let value: unknown = state;
	for (const key of path.split('.')) {
		if (value === null || typeof value !== 'object') return undefined;
		value = (value as Record<string, unknown>)[key];
	}
	return value;
}

/** The paths of all numbers, booleans and strings in a state, with their values. */
export function leafPaths(state: unknown, prefix = ''): { path: string; value: unknown }[] {
	if (state === null || typeof state !== 'object') return prefix ? [{ path: prefix, value: state }] : [];
	return Object.entries(state as Record<string, unknown>).flatMap(([key, value]) => leafPaths(value, prefix ? `${prefix}.${key}` : key));
}

const label = (props: Record<string, unknown>, fallback: string) => (typeof props.label === 'string' && props.label ? props.label : fallback);

function show(value: unknown, unit: string | undefined): string {
	if (typeof value === 'number') return unit === 'Hz' ? formatSI(value, 'Hz') : formatNumber(value);
	if (value === null || value === undefined) return '—';
	return String(value);
}

export function ValueWidget({ device, info, props }: WidgetProps) {
	const path = String(props.path ?? '');
	const value = getPath(info.state, path);
	const unit = unitFor(info.schema?.units, path);
	return (
		<Tile label={label(props, `${device} ${path}`)} testId={`value-${device}-${path}`} problem={value === undefined ? `no state field "${path}"` : null}>
			<div className="flex items-baseline gap-1">
				<span className="font-mono text-lg tabular-nums" data-testid={`value-text-${device}-${path}`}>{show(value, unit)}</span>
				{unit && unit !== 'Hz' && <span className="text-xs text-zinc-500">{unit}</span>}
			</div>
		</Tile>
	);
}

export function NumberWidget({ device, info, props }: WidgetProps) {
	const path = String(props.path ?? '');
	const action = String(props.action ?? '');
	const channel = typeof props.channel === 'number' ? props.channel : undefined;
	const { run, error } = useRun(device);
	const value = getPath(info.state, path);
	const unit = unitFor(info.schema?.units, path);
	const known = info.schema?.actions.some((a) => a.name === action);
	return (
		<Tile label={label(props, `${device} ${path}`)} testId={`number-${device}-${path}`} problem={error ?? (!known ? `no action "${action}"` : value === undefined ? `no state field "${path}"` : null)}>
			<div className="flex items-center gap-1">
				<Field
					value={typeof value === 'number' ? value : undefined}
					format={(v) => (unit === 'Hz' ? formatSI(v, 'Hz') : String(Number(v.toPrecision(6))))}
					parse={unit === 'Hz' ? parseFrequency : Number}
					onCommit={(v) => run(action, ...(channel === undefined ? [v] : [channel, v]))}
					testId={`number-input-${device}-${path}`}
					label={label(props, path)}
				/>
				{unit && unit !== 'Hz' && <span className="text-xs text-zinc-500">{unit}</span>}
			</div>
		</Tile>
	);
}

export function ButtonWidget({ device, info, props }: WidgetProps) {
	const action = String(props.action ?? '');
	const args = Array.isArray(props.args) ? props.args : [];
	const { run, error } = useRun(device);
	const known = info.schema?.actions.some((a) => a.name === action);
	return (
		<div className="flex h-full items-center rounded-lg bg-white px-3 py-1 shadow dark:bg-slate-900" title={error ?? (!known ? `no action "${action}"` : undefined)}>
			<button
				data-testid={`button-${device}-${action}`}
				disabled={!known}
				className={`rounded px-3 py-1 text-sm ${error ? 'bg-amber-200 dark:bg-amber-900' : 'bg-zinc-200 hover:bg-brand hover:text-white dark:bg-slate-800'}`}
				onClick={() => {
					if (props.confirm && !window.confirm(`${label(props, action)}?`)) return;
					void run(action, ...args);
				}}
			>
				{label(props, action)}
			</button>
		</div>
	);
}

const SELECT = 'rounded border border-zinc-300 bg-white px-1 py-0.5 text-sm dark:border-slate-700 dark:bg-slate-900';

/** What a user picks for a widget of this kind: a state field, an action, a channel for actions that take one. */
export function CustomForm({ type, device, info, onCreate, onCancel }: { type: 'value' | 'number' | 'button'; device: string; info: DeviceInfo; onCreate: (w: WidgetInstance) => void; onCancel: () => void }) {
	const paths = leafPaths(info.state).filter((l) => type === 'value' || typeof l.value === 'number');
	const actions = info.schema?.actions ?? [];
	const [path, setPath] = useState(paths[0]?.path ?? '');
	const [action, setAction] = useState(actions[0]?.name ?? '');
	const [channel, setChannel] = useState('');
	const [args, setArgs] = useState('');
	const [name, setName] = useState('');
	const chosen: ActionSchema | undefined = actions.find((a) => a.name === action);
	const needsChannel = type === 'number' && (chosen?.params.length ?? 0) >= 2;
	const ready = type === 'button' ? !!action : type === 'number' ? !!path && !!action && (!needsChannel || channel !== '') : !!path;
	let parsedArgs: unknown[] | null = [];
	if (type === 'button' && args.trim()) {
		try {
			const v = JSON.parse(`[${args}]`);
			parsedArgs = Array.isArray(v) ? v : null;
		} catch {
			parsedArgs = null;
		}
	}
	return (
		<form
			data-testid="custom-form"
			className="flex flex-wrap items-end gap-2 py-1"
			onSubmit={(e) => {
				e.preventDefault();
				if (!ready || parsedArgs === null) return;
				const props: Record<string, unknown> = {};
				if (type !== 'button') props.path = path;
				if (type !== 'value') props.action = action;
				if (needsChannel) props.channel = Number(channel);
				if (type === 'button' && parsedArgs.length) props.args = parsedArgs;
				if (name.trim()) props.label = name.trim();
				onCreate(widget(type, device, props));
			}}
		>
			<span className="font-mono">{device}</span>
			{type !== 'button' && (
				<label className="text-xs text-zinc-500">State field
					<select data-testid="custom-path" className={`${SELECT} block`} value={path} onChange={(e) => setPath(e.target.value)}>
						{paths.map((l) => <option key={l.path}>{l.path}</option>)}
					</select>
				</label>
			)}
			{type !== 'value' && (
				<label className="text-xs text-zinc-500">Action
					<select data-testid="custom-action" className={`${SELECT} block`} value={action} onChange={(e) => setAction(e.target.value)}>
						{actions.map((a) => <option key={a.name}>{a.name}</option>)}
					</select>
				</label>
			)}
			{needsChannel && (
				<label className="text-xs text-zinc-500">Channel
					<input data-testid="custom-channel" type="number" min={0} className={`${SELECT} block w-16`} value={channel} onChange={(e) => setChannel(e.target.value)} />
				</label>
			)}
			{type === 'button' && (
				<label className="text-xs text-zinc-500">Arguments (JSON, e.g. 0, true)
					<input data-testid="custom-args" className={`${SELECT} block w-36 ${parsedArgs === null ? 'border-red-500' : ''}`} value={args} onChange={(e) => setArgs(e.target.value)} />
				</label>
			)}
			<label className="text-xs text-zinc-500">Label
				<input data-testid="custom-label" className={`${SELECT} block w-32`} value={name} onChange={(e) => setName(e.target.value)} />
			</label>
			<button data-testid="custom-create" disabled={!ready || parsedArgs === null} className="rounded bg-brand px-2 py-1 text-sm text-white disabled:opacity-50">Add</button>
			<button type="button" className="px-2 py-1 text-sm text-zinc-500" onClick={onCancel}>Cancel</button>
		</form>
	);
}

export { callAction };

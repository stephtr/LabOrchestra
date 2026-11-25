import { ReactNode, useState } from 'react';
import { formatNumber, parseFrequency, unitFor } from './format';
import { widget, WidgetInstance } from './layout';
import { formatSI } from './OscilloscopeWidget';
import { ActionSchema, callAction, DeviceInfo } from './store';
import { Field, Tile, useRun } from './compact';
import { Button, FormRow, Input, Select } from './ui';
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
			<div className="flex items-baseline gap-1.5 whitespace-nowrap">
				<span className="text-lg leading-7 tabular-nums" data-testid={`value-text-${device}-${path}`}>{show(value, unit)}</span>
				{unit && unit !== 'Hz' && <span className="text-xs text-faint">{unit}</span>}
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
					suffix={unit !== 'Hz' ? unit : undefined}
				/>
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
		<div className={`flex h-full items-center justify-center rounded-lg border bg-panel px-3 ${error ? 'border-warn' : 'border-line'}`} title={error ?? (!known ? `no action "${action}"` : undefined)}>
			<Button
				data-testid={`button-${device}-${action}`}
				disabled={!known}
				icon={error ? 'warning' : undefined}
				onClick={() => {
					if (props.confirm && !window.confirm(`${label(props, action)}?`)) return;
					void run(action, ...args);
				}}
			>
				{label(props, action)}
			</Button>
		</div>
	);
}

/** What a user picks for a widget of this kind: a state field, an action, a channel for actions that take one. */
export function CustomForm({ type, device, info, onCreate, onCancel, preview }: { type: 'value' | 'number' | 'button' | 'trace'; device: string; info: DeviceInfo; onCreate: (w: WidgetInstance) => void; onCancel: () => void; /** Shows what the widget would look like with these props. */ preview: (props: Record<string, unknown>) => ReactNode }) {
	const paths = leafPaths(info.state).filter((l) => type === 'value' || typeof l.value === 'number');
	const actions = info.schema?.actions ?? [];
	const [path, setPath] = useState(paths[0]?.path ?? '');
	/** The action that sets a field is usually called like it: channels.0.frequency -> set_frequency. */
	const actionFor = (field: string) => actions.find((a) => a.name === `set_${field.split('.').at(-1)}`)?.name;
	const [action, setAction] = useState((type === 'number' ? actionFor(path) : undefined) ?? actions[0]?.name ?? '');
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
	const props: Record<string, unknown> = {};
	if (type !== 'button') props.path = path;
	if (type === 'number' || type === 'button') props.action = action;
	if (needsChannel) props.channel = Number(channel);
	if (type === 'button' && parsedArgs?.length) props.args = parsedArgs;
	if (name.trim()) props.label = name.trim();
	return (
		<form
			data-testid="custom-form"
			className="flex flex-col gap-3"
			onSubmit={(e) => {
				e.preventDefault();
				if (!ready || parsedArgs === null) return;
				onCreate(widget(type, device, props));
			}}
		>
			{type !== 'button' && (
				<FormRow label="State field" htmlFor="custom-path">
					<Select id="custom-path" data-testid="custom-path" value={path} onChange={(e) => { setPath(e.target.value); if (type === 'number') setAction(actionFor(e.target.value) ?? action); }}>
						{paths.map((l) => <option key={l.path}>{l.path}</option>)}
					</Select>
				</FormRow>
			)}
			{type !== 'value' && type !== 'trace' && (
				<FormRow label="Action" htmlFor="custom-action" hint={chosen?.doc ?? undefined}>
					<Select id="custom-action" data-testid="custom-action" value={action} onChange={(e) => setAction(e.target.value)}>
						{actions.map((a) => <option key={a.name}>{a.name}</option>)}
					</Select>
				</FormRow>
			)}
			{needsChannel && (
				<FormRow label="Channel" htmlFor="custom-channel">
					<Input id="custom-channel" data-testid="custom-channel" type="number" min={0} value={channel} onChange={(e) => setChannel(e.target.value)} />
				</FormRow>
			)}
			{type === 'button' && (
				<FormRow label="Arguments" htmlFor="custom-args" hint="JSON, separated by commas, e.g. 0, true" error={parsedArgs === null ? 'This is not valid JSON' : undefined}>
					<Input id="custom-args" data-testid="custom-args" className="font-mono" value={args} onChange={(e) => setArgs(e.target.value)} />
				</FormRow>
			)}
			<FormRow label="Label" htmlFor="custom-label" hint="Optional">
				<Input id="custom-label" data-testid="custom-label" value={name} onChange={(e) => setName(e.target.value)} />
			</FormRow>
			{preview(props)}
			<div className="flex justify-end gap-2">
				<Button type="button" variant="ghost" onClick={onCancel}>Back</Button>
				<Button variant="primary" data-testid="custom-create" disabled={!ready || parsedArgs === null}>Add</Button>
			</div>
		</form>
	);
}

export { callAction };

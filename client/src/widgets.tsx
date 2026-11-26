import type { ComponentType } from 'react';
import { DeviceCard } from './DeviceCard';
import { StatusBadge } from './ui';
import { formatNumber, unitFor } from './format';
import { ButtonWidget, NumberWidget, ValueWidget } from './generic';
import { FrequencyWidget, PolarimeterWidget, PositionerWidget, PressureWidget, RecordingWidget, TurboPumpWidget } from './compact';
import { OscilloscopeWidget } from './OscilloscopeWidget';
import { TraceWidget } from './TraceWidget';
import type { DeviceInfo } from './store';
import type { PropSpec } from './settings';
import { RuntimeWidget, runtimeWidgets, useRuntimeWidgets, WidgetBoundary } from './runtimeWidgets';

/**
 * The kinds of widget the client knows. A widget either fills a pane ("main") or sits in the strip as a compact widget of fixed height:
 * "S" is one row, "M" two rows. Compact widgets may also be shown in a pane; main widgets do not fit the strip.
 */
export type WidgetSize = 'main' | 'S' | 'M';
export type WidgetProps = { id: string; device: string; info: DeviceInfo; props: Record<string, unknown> };
export type WidgetDef = {
	type: string;
	title: string;
	size: WidgetSize;
	/** Whether the widget can show this device. */
	accepts: (info: DeviceInfo) => boolean;
	/** The settings of an instance (besides the label every widget has): what the settings dialog offers. */
	props?: PropSpec[];
	/** Width in pixels in the strip (default: as wide as it is). */
	width?: number;
	/** One line for the picker: what the widget is for. */
	description?: string;
	/** Fits every device: the picker lists it once and asks for the device. */
	generic?: boolean;
	/** The user chooses a state field and/or an action in a form before the widget is added. */
	configure?: boolean;
	/** False for widgets of the whole server (recording): no device is chosen. */
	needsDevice?: boolean;
	/** What the picker offers for a device: one instance per channel (props {channel}); default one instance without props. */
	variants?: (info: DeviceInfo) => { label: string; props?: Record<string, unknown> }[];
	component: ComponentType<WidgetProps>;
};

function Summary({ device, info, props }: WidgetProps) {
	const state = info.state ?? {};
	const numbers = Object.entries(state)
		.filter(([, v]) => typeof v === 'number')
		.slice(0, 3) as [string, number][];
	return (
		<div className="flex h-full flex-col justify-center gap-0.5 rounded-lg border border-line bg-panel px-3" data-testid={`summary-${device}`}>
			<div className="flex items-center justify-between gap-3 text-xs leading-4">
				<span className="text-muted">{typeof props.label === 'string' && props.label ? props.label : device}</span>
				<StatusBadge status={info.status} />
			</div>
			<div className="flex min-h-7 items-center gap-3 whitespace-nowrap text-sm">
				{numbers.length === 0 && <span className="text-faint">—</span>}
				{numbers.map(([key, value]) => (
					<span key={key} className="tabular-nums">
						<span className="text-xs text-faint">{key.replaceAll('_', ' ')}</span> {formatNumber(value)}
						{unitFor(info.schema?.units, key) && <span className="ml-0.5 text-xs text-faint">{unitFor(info.schema?.units, key)}</span>}
					</span>
				))}
			</div>
		</div>
	);
}

const hasProfile = (info: DeviceInfo, name: string) => info.schema?.profiles?.some((p) => p.name === name) ?? false;

/** The part of a device's state that belongs to a profile: at the top, or under the key the profile is mounted at. */
export function profileState(info: DeviceInfo, name: string): Record<string, unknown> {
	const at = info.schema?.profiles?.find((p) => p.name === name)?.at;
	const state = info.state ?? {};
	return at ? ((state[at] as Record<string, unknown> | null) ?? {}) : state;
}

const perChannel = (profile: string) => (info: DeviceInfo) => {
	const channels = profileState(info, profile).channels;
	return Array.isArray(channels) && channels.length > 0 ? channels.map((c, i) => ({ label: typeof (c as { name?: unknown })?.name === 'string' && (c as { name: string }).name ? (c as { name: string }).name : `channel ${i}`, props: { channel: i } })) : [{ label: 'channel 0', props: { channel: 0 } }];
};

const definitions: WidgetDef[] = [
	{ type: 'oscilloscope', description: 'Spectrum or time trace with the controls of the instrument', title: 'Oscilloscope', size: 'main', accepts: (i) => i.schema?.widget === 'oscilloscope', component: ({ id, device, info }) => <OscilloscopeWidget id={device} instanceId={id} info={info} /> },
	{ type: 'device_card', description: 'Everything a device has: state, actions and log', generic: true, title: 'Device card', size: 'main', accepts: () => true, component: ({ device, info }) => <DeviceCard id={device} info={info} /> },
	{ type: 'pressure', description: 'Pressure of one gauge', title: 'Pressure', size: 'S', props: [{ name: 'channel', label: 'Channel', type: 'integer', min: 0, default: 0 }], accepts: (i) => hasProfile(i, 'pressure_sensor'), variants: perChannel('pressure_sensor'), component: PressureWidget },
	{ type: 'turbo_pump', description: 'State and speed of a pump; click for the controls', title: 'Turbo pump', size: 'S', props: [{ name: 'channel', label: 'Channel', type: 'integer', min: 0, default: 0 }], accepts: (i) => hasProfile(i, 'turbo_pump'), variants: perChannel('turbo_pump'), component: TurboPumpWidget },
	{ type: 'positioner', description: 'Position of a stage, to type or to step', title: 'Stage', size: 'S', props: [{ name: 'channel', label: 'Channel', type: 'integer', min: 0, default: 0 }, { name: 'step', label: 'Step of the + and - buttons', type: 'number', min: 0.000001, help: 'Default: 1 degree, 10 micrometers' }], accepts: (i) => hasProfile(i, 'positioner'), variants: perChannel('positioner'), component: PositionerWidget },
	{ type: 'frequency', description: 'Frequency of an output, and on/off', title: 'Frequency', size: 'S', props: [{ name: 'channel', label: 'Channel', type: 'integer', min: 0, default: 0 }], accepts: (i) => hasProfile(i, 'frequency_generator'), variants: perChannel('frequency_generator'), component: FrequencyWidget },
	{ type: 'polarimeter', description: 'Polarization and power', title: 'Polarization', size: 'S', accepts: (i) => hasProfile(i, 'polarimeter'), component: PolarimeterWidget },
	{ type: 'recording', description: 'Start and stop recordings, take snapshots', title: 'Recording', size: 'S', needsDevice: false, accepts: () => false, component: RecordingWidget },
	{ type: 'value', description: 'Shows one value of a device', generic: true, title: 'Value', size: 'S', props: [{ name: 'path', label: 'State field', type: 'text' }], configure: true, accepts: () => true, component: ValueWidget },
	{ type: 'number', description: 'A number to type, sent with an action', generic: true, title: 'Number', size: 'S', props: [{ name: 'path', label: 'State field', type: 'text' }, { name: 'action', label: 'Action', type: 'text' }, { name: 'channel', label: 'Channel (for actions that take one)', type: 'integer', min: 0 }], configure: true, accepts: () => true, component: NumberWidget },
	{ type: 'button', description: 'Runs an action', generic: true, title: 'Button', size: 'S', props: [{ name: 'action', label: 'Action', type: 'text' }, { name: 'confirm', label: 'Ask before running', type: 'boolean' }], configure: true, accepts: () => true, component: ButtonWidget },
	{ type: 'trace', generic: true, description: 'A value over the last hours: now, change per hour, min and max, and its curve', title: 'Trace', size: 'M', width: 320, configure: true, props: [{ name: 'path', label: 'State field', type: 'text' }, { name: 'range', label: 'Time range', type: 'select', options: ['1h', '6h', '24h', '7d'], default: '6h' }, { name: 'scale', label: 'Scale', type: 'select', options: ['linear', 'log'], default: 'linear', help: 'Log suits pressures that change by orders of magnitude' }], accepts: (i) => Object.keys(i.state ?? {}).length > 0, component: TraceWidget },
	{ type: 'summary', description: 'Status and the first values of a device', generic: true, title: 'Summary', size: 'S', accepts: () => true, component: Summary },
];

/** A widget of the workspace (widgets/<name>.tsx) as an entry of the registry: its type is "ws:<name>". */
const runtimeDefs = new WeakMap<RuntimeWidget, WidgetDef>();

/** One definition per loaded version: a new component function on every call would make React remount the widget at every render. */
function runtimeDef(w: RuntimeWidget): WidgetDef {
	let def = runtimeDefs.get(w);
	if (!def) runtimeDefs.set(w, (def = makeRuntimeDef(w)));
	return def;
}

function makeRuntimeDef(w: RuntimeWidget): WidgetDef {
	const meta = w.module?.meta;
	const Module = w.module?.component;
	return {
		type: w.name,
		title: meta?.title ?? w.name,
		size: meta?.size ?? 'S',
		needsDevice: meta?.needsDevice,
		props: meta?.props,
		generic: !meta?.profile && meta?.needsDevice !== false,
		description: w.error ? 'Has an error' : meta?.description,
		accepts: (info) => !meta?.profile || hasProfile(info, meta.profile),
		component: (props) =>
			Module ? (
				<WidgetBoundary key={w.version} name={w.name.replace(/^\w+:/, '')}>
					<Module {...props} />
				</WidgetBoundary>
			) : (
				<div data-testid={`widget-error-${w.name.replace(/^\w+:/, '')}`} className="h-full overflow-auto whitespace-pre-wrap rounded-lg border border-bad/40 bg-bad/10 p-2 font-mono text-xs text-bad">
					{w.error}
				</div>
			),
	};
}

/** The widgets that can be placed: the built-in ones and those of the workspace. */
export function allWidgetDefs(): WidgetDef[] {
	return [...definitions, ...Object.values(runtimeWidgets().widgets).map(runtimeDef)];
}

/** Like allWidgetDefs, for components: they render again when a widget is built or changed. */
export function useWidgetDefs(): WidgetDef[] {
	useRuntimeWidgets();
	return allWidgetDefs();
}

export const widgetDef = (type: string) => allWidgetDefs().find((d) => d.type === type);

/** Whether the workspace's widgets have been listed yet (before that "ws:..." is not unknown, just not here yet). */
export const runtimeWidgetsReady = () => runtimeWidgets().ready;

/** Pixel height of a compact widget: two sizes, so that the strip stays tidy. */
export const COMPACT_HEIGHT: Record<'S' | 'M', number> = { S: 60, M: 128 };

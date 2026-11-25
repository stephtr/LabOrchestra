import type { ComponentType } from 'react';
import { DeviceCard, STATUS_STYLE } from './DeviceCard';
import { formatNumber, unitFor } from './format';
import { ButtonWidget, NumberWidget, ValueWidget } from './generic';
import { FrequencyWidget, PolarimeterWidget, PositionerWidget, PressureWidget, RecordingWidget, TurboPumpWidget } from './compact';
import { OscilloscopeWidget } from './OscilloscopeWidget';
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
	/** The user chooses a state field and/or an action in a form before the widget is added. */
	configure?: boolean;
	/** False for widgets of the whole server (recording): no device is chosen. */
	needsDevice?: boolean;
	/** What the picker offers for a device: one instance per channel (props {channel}); default one instance without props. */
	variants?: (info: DeviceInfo) => { label: string; props?: Record<string, unknown> }[];
	component: ComponentType<WidgetProps>;
};

function Summary({ device, info }: WidgetProps) {
	const state = info.state ?? {};
	const numbers = Object.entries(state)
		.filter(([, v]) => typeof v === 'number')
		.slice(0, 3) as [string, number][];
	return (
		<div className="flex h-full flex-col justify-center rounded-lg bg-white px-3 py-1 text-sm shadow dark:bg-slate-900" data-testid={`summary-${device}`}>
			<div className="flex items-center gap-2">
				<span className="font-mono">{device}</span>
				<span className={`rounded-full px-1.5 text-xs ${STATUS_STYLE[info.status] ?? ''}`}>{info.status}</span>
			</div>
			{numbers.length > 0 && (
				<div className="flex gap-3 text-xs text-zinc-600 dark:text-zinc-300">
					{numbers.map(([key, value]) => (
						<span key={key}>
							{key} <span className="font-mono tabular-nums">{formatNumber(value)}</span>
							{unitFor(info.schema?.units, key) && <span className="ml-0.5 text-zinc-500">{unitFor(info.schema?.units, key)}</span>}
						</span>
					))}
				</div>
			)}
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
	return Array.isArray(channels) && channels.length > 0 ? channels.map((_, i) => ({ label: `channel ${i}`, props: { channel: i } })) : [{ label: 'channel 0', props: { channel: 0 } }];
};

const definitions: WidgetDef[] = [
	{ type: 'oscilloscope', title: 'Oscilloscope', size: 'main', accepts: (i) => i.schema?.widget === 'oscilloscope', component: ({ device, info }) => <OscilloscopeWidget id={device} info={info} /> },
	{ type: 'device_card', title: 'Device card', size: 'main', accepts: () => true, component: ({ device, info }) => <DeviceCard id={device} info={info} /> },
	{ type: 'pressure', title: 'Pressure', size: 'S', props: [{ name: 'channel', label: 'Channel', type: 'integer', min: 0, default: 0 }], accepts: (i) => hasProfile(i, 'pressure_sensor'), variants: perChannel('pressure_sensor'), component: PressureWidget },
	{ type: 'turbo_pump', title: 'Turbo pump', size: 'S', props: [{ name: 'channel', label: 'Channel', type: 'integer', min: 0, default: 0 }], accepts: (i) => hasProfile(i, 'turbo_pump'), variants: perChannel('turbo_pump'), component: TurboPumpWidget },
	{ type: 'positioner', title: 'Stage', size: 'S', props: [{ name: 'channel', label: 'Channel', type: 'integer', min: 0, default: 0 }, { name: 'step', label: 'Step of the + and - buttons', type: 'number', min: 0.000001, help: 'Default: 1 degree, 10 micrometers' }], accepts: (i) => hasProfile(i, 'positioner'), variants: perChannel('positioner'), component: PositionerWidget },
	{ type: 'frequency', title: 'Frequency', size: 'S', props: [{ name: 'channel', label: 'Channel', type: 'integer', min: 0, default: 0 }], accepts: (i) => hasProfile(i, 'frequency_generator'), variants: perChannel('frequency_generator'), component: FrequencyWidget },
	{ type: 'polarimeter', title: 'Polarization', size: 'S', accepts: (i) => hasProfile(i, 'polarimeter'), component: PolarimeterWidget },
	{ type: 'recording', title: 'Recording', size: 'S', needsDevice: false, accepts: () => false, component: RecordingWidget },
	{ type: 'value', title: 'Value…', size: 'S', props: [{ name: 'path', label: 'State field', type: 'text' }], configure: true, accepts: () => true, component: ValueWidget },
	{ type: 'number', title: 'Number…', size: 'S', props: [{ name: 'path', label: 'State field', type: 'text' }, { name: 'action', label: 'Action', type: 'text' }, { name: 'channel', label: 'Channel (for actions that take one)', type: 'integer', min: 0 }], configure: true, accepts: () => true, component: NumberWidget },
	{ type: 'button', title: 'Button…', size: 'S', props: [{ name: 'action', label: 'Action', type: 'text' }, { name: 'confirm', label: 'Ask before running', type: 'boolean' }], configure: true, accepts: () => true, component: ButtonWidget },
	{ type: 'summary', title: 'Summary', size: 'S', accepts: () => true, component: Summary },
];

/** A widget of the workspace (widgets/<name>.tsx) as an entry of the registry: its type is "ws:<name>". */
function runtimeDef(w: RuntimeWidget): WidgetDef {
	const meta = w.module?.meta;
	const Module = w.module?.component;
	return {
		type: `ws:${w.name}`,
		title: meta?.title ?? w.name,
		size: meta?.size ?? 'S',
		needsDevice: meta?.needsDevice,
		props: meta?.props,
		accepts: (info) => !meta?.profile || hasProfile(info, meta.profile),
		component: (props) =>
			Module ? (
				<WidgetBoundary key={w.version} name={w.name}>
					<Module {...props} />
				</WidgetBoundary>
			) : (
				<div data-testid={`widget-error-${w.name}`} className="h-full overflow-auto whitespace-pre-wrap rounded-lg border border-red-400 bg-red-50 p-2 font-mono text-xs text-red-800 dark:bg-red-950 dark:text-red-300">
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
export const COMPACT_HEIGHT: Record<'S' | 'M', number> = { S: 56, M: 116 };

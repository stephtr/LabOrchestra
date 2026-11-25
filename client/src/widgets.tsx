import type { ComponentType } from 'react';
import { DeviceCard, STATUS_STYLE } from './DeviceCard';
import { formatNumber, unitFor } from './format';
import { OscilloscopeWidget } from './OscilloscopeWidget';
import type { DeviceInfo } from './store';

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

const definitions: WidgetDef[] = [
	{ type: 'oscilloscope', title: 'Oscilloscope', size: 'main', accepts: (i) => i.schema?.widget === 'oscilloscope', component: ({ device, info }) => <OscilloscopeWidget id={device} info={info} /> },
	{ type: 'device_card', title: 'Device card', size: 'main', accepts: () => true, component: ({ device, info }) => <DeviceCard id={device} info={info} /> },
	{ type: 'summary', title: 'Summary', size: 'S', accepts: () => true, component: Summary },
];

export const widgetDefs: readonly WidgetDef[] = definitions;
export const widgetDef = (type: string) => definitions.find((d) => d.type === type);

/** Pixel height of a compact widget: two sizes, so that the strip stays tidy. */
export const COMPACT_HEIGHT: Record<'S' | 'M', number> = { S: 56, M: 116 };

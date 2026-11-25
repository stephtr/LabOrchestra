/**
 * The widget SDK: what a runtime widget (widgets/*.tsx in the workspace, or shipped by a device package) imports from "@laborchestra/widget".
 * Small on purpose and stable: it is the contract with code that is not in this repository. Additions only within a major version.
 * (gen-shims.mjs reads the exported names from here: only `export const|function|class` at the start of a line.)
 */
import { useEffect, useState } from 'react';
import { Field as FieldImpl, Tile as TileImpl, useRun } from './compact';
import { formatNumber as formatNumberImpl, parseFrequency as parseFrequencyImpl, unitFor as unitForImpl } from './format';
import { formatSI as formatSIImpl } from './OscilloscopeWidget';
import { callAction as callActionImpl, DeviceInfo, RecordingStatus, useStore } from './store';
import { StreamFrame, subscribeStream } from './stream';

export type { DeviceInfo, RecordingStatus, StreamFrame };

/** What a widget gets from the host as props: the widget instance's id, the device it is placed for, that device's current info, and its props. */
export type WidgetProps = { id: string; device: string; info: DeviceInfo; props: Record<string, unknown> };

/** What a widget module exports as `meta`, so that the picker knows it. */
export type WidgetMeta = {
	title: string;
	/** "main" fills a pane; "S" and "M" are the two heights of the strip. */
	size: 'main' | 'S' | 'M';
	/** The device profile the widget is for (e.g. "pressure_sensor"); without one it can be placed for any device. */
	profile?: string;
	/** False for a widget that shows no device. */
	needsDevice?: boolean;
};

export type Device = {
	id: string;
	status: string;
	error: string | null;
	/** The live state, a plain object. */
	state: Record<string, any>;
	/** Units of state fields by path, e.g. "channels.*.pressure": "mbar". */
	units: Record<string, string>;
	/** Calls an action of the device and resolves when it has finished (its effects are in `state` by then). Rejects with the device's error. */
	action: (name: string, ...args: unknown[]) => Promise<unknown>;
};

/** A device of the lab by id: its status, live state and actions. undefined while the device does not exist (yet). */
export function useDevice(id: string): Device | undefined {
	const info = useStore().devices[id];
	if (!info) return undefined;
	return {
		id,
		status: info.status,
		error: info.error,
		state: (info.state ?? {}) as Record<string, any>,
		units: info.schema?.units ?? {},
		action: (name, ...args) => callActionImpl(id, name, args),
	};
}

/** All devices by id. */
export function useDevices(): Record<string, DeviceInfo> {
	return useStore().devices;
}

/** Calls an action of a device (like `useDevice(id).action`, for use outside of components). */
export function callAction(device: string, name: string, ...args: unknown[]): Promise<unknown> {
	return callActionImpl(device, name, args);
}

/** The recording of the whole server. */
export function useRecording(): RecordingStatus {
	return useStore().recording;
}

/** The newest frame of a stream of a device (e.g. the oscilloscope's "display"), or null. Re-subscribes when the parameters change. */
export function useStream(device: string, stream: string, params: Record<string, unknown> = {}): StreamFrame | null {
	const [frame, setFrame] = useState<StreamFrame | null>(null);
	const key = JSON.stringify(params);
	useEffect(() => {
		const subscription = subscribeStream(device, stream, JSON.parse(key), setFrame);
		return () => subscription.close();
	}, [device, stream, key]);
	return frame;
}

/** Runs actions of a device and remembers the last failure: `const { run, error } = useAction("rf")`. */
export function useAction(device: string): { run: (action: string, ...args: unknown[]) => Promise<void>; error: string | null } {
	return useRun(device);
}

/** A small card with a label: the look of the compact widgets. */
export const Tile = TileImpl;
/** A number the user can type; applies on Enter or when leaving the field. */
export const NumberField = FieldImpl;
/** 1.5e6 -> "1.5 MHz" */
export const formatSI = formatSIImpl;
export const formatNumber = formatNumberImpl;
export const parseFrequency = parseFrequencyImpl;
export const unitFor = unitForImpl;

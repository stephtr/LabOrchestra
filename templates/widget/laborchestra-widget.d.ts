// Types of the widget SDK, for your editor. Kept next to your widgets by LabOrchestra; the real module is provided by the page.
declare module '@laborchestra/widget' {
	import type { ReactNode } from 'react';

	export type DeviceInfo = {
		status: string;
		error: string | null;
		schema: { id: string; class: string; units?: Record<string, string>; actions: { name: string; doc: string | null; params: { name: string; type: string; default: unknown; required: boolean }[] }[] } | null;
		state: Record<string, unknown> | null;
	};
	export type RecordingStatus = { active: boolean; name?: string; start_time?: string; elapsed_s?: number; events?: number };
	export type StreamFrame = { sequence: number; meta: Record<string, any>; data: Float32Array };

	/** What a widget gets as props. */
	export type WidgetProps = { id: string; device: string; info: DeviceInfo; props: Record<string, unknown> };
	/** What a widget module exports as `meta`, so that the picker knows it. */
	export type WidgetMeta = { title: string; size: 'main' | 'S' | 'M'; profile?: string; needsDevice?: boolean };
	export type Device = {
		id: string;
		status: string;
		error: string | null;
		state: Record<string, any>;
		units: Record<string, string>;
		action: (name: string, ...args: unknown[]) => Promise<unknown>;
	};

	export function useDevice(id: string): Device | undefined;
	export function useDevices(): Record<string, DeviceInfo>;
	export function callAction(device: string, name: string, ...args: unknown[]): Promise<unknown>;
	export function useRecording(): RecordingStatus;
	export function useStream(device: string, stream: string, params?: Record<string, unknown>): StreamFrame | null;
	export function useAction(device: string): { run: (action: string, ...args: unknown[]) => Promise<void>; error: string | null };

	export const Tile: (props: { label: string; testId: string; children: ReactNode; problem?: string | null }) => ReactNode;
	export const NumberField: (props: {
		value: number | null | undefined;
		format: (v: number) => string;
		parse: (text: string) => number;
		onCommit: (v: number) => void;
		testId: string;
		label: string;
	}) => ReactNode;
	export const formatSI: (value: number, unit: string) => string;
	export const formatNumber: (value: number) => string;
	export const parseFrequency: (text: string) => number;
	export const unitFor: (units: Record<string, string> | undefined, path: string) => string | undefined;
}

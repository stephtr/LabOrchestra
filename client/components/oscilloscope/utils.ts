/* eslint-disable no-constant-condition */
export interface OscilloscopeState {
	running: boolean;
	displayMode: 'time' | 'fft';
	fftFrequency: number;
	fftLength: number;
	fftAveragingMode: 'prefer-data' | 'prefer-display';
	fftAveragingDurationInMilliseconds: number;
	fftWindowFunction: string;
	testSignalFrequency: number;
	datapointsToSnapshot: number;
	channels: Array<{
		channelActive: boolean;
		rangeInMillivolts: number;
		coupling: 'AC' | 'DC';
	}>;
}

export type OscilloscopeStreamData = {
	XMin: number;
	XMax: number;
	XMinDecimated: number;
	XMaxDecimated: number;
	Mode: 'time' | 'fft';
	Length: number;
	Data: Array<number[] | null>;
};

export const fftLengthValues = [
	512,
	2 ** 10,
	2 ** 11,
	2 ** 12,
	2 ** 13,
	2 ** 14,
	2 ** 15,
	2 ** 16,
	2 ** 17,
	2 ** 18,
	2 ** 19,
	2 ** 20,
];

export const fftAveragingTimeInms = [
	0, 50, 100, 200, 500, 1000, 2000, 5000, 10000, -1,
];
export const fftAveragingMarksFor = [0, 100, 1000, 10000, -1];

export const fftWindowFunctions = [
	{ value: 'rectangular', label: 'Rectangular' },
	{ value: 'hann', label: 'Hann' },
	{ value: 'blackman', label: 'Blackman' },
	{ value: 'nuttall', label: 'Nuttall' },
];

export const datapointsToSaveOptions: Array<number> = [];
let decade = 1e4;
while (true) {
	datapointsToSaveOptions.push(1 * decade);
	if (decade === 1e8) break;
	datapointsToSaveOptions.push(2 * decade, 5 * decade);
	decade *= 10;
}

export function formatAveragingTime(ms: number) {
	if (ms === -1) return '∞';
	if (ms === 0) return 'off';
	if (ms < 1000) return `${ms} ms`;
	return `${new Intl.NumberFormat().format(ms / 1000)} s`;
}

export function formatFrequency(f: number) {
	const formatter = new Intl.NumberFormat();
	if (f >= 1e9) return `${formatter.format(f / 1e9)} GHz`;
	if (f >= 1e6) return `${formatter.format(f / 1e6)} MHz`;
	if (f >= 1e3) return `${formatter.format(f / 1e3)} kHz`;
	return `${formatter.format(f)} Hz`;
}

export function formatDatapoints(num: number) {
	if (num >= 1_000_000) return `${num / 1_000_000}M`;
	if (num >= 1_000) return `${num / 1_000}K`;
	return num.toString();
}

export const fftFrequencies: number[] = [];
decade = 1e3;
while (decade < 1e8) {
	fftFrequencies.push(1 * decade);
	if (decade === 1e7) break;
	fftFrequencies.push(2 * decade, 5 * decade);
	decade *= 10;
}

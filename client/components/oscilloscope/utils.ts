export interface OscilloscopeState {
	running: boolean;
	timeMode: 'time' | 'fft';
	fftFrequency: number;
	fftLength: number;
	fftAveragingMode: 'prefer-data' | 'prefer-display';
	fftAveragingDurationInMilliseconds: number;
	fftWindowFunction: string;
	testSignalFrequency: number;
	channels: Array<{
		channelActive: boolean;
		rangeInMillivolts: number;
	}>;
}

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

export const fftFrequencies: number[] = [];
let decade = 1e3;
while (decade < 1e8) {
	fftFrequencies.push(1 * decade, 2 * decade, 5 * decade);
	decade *= 10;
}

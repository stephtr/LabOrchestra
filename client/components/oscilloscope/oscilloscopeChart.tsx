'use client';

import { useMemo, useState } from 'react';
import { useStream } from '@/lib/controlHub';
import uPlot from 'uplot';
import { OscilloscopeState } from './utils';
import 'uplot/dist/uPlot.min.css';
import { UPlot } from '../UPlot';

function timeFormatterFactory(maxVal: number) {
	const formatter = Intl.NumberFormat();
	if (maxVal > 1.5) {
		return (val: number) => `${formatter.format(val)} s`;
	}
	if (maxVal > 1.5e-3) {
		return (val: number) => `${formatter.format(val * 1e3)} ms`;
	}
	if (maxVal > 1.5e-6) {
		return (val: number) => `${formatter.format(val * 1e6)} µs`;
	}
	return (val: number) => `${formatter.format(val * 1e9)} ns`;
}

function frequencyFormatterFactory(maxVal: number) {
	const formatter = Intl.NumberFormat();
	if (maxVal > 1.5e6) {
		return (val: number) => `${formatter.format(val / 1e6)} MHz`;
	}
	if (maxVal > 1.5e3) {
		return (val: number) => `${formatter.format(val / 1e3)} kHz`;
	}
	if (maxVal > 1.5) {
		return (val: number) => `${formatter.format(val)} Hz`;
	}
	return (val: number) => `${formatter.format(val / 1e-3)} mHz`;
}

type OscilloscopeStreamData = {
	XMin: number;
	XMax: number;
	Data: number[][];
	Mode: 'time' | 'fft';
	Length: number;
};

const colors = ['blue', 'red', 'green', 'yellow'];

export function OscilloscopeChart({
	state,
	deviceId,
}: {
	state?: OscilloscopeState;
	deviceId: string;
}) {
	const [data, setData] = useState<OscilloscopeStreamData | null>(null);

	useStream(deviceId, setData);

	const validChannels =
		data?.Data.map((d, i) => (d ? i : -1)).filter((i) => i >= 0) ?? [];

	const scales = useMemo<uPlot.Scales>(
		() =>
			Object.fromEntries([
				[
					'x',
					{
						range: [data?.XMin, data?.XMax],
						time: false,
					} as uPlot.Scale,
				],
				...(validChannels.map(
					(i) =>
						[
							`y${i}`,
							{
								range: [
									-(
										state?.channels[i].rangeInMillivolts ??
										0
									) / 1000,
									(state?.channels[i].rangeInMillivolts ??
										0) / 1000,
								],
							},
						] as const,
				) ?? []),
			]),
		[
			data?.XMin,
			data?.XMax,
			validChannels.join(''),
			state?.channels.map((c) => c.rangeInMillivolts).join('|'),
		],
	);
	const axes = useMemo<uPlot.Axis[]>(
		() => [
			{ label: 'x', stroke: 'white' },
			...validChannels.map((i) => ({
				label: `y${i}`,
				stroke: colors[i],
			})),
		],
		[validChannels.join('')],
	);

	const series = useMemo<uPlot.Series[]>(
		() =>
			validChannels.map<uPlot.Series>((i) => ({
				label: `Channel ${i}`,
				stroke: colors[i],
				scale: `y${i}`,
			})),
		[validChannels.join('')],
	);

	const xData = validChannels.length
		? new Array(data!.Data[validChannels[0]].length)
				.fill(0)
				.map(
					(_, i, a) =>
						(data!.XMin +
							(i / a.length) * (data!.XMax - data!.XMin)) /
						100000,
				)
		: [];

	return (
		<div className="h-full bg-white dark:bg-black dark:bg-opacity-50 rounded-lg p-2">
			<UPlot
				scales={scales}
				axes={axes}
				series={series}
				data={[xData, ...(data?.Data ?? [])]}
			/>
		</div>
	);
}

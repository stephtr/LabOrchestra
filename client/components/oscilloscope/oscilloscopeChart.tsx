'use client';

import { useCallback, useMemo, useState } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { useStream } from '@/lib/controlHub';
import { UPlot } from '../uPlot';
import { OscilloscopeState, OscilloscopeStreamData } from './utils';

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

const colors = ['blue', 'red', 'green', 'yellow'];

export function OscilloscopeChart({
	state,
	deviceId,
}: {
	state?: OscilloscopeState;
	deviceId: string;
}) {
	const [data, setData] = useState<OscilloscopeStreamData>({
		XMin: 0,
		XMax: 0,
		XMinDecimated: 0,
		XMaxDecimated: 0,
		Data: [],
		Mode: 'time',
		Length: 0,
	});

	const { isConnected: isStreamConnected, setCustomization } = useStream(
		deviceId,
		useCallback((newData: OscilloscopeStreamData) => setData(newData), []),
	);

	const validChannels =
		data?.Data.map((d, i) => (d ? i : -1)).filter((i) => i >= 0) ?? [];

	const channelHash = state?.channels
		.map((c) => c.channelActive + c.rangeInMillivolts.toString())
		.join('.');
	const scales = useMemo<uPlot.Scales>(
		() =>
			Object.fromEntries([
				[
					'x',
					{
						range: [data?.XMin / 1_000_000, data?.XMax / 1_000_000],
						time: false,
					} as uPlot.Scale,
				],
				...(validChannels.map(
					(i) =>
						[
							`y${i}`,
							{
								range: [-100, 20],
							},
						] as const,
				) ?? []),
			]),
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[data?.XMin, data?.XMax, channelHash],
	);
	const axes = useMemo<uPlot.Axis[]>(
		() => [
			{ label: 'x', stroke: 'white' },
			...validChannels.map((i) => ({
				label: `y${i}`,
				stroke: colors[i],
			})),
		],
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[validChannels.join('')],
	);

	const series = useMemo<uPlot.Series[]>(
		() =>
			validChannels.map<uPlot.Series>((i) => ({
				label: `Channel ${i}`,
				stroke: colors[i],
				scale: `y${i}`,
			})),
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[validChannels.join('')],
	);
	const xData = validChannels.length
		? new Array(data!.Data[validChannels[0]].length)
				.fill(0)
				.map(
					(_, i, a) =>
						(data!.XMin +
							(i / a.length) * (data!.XMax - data!.XMin)) /
						1_000_000,
				)
		: [];
	return (
		<div className="h-full bg-white dark:bg-black dark:bg-opacity-50 rounded-lg p-2">
			<div className="relative h-full">
				<UPlot
					scales={scales}
					axes={axes}
					series={series}
					data={[xData, ...(data?.Data ?? [])]}
				/>
			</div>
		</div>
	);
}

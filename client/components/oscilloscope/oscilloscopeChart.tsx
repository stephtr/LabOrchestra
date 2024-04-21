'use client';

import { useCallback, useMemo, useState } from 'react';
import { Chart } from 'react-chartjs-2';
import 'chart.js/auto';
import { useStream } from '@/lib/controlHub';

import { ChartOptions, Chart as RawChart } from 'chart.js';

if (typeof window !== 'undefined') {
	const zoomPlugin = require('chartjs-plugin-zoom').default;
	RawChart.register(zoomPlugin);
}

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

export function OscilloscopeChart() {
	const [data, setData] = useState<OscilloscopeStreamData>({
		XMin: 0,
		XMax: 0,
		Data: [],
		Mode: 'time',
		Length: 0,
	});

	const { isConnected: isStreamConnected } = useStream(
		'myOsci',
		useCallback((newData: OscilloscopeStreamData) => setData(newData), []),
	);

	const labels = useMemo(
		() =>
			new Array(data.Length)
				.fill(0)
				.map(
					(_, i) =>
						data.XMin +
						(i / (data.Length - 1)) * (data.XMax - data.XMin),
				),
		[data.Length, data.XMin, data.XMax],
	);
	const options = useMemo<ChartOptions<'line'>>(
		() => ({
			animation: false,
			scales: {
				x: {
					type: 'linear',
					grid: { color: '#555' },
					ticks: {
						callback: (data.Mode === 'fft'
							? frequencyFormatterFactory(data.XMax)
							: timeFormatterFactory(data.XMax)) as any,
					},
					min: data.XMin,
					max: data.XMax,
				},
				y: {
					type: 'linear',
					min: data.Mode === 'fft' ? -90 : -1,
					max: data.Mode === 'fft' ? 0 : +1,
					grid: { color: '#555' },
				},
			},
			resizeDelay: 10,
			maintainAspectRatio: false,
			plugins: {
				tooltip: { enabled: false },
				legend: { display: false },
				zoom: {
					pan: { enabled: true },
					zoom: {
						wheel: {
							enabled: true,
						},
						mode: 'x',
					},
					limits: {
						x: {
							min: data.XMin,
							max: data.XMax,
						},
					},
				},
			},
		}),
		[data.Mode, data.XMin, data.XMax],
	);
	return (
		<div className="h-full bg-white dark:bg-black dark:bg-opacity-50 rounded-lg p-2">
			<div className="relative h-full">
				<Chart
					type="line"
					options={options}
					data={{
						datasets:
							data.Data.map((d, i) => ({
								label: i.toString(),
								data: isStreamConnected ? d : [],
								pointRadius: 0,
								borderWidth: 2,
								borderColor: ['blue', 'red', 'green', 'yellow'][
									i
								],
							})) ?? [],
						labels,
					}}
				/>
			</div>
		</div>
	);
}

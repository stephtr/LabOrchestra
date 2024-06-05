'use client';

import { useCallback, useMemo, useState } from 'react';
import { Chart } from 'react-chartjs-2';
import 'chart.js/auto';
import { useStream } from '@/lib/controlHub';

import { ChartOptions, Chart as RawChart } from 'chart.js';
import { OscilloscopeState, OscilloscopeStreamData } from './utils';

if (typeof window !== 'undefined') {
	// eslint-disable-next-line global-require
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
	const labels = useMemo(
		() =>
			new Array(data.Length)
				.fill(0)
				.map(
					(_, i) =>
						(data.XMinDecimated ?? data.XMin) +
						(i / (data.Length - 1)) *
							((data.XMaxDecimated ?? data.XMax) -
								(data.XMinDecimated ?? data.XMin)),
				),
		[
			data.Length,
			data.XMin,
			data.XMax,
			data.XMinDecimated,
			data.XMaxDecimated,
		],
	);
	const channelHash = state?.channels
		.map((c) => c.channelActive + c.rangeInMillivolts.toString())
		.join('.');
	const options = useMemo<ChartOptions<'line'>>(() => {
		const yFFT = {
			yFFT: {
				type: 'linear',
				min: -120,
				max: 0,
				grid: { color: '#555' },
			},
		};
		let axisCountLeft = 0;
		const yTime = Object.fromEntries(
			state?.channels
				.map((c, ch) => ({
					id: ch,
					range: c.rangeInMillivolts,
					active: c.channelActive,
				}))
				.filter((c) => c.active)
				.map((c) => {
					axisCountLeft++;
					return [
						`y${c.id}`,
						{
							type: 'linear',
							position: axisCountLeft > 2 ? 'right' : 'left',
							min:
								data.Mode === 'fft' || data.Mode === 'het'
									? -120
									: -c.range / 1000,
							max:
								data.Mode === 'fft' || data.Mode === 'het'
									? 0
									: +c.range / 1000,
							grid: { color: '#555', tickColor: colors[c.id] },
							ticks: {
								color: colors[c.id],
							},
						},
					];
				}) ?? [],
		);
		const onPanOrZoom = ({ chart }: { chart: any }) => {
			// eslint-disable-next-line no-underscore-dangle
			const xMin = chart._options.scales.x.min;
			// eslint-disable-next-line no-underscore-dangle
			const xMax = chart._options.scales.x.max;
			const updatedXMin = (xMin + xMax) / 2 - (xMax - xMin) / 2;
			const updatedXMax = (xMin + xMax) / 2 + (xMax - xMin) / 2;
			setCustomization({ xMin: updatedXMin, xMax: updatedXMax });
		};
		return {
			animation: false,
			scales: {
				x: {
					type: 'linear',
					grid: { color: '#555' },
					ticks: {
						callback: (data.Mode === 'fft' || data.Mode === 'het'
							? frequencyFormatterFactory(data.XMax)
							: timeFormatterFactory(data.XMax)) as any,
					},
					min: data.XMin,
					max: data.XMax,
				},
				...(data.Mode === 'fft' || data.Mode === 'het' ? yFFT : yTime),
			},
			resizeDelay: 10,
			maintainAspectRatio: false,
			plugins: {
				tooltip: { enabled: false },
				legend: { display: false },
				decimation: {
					enabled: true,
					algorithm: 'lttb',
				},
				zoom: {
					pan: {
						enabled: true,
						mode: 'x',
						onPan: onPanOrZoom,
					},
					zoom: {
						wheel: {
							enabled: true,
						},
						mode: 'x',
						onZoom: onPanOrZoom,
					},
					limits: {
						x: {
							min: data.XMin,
							max: data.XMax,
						},
						y: {
							min: -1,
							max: 1,
						},
					},
				},
			},
		} as ChartOptions<'line'>;
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [data.Mode, data.XMin, data.XMax, channelHash]);
	return (
		<div className="h-full bg-white dark:bg-black dark:bg-opacity-50 rounded-lg p-2">
			<div className="relative h-full">
				<Chart
					type="line"
					options={options}
					data={{
						datasets:
							data.Data.map((d, i) => [d, i] as const)
								// eslint-disable-next-line @typescript-eslint/no-unused-vars
								.filter(([d, _]) => !!d)
								.map(([d, i]) => ({
									label: i.toString(),
									yAxisID:
										data.Mode === 'fft' ||
										data.Mode === 'het'
											? 'yFFT'
											: `y${i}`,
									data: isStreamConnected ? d : [],
									pointRadius: 0,
									borderWidth: 2,
									borderColor: colors[i],
								})) ?? [],
						labels,
					}}
				/>
			</div>
		</div>
	);
}

'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Chart } from 'react-chartjs-2';
import 'chart.js/auto';
import { useStream } from '@/lib/controlHub';

import { ChartOptions, Chart as RawChart } from 'chart.js';
import { OscilloscopeState, OscilloscopeStreamData } from './utils';
import { createWebglPlugin } from './webglPlugin';

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

function frequencyFormatterFactory(maxVal: number, spreadLog10: number) {
	if (maxVal > 1.5e6) {
		spreadLog10 -= 6;
		const formatter = Intl.NumberFormat(undefined, {
			maximumFractionDigits: Math.max(0, 2 - spreadLog10),
		});
		return (val: number) => `${formatter.format(val / 1e6)} MHz`;
	}
	if (maxVal > 1.5e3) {
		spreadLog10 -= 3;
		const formatter = Intl.NumberFormat(undefined, {
			maximumFractionDigits: Math.max(0, 2 - spreadLog10),
		});
		return (val: number) => `${formatter.format(val / 1e3)} kHz`;
	}
	if (maxVal > 1.5) {
		const formatter = Intl.NumberFormat(undefined, {
			maximumFractionDigits: Math.max(0, 2 - spreadLog10),
		});
		return (val: number) => `${formatter.format(val)} Hz`;
	}
	spreadLog10 += 3;
	const formatter = Intl.NumberFormat(undefined, {
		maximumFractionDigits: Math.max(0, 2 - spreadLog10),
	});
	return (val: number) => `${formatter.format(val / 1e-3)} mHz`;
}

const colors = ['deepskyblue', 'red', 'green', 'yellow'];

export function OscilloscopeChart({
	state,
	deviceId,
	frequencyOffset,
}: {
	state?: OscilloscopeState;
	deviceId: string;
	frequencyOffset: number;
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
	const xOffset = data.Mode === 'fft' ? frequencyOffset : 0;

	const { isConnected: isStreamConnected, setCustomization } = useStream(
		deviceId,
		useCallback((newData: OscilloscopeStreamData) => {
			const buffer = (newData as any).Data as Uint8Array;
			const channelsInData = (newData as any).ChannelsInData as number[];
			newData.Data = new Array(4).fill(0).map((_, i) => {
				const indexInBuffer = channelsInData.indexOf(i);
				if (indexInBuffer !== -1) {
					return new Float32Array(
						buffer.buffer,
						buffer.byteOffset +
							(indexInBuffer * buffer.byteLength) /
								channelsInData.length,
						Math.floor(
							buffer.byteLength / channelsInData.length / 4,
						),
					);
				}
				return null;
			});
			setData(newData);
		}, []),
	);

	const chartRef = useRef<RawChart>(null);

	const labels = useMemo(
		() =>
			new Array(data.Length)
				.fill(0)
				.map(
					(_, i) =>
						(data.XMinDecimated ?? data.XMin) +
						(i / (data.Length - 1)) *
							((data.XMaxDecimated ?? data.XMax) -
								(data.XMinDecimated ?? data.XMin)) -
						xOffset,
				),
		[
			data.Length,
			data.XMin,
			data.XMax,
			data.XMinDecimated,
			data.XMaxDecimated,
			xOffset,
		],
	);
	const channelHash = state?.channels
		.map((c) => c.channelActive + c.rangeInMillivolts.toString())
		.join('.');
	const maxDecimatedXValueAbs = Math.max(
		Math.abs(data.XMinDecimated - xOffset),
		Math.abs(data.XMaxDecimated - xOffset),
	);
	const xValueSpreadLog10 =
		(data.XMaxDecimated - data.XMinDecimated == 0)
			? 0
			: Math.round(Math.log10(data.XMaxDecimated - data.XMinDecimated));
	useEffect(() => {
		const xTicks = chartRef.current?.options.scales?.['x']?.ticks;
		if (!xTicks) return;
		xTicks.callback = (
			data.Mode === 'fft'
				? frequencyFormatterFactory(
						maxDecimatedXValueAbs,
						xValueSpreadLog10,
					)
				: timeFormatterFactory(data.XMax)
		) as any;
	}, [maxDecimatedXValueAbs, xValueSpreadLog10]);
	const options = useMemo<ChartOptions<'line'>>(() => {
		const yFFT = {
			yFFT: {
				type: 'linear',
				min: -80,
				max: 10,
				grid: { color: '#999' },
				ticks: { color: '#999' },
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
							min: data.Mode === 'fft' ? -120 : -c.range / 1000,
							max: data.Mode === 'fft' ? 0 : +c.range / 1000,
							grid: { color: '#999', tickColor: colors[c.id] },
							ticks: {
								color: colors[c.id],
							},
						},
					];
				}) ?? [],
		);
		const onPanOrZoom = ({ chart }: { chart: any }) => {
			// eslint-disable-next-line no-underscore-dangle
			const xMin = chart._options.scales.x.min + xOffset;
			// eslint-disable-next-line no-underscore-dangle
			const xMax = chart._options.scales.x.max + xOffset;
			const updatedXMin = (xMin + xMax) / 2 - (xMax - xMin) / 2;
			const updatedXMax = (xMin + xMax) / 2 + (xMax - xMin) / 2;
			setCustomization({ xMin: updatedXMin, xMax: updatedXMax });
		};
		return {
			animation: false,
			scales: {
				x: {
					type: 'linear',
					grid: { color: '#999' },
					ticks: {
						color: '#999',
						callback: (data.Mode === 'fft'
							? frequencyFormatterFactory(maxDecimatedXValueAbs, xValueSpreadLog10)
							: timeFormatterFactory(data.XMax)) as any,
					},
					min: data.XMin - xOffset,
					max: data.XMax - xOffset,
				},
				...(data.Mode === 'fft' ? yFFT : yTime),
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
						scaleMode: 'y',
						onPan: onPanOrZoom,
					},
					zoom: {
						wheel: {
							enabled: true,
						},
						mode: 'x',
						scaleMode: 'y',
						onZoom: onPanOrZoom,
					},
					limits: {
						x: {
							min: data.XMin - xOffset,
							max: data.XMax - xOffset,
						},
					},
				},
			},
		} as ChartOptions<'line'>;
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [data.Mode, data.XMin, data.XMax, channelHash, xOffset]);

	return (
		<div className="h-full bg-white dark:bg-black dark:bg-opacity-50 rounded-lg p-2">
			<div className="relative h-full">
				<Chart
					type="line"
					options={options}
					plugins={[createWebglPlugin()]}
					ref={chartRef as any}
					data={{
						datasets:
							data.Data.map((d, i) => [d, i] as const)
								// eslint-disable-next-line @typescript-eslint/no-unused-vars
								.filter(([d, _]) => !!d)
								.map(([d, i]) => ({
									label: i.toString(),
									yAxisID:
										data.Mode === 'fft' ? 'yFFT' : `y${i}`,
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

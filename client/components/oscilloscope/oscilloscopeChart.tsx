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

function zoomPlugin(opts?: {
	factor?: number;
	onZoom?: (xMin: number, xMax: number) => void;
}): uPlot.Plugin {
	const factor = opts?.factor ?? 0.75;
	const onZoom = opts?.onZoom;
	function clamp(
		nRange: number,
		nMin: number,
		nMax: number,
		fRange: number,
		fMin: number,
		fMax: number,
	) {
		if (nRange > fRange) {
			nMin = fMin;
			nMax = fMax;
		} else if (nMin < fMin) {
			nMin = fMin;
			nMax = fMin + nRange;
		} else if (nMax > fMax) {
			nMax = fMax;
			nMin = fMax - nRange;
		}

		return [nMin, nMax];
	}
	return {
		hooks: {
			ready: (u) => {
				const xMin = u.scales.x.min;
				const xMax = u.scales.x.max;
				const yMin = u.scales.y.min;
				const yMax = u.scales.y.max;
				if (
					typeof xMin === 'undefined' ||
					typeof xMax === 'undefined' ||
					typeof yMin === 'undefined' ||
					typeof yMax === 'undefined'
				)
					return;
				const xRange = xMax - xMin;
				const yRange = yMax - yMin;

				const { over } = u;
				const rect = over.getBoundingClientRect();
				over.addEventListener('wheel', (e) => {
					e.preventDefault();
					const { left, top } = u.cursor;
					if (
						typeof left === 'undefined' ||
						typeof top === 'undefined'
					)
						return;

					const leftPct = left / rect.width;
					const btmPct = 1 - top / rect.height;
					const xVal = u.posToVal(left, 'x');
					const yVal = u.posToVal(top, 'y');
					const oxRange = u.scales.x.max! - u.scales.x.min!;
					const oyRange = u.scales.y.max! - u.scales.y.min!;

					const nxRange =
						e.deltaY < 0 ? oxRange * factor : oxRange / factor;
					let nxMin = xVal - leftPct * nxRange;
					let nxMax = nxMin + nxRange;
					/* [nxMin, nxMax] = clamp(
						nxRange,
						nxMin,
						nxMax,
						xRange,
						xMin,
						xMax,
					); */

					const nyRange =
						e.deltaY < 0 ? oyRange * factor : oyRange / factor;
					let nyMin = yVal - btmPct * nyRange;
					let nyMax = nyMin + nyRange;
					[nyMin, nyMax] = clamp(
						nyRange,
						nyMin,
						nyMax,
						yRange,
						yMin,
						yMax,
					);

					onZoom?.(nxMin, nxMax);
					u.batch(() => {
						u.setScale('x', {
							min: nxMin,
							max: nxMax,
						});

						u.setScale('y', {
							min: nyMin,
							max: nyMax,
						});
					});
				});
			},
		},
	};
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
						range: [
							data?.XMinDecimated / 1_000_000,
							data?.XMaxDecimated / 1_000_000,
						],
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
		[data?.XMinDecimated, data?.XMaxDecimated, channelHash],
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
		() => [
			{},
			...validChannels.map<uPlot.Series>((i) => ({
				label: `Channel ${i}`,
				stroke: colors[i],
				scale: `y${i}`,
			})),
		],
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
	const zoomPluginInstance = useMemo(
		() =>
			zoomPlugin({
				onZoom: (xMin, xMax) =>
					setCustomization({
						xMin: xMin * 1_000_000,
						xMax: xMax * 1_000_000,
					}),
			}),
		[isStreamConnected],
	);
	return (
		<div className="h-full bg-white dark:bg-black dark:bg-opacity-50 rounded-lg p-2">
			<div className="relative h-full">
				<UPlot
					scales={scales}
					axes={axes}
					series={series}
					plugins={[zoomPluginInstance]}
					data={[xData, ...(data?.Data ?? [])]}
				/>
			</div>
		</div>
	);
}

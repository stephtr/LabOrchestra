import { useEffect, useRef, useState } from 'react';
import uPlot from 'uplot';

interface Props {
	className?: string;
	axes: uPlot.Axis[];
	series: uPlot.Series[];
	scales: uPlot.Scales;
	data: uPlot.AlignedData;
}

export function UPlot({ className = '', axes, series, scales, data }: Props) {
	const ref = useRef<HTMLDivElement>(null);
	const [plot, setPlot] = useState<uPlot | null>(null);
	useEffect(() => {
		if (!ref.current) return;
		const options: uPlot.Options = {
			width: ref.current.offsetWidth,
			height: ref.current.offsetHeight,
			series,
			axes,
			scales,
			cursor: {
				lock: true,
				focus: {
					prox: 16,
				},
				sync: {
					key: 'moo',
					setSeries: false,
				},
				drag: {
					x: true,
					y: false,
					setScale: true,
				},
			},
			select: {
				show: true,
				left: 0,
				top: 0,
				width: 0,
				height: 0,
			},
		};
		// eslint-disable-next-line new-cap
		const initialPlot = new uPlot(options, [], ref.current);
		setPlot(initialPlot);
		const elem = ref.current;
		const observer = new ResizeObserver(() => {
			initialPlot.setSize({
				width: elem.offsetWidth,
				height: elem.offsetHeight,
			});
		});
		observer.observe(elem);
		return () => {
			observer.disconnect();
			initialPlot.destroy();
		};
	}, [ref, series, axes, scales]);
	useEffect(() => {
		if (!plot) return;
		plot.setData(data);
	}, [plot, data]);
	return (
		<div
			className={`overflow-hidden h-full w-full ${className}`}
			ref={ref}
		/>
	);
}

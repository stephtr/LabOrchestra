import { Tab, Tabs } from '@nextui-org/react';
import { VerticalControlBar } from './verticalControlBar';
import { OscilloscopeChart } from './oscilloscopeChart';

export interface OscilloscopeState {
	running: boolean;
	mode: 'time' | 'fft';
	channels: Array<{
		active: boolean;
		rangeInMillivolts: number;
	}>;
}

export function Oscilloscope({ topContent }: { topContent?: React.ReactNode }) {
	return (
		<div className="h-full grid grid-cols-[10rem,1fr] grid-rows-[3.5rem,1fr]">
			<VerticalControlBar />
			<div className="col-start-2 flex items-center mr-1">
				<Tabs>
					<Tab title="Time trace" />
					<Tab title="FFT" />
				</Tabs>
				{topContent}
			</div>
			<main className="col-start-2 row-start-2 overflow-hidden">
				<OscilloscopeChart />
			</main>
		</div>
	);
}

import { useEffect, useState } from 'react';
import { faChevronRight } from '@/lib/fortawesome/pro-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
	Button,
	ButtonGroup,
	Popover,
	PopoverContent,
	PopoverTrigger,
	Slider,
	Tab,
	Tabs,
} from '@nextui-org/react';
import { useChannelControl } from '@/lib/controlHub';
import { OscilloscopeState } from './utils';

const ranges = [50, 100, 200, 500, 1000, 2000, 5000, 10_000, 20_000];

function formatRange(range: number) {
	if (range < 1000) {
		return `${range} mV`;
	}
	return `${range / 1000} V`;
}
const marks: Array<{ value: number; label: string }> = [];
const marksFor = [100, 1000, 10_000];
marksFor.forEach((range) => {
	const index = ranges.indexOf(range);
	if (index >= 0) {
		marks.push({ value: index, label: formatRange(range) });
	}
});

export function ChannelButton({
	label,
	channelIndex,
	action: devAction,
	state: devState,
}: {
	label: string;
	channelIndex: number;
	action: (name: string, ...params: any[]) => void;
	state?: OscilloscopeState;
}) {
	const [state, action] = useChannelControl(
		devState,
		devAction,
		channelIndex,
	);
	const [currentRange, setCurrentRange] = useState<number>(
		state ? ranges.indexOf(state.rangeInMillivolts) : 0,
	);
	useEffect(() => {
		if (state) setCurrentRange(ranges.indexOf(state.rangeInMillivolts));
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [state?.rangeInMillivolts]);
	let borderClass = '';
	let borderSClass = '';
	let fillerClass = '';
	switch (channelIndex) {
		case 0:
			borderClass = 'border-blue-600';
			borderSClass = 'border-s-blue-600';
			fillerClass = 'bg-blue-600';
			break;
		case 1:
			borderClass = 'border-red-600';
			borderSClass = 'border-s-red-600';
			fillerClass = 'bg-red-600';
			break;
		case 2:
			borderClass = 'border-green-600';
			borderSClass = 'border-s-green-600';
			fillerClass = 'bg-green-600';
			break;
		case 3:
			borderClass = 'border-yellow-600';
			borderSClass = 'border-s-yellow-600';
			fillerClass = 'bg-yellow-600';
			break;
		default:
			borderClass = 'border-gray-600';
			borderSClass = 'border-s-gray-600';
			fillerClass = 'bg-gray-600';
	}
	return (
		<ButtonGroup variant="flat" className="w-full mt-2">
			<Button
				className={`w-full h-12 flex-1 border-l-8 ${borderClass} ${state?.channelActive ? '' : 'border-opacity-20'}`}
				onPress={() => action('setChannelActive', !state.channelActive)}
				isDisabled={!state}
			>
				{label}
			</Button>
			<Popover placement="right-start">
				<PopoverTrigger>
					<Button isIconOnly className="h-12" isDisabled={!state}>
						<FontAwesomeIcon icon={faChevronRight} />
					</Button>
				</PopoverTrigger>
				<PopoverContent
					aria-label="Channel settings"
					className="w-[300px] items-start gap-3 py-2 px-3"
				>
					<h2 className="text-xl">{label} Settings</h2>
					<Slider
						label="Range"
						maxValue={ranges.length - 1}
						marks={marks}
						getValue={(i) =>
							`± ${formatRange(ranges[i as number])}`
						}
						value={currentRange}
						onChange={(v) => setCurrentRange(v as number)}
						onChangeEnd={(v) => {
							action('setRange', ranges[v as number]);
							if (state)
								setCurrentRange(
									ranges.indexOf(state.rangeInMillivolts),
								);
						}}
						classNames={{
							filler: fillerClass,
							track: borderSClass,
							thumb: fillerClass,
						}}
					/>
					<div className="mt-4 mb-1">Coupling</div>
					<Tabs
						aria-label="Coupling"
						isDisabled={!state}
						selectedKey={state?.coupling}
						onSelectionChange={(v) => {
							action('SetCoupling', v);
						}}
					>
						<Tab title="AC" key="AC" />
						<Tab title="DC" key="DC" />
					</Tabs>
				</PopoverContent>
			</Popover>
		</ButtonGroup>
	);
}

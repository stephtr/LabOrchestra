import { useEffect, useState } from 'react';
import { faChevronDown } from '@/lib/fortawesome/pro-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { Button, ButtonGroup, Popover, PopoverContent, PopoverTrigger, Slider, Tab, Tabs } from '@nextui-org/react';
import { OscilloscopeState } from '.';

const ranges = [50, 100, 200, 500, 1000, 2000, 5000, 10_000, 20_000];

function formatRange(range: number) {
    if (range < 1000) {
        return range + ' mV';
    }
    return (range / 1000) + ' V';
}
const marks: Array<{ value: number, label: string }> = [];
const marksFor = [100, 1000, 10_000];
marksFor.forEach(range => {
    const index = ranges.indexOf(range);
    if (index >= 0) {
        marks.push({ value: index, label: formatRange(range) });
    }
});

export function ChannelButton({ label, channelIndex, action, state }: { label: string, channelIndex: number, action: (name: string, ...params: any[]) => void, state: OscilloscopeState }) {
    const [currentRange, setCurrentRange] = useState<number>(ranges.indexOf(state?.rangeInMillivolts));
    useEffect(() => {
        setCurrentRange(ranges.indexOf(state?.rangeInMillivolts))
    }, [state?.rangeInMillivolts]);
    let borderClass = '';
    let borderSClass = '';
    let fillerClass = '';
    switch (channelIndex) {
        case 1:
            borderClass = 'border-blue-600';
            borderSClass = 'border-s-blue-600';
            fillerClass = 'bg-blue-600';
            break;
        case 2:
            borderClass = 'border-red-600';
            borderSClass = 'border-s-red-600';
            fillerClass = 'bg-red-600';
            break;
        case 3:
            borderClass = 'border-green-600';
            borderSClass = 'border-s-green-600';
            fillerClass = 'bg-green-600';
            break;
        case 4:
            borderClass = 'border-yellow-600';
            borderSClass = 'border-s-yellow-600';
            fillerClass = 'bg-yellow-600';
            break;
        default:
            borderClass = 'border-gray-600';
            borderSClass = 'border-s-gray-600';
            fillerClass = 'bg-gray-600';
    }
    return <ButtonGroup variant="flat" className="w-full mt-2">
        <Button className={`w-full h-12 flex-1 border-l-8 ${borderClass}`}>{label}</Button>
        <Popover placement='right-start'>
            <PopoverTrigger>
                <Button isIconOnly className="h-12">
                    <FontAwesomeIcon icon={faChevronDown} />
                </Button>
            </PopoverTrigger>
            <PopoverContent aria-label="Channel settings" className="w-[300px]">
                <h2 className="text-xl">{label} Settings</h2>
                <Slider
                    label="Range"
                    maxValue={ranges.length - 1}
                    marks={marks}
                    getValue={(i) => `± ${formatRange(ranges[i as number])}`}
                    value={currentRange}
                    onChange={(v) => setCurrentRange(ranges.indexOf(ranges[v as number]))}
                    onChangeEnd={(v) => { action('updateRange', undefined, [ranges[v as number]]); setCurrentRange(ranges.indexOf(state?.rangeInMillivolts)) }}
                    classNames={{ filler: fillerClass, track: borderSClass, thumb: fillerClass }}
                />
                <div className="mt-4 mb-1">Coupling</div>
                <Tabs aria-label="Coupling">
                    <Tab title="AC" />
                    <Tab title="DC" />
                </Tabs>
            </PopoverContent>
        </Popover>
    </ButtonGroup>
}
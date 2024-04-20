import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { Button } from '@nextui-org/react';
import { ChannelButton } from './channelButton';
import { useControl } from '@/lib/controlHub';
import { OscilloscopeState } from '.';
import { faPlay, faStop } from '@/lib/fortawesome/pro-solid-svg-icons';

export function VerticalControlBar() {
    const { isConnected, action, state } = useControl<OscilloscopeState>('myOsci');
    const isRunning = state?.running;

    return <div className="p-1">
        <Button
            className="w-full h-12"
            startContent={<FontAwesomeIcon icon={isRunning ? faStop : faPlay} />}
            isDisabled={!isConnected}
            onClick={() => action(isRunning ? 'stop' : 'start')}
        >
            {isRunning ? 'Stop' : 'Start'}
        </Button>
        <div className="flex flex-col gap-1 items-center">
            <ChannelButton label="C1" channelIndex={1} state={state} action={action} />
            <ChannelButton label="C2" channelIndex={2} state={state} action={action} />
            <ChannelButton label="C3" channelIndex={3} state={state} action={action} />
            <ChannelButton label="C4" channelIndex={4} state={state} action={action} />
        </div>
    </div>
}
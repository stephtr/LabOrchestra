'use client';

import Oscilloscope from '@/components/oscilloscope';
import { Button, Tab, Tabs } from '@nextui-org/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faPause, faPlay } from '@/lib/fontawesome-regular';
import { useControl } from '@/lib/controlHub';
import { Pressure } from '@/components/pressure';

interface OscilloscopeState {
  running: boolean;
  mode: 'time' | 'fft';
}

export default function Home() {
  const { isConnected, action, state } = useControl<OscilloscopeState>('myOsci');
  const isRunning = state?.running;

  return (
    <div className="h-full grid grid-cols-[10rem,1fr] grid-rows-[3.5rem,1fr]">
      <div className="p-1">
        <Button
          className="w-full h-12"
          startContent={<FontAwesomeIcon icon={isRunning ? faPause : faPlay} />}
          isDisabled={!isConnected}
          onClick={() => action(isRunning ? 'stop' : 'start')}
        >
          {isRunning ? 'Stop' : 'Start'}
        </Button>
      </div>
      <div className="col-start-2 flex items-center">
        <Tabs>
          <Tab title="Time trace" />
          <Tab title="FFT" />
        </Tabs>
        <Pressure />
      </div>
      <main className="col-start-2 row-start-2">
        <Oscilloscope />
      </main>
    </div>
  );
}

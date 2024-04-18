'use client';

import { useControl } from '@/lib/controlHub';
import { Button } from '@nextui-org/react';


interface PressureState {
    pressure: number;
}

export function Pressure() {
    const { isConnected, state, action } = useControl<PressureState>('myPressure');
    if (!isConnected) return '–';
    return (
        <>
            {state?.pressure}
            <Button onClick={() => action('test')}>test</Button>
        </>
    );
}
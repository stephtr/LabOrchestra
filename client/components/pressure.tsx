'use client';

import { useControl } from '@/lib/controlHub';
import { Button } from '@nextui-org/react';

interface PressureState {
	channels: { pressure: number }[];
}

export function Pressure() {
	const { isConnected, state, action } =
		useControl<PressureState>('myPressure');
	if (!isConnected) return '–';
	return (
		<>
			<div className="pr-2">{state?.channels[0].pressure}</div>
			<Button onClick={() => action('test')} className="h-12">
				Test action
			</Button>
		</>
	);
}

import { useControl } from '@/lib/controlHub';
import { Button } from '@nextui-org/react';

export function InnolasLaser() {
	const { isConnected, state, action } = useControl<{ state: string }>(
		'innolas',
	);

	return (
		<div className="flex gap-2 items-center p-2">
			<div>Innolas: {state?.state ?? '-'}</div>
			<Button
				onClick={() => action('updateLaserState')}
				isDisabled={!isConnected || !state}
			>
				Update Laser state
			</Button>
			<Button
				onClick={() => action('startLaser')}
				isDisabled={!isConnected || !state}
			>
				Start Laser
			</Button>
			<Button
				onClick={() => action('shutdownLaser')}
				isDisabled={!isConnected || !state}
			>
				Shutdown Laser
			</Button>
		</div>
	);
}

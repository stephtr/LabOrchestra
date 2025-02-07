import { useControl } from '@/lib/controlHub';
import { Button } from '@nextui-org/react';

export function InnolasLaser() {
	const { isConnected, state, action } = useControl<{ laserState: string }>(
		'innolas',
	);

	return (
		<div className="flex gap-2 items-center p-2">
			<div>Innolas: {state?.laserState ?? '-'}</div>
			<Button
				onClick={() => action('startShooting')}
				isDisabled={!isConnected || !state}
			>
				Start Shooting
			</Button>
			<Button
				onClick={() => action('stopShooting')}
				isDisabled={!isConnected || !state}
			>
				Stop Shooting
			</Button>
			<Button
				onClick={() => action('singleShot')}
				isDisabled={!isConnected || !state}
			>
				Shoot (single)
			</Button>
		</div>
	);
}

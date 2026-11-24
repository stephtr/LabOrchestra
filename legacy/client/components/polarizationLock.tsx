import { useControl } from '@/lib/controlHub';
import { Button } from '@heroui/react';

interface PolarizationLockState {
	lockH: boolean;
	outOfLockRange: boolean;
}

export function PolarizationLock() {
	const { state, action } =
		useControl<PolarizationLockState>('polarizationLock');

	if (!state) return null;
	return (
		<div className="mr-1">
			{state.lockH ? (
				<Button
					onPress={() => action('stop_polarization_lock')}
					className={state.outOfLockRange ? 'bg-orange-800' : ''}
				>
					Disable lock
				</Button>
			) : (
				<Button
					isDisabled={state.outOfLockRange}
					onPress={() => action('start_polarization_lock')}
				>
					Lock H polarization
				</Button>
			)}
		</div>
	);
}

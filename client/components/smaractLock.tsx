import { useControl } from '@/lib/controlHub';
import { Button } from '@heroui/react';

export function SmaractLock() {
	const { state, action } = useControl('smaractLock');
	return (
		<Button
			variant="flat"
			className="w-full"
			isDisabled={!state}
			onPress={() => action(state.lockZ ? 'stop_z_lock' : 'start_z_lock')}
		>
			{state && (state.lockZ ? 'Unlock z position' : 'Lock z position')}
		</Button>
	);
}

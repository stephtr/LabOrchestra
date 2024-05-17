'use client';

import { GridStack } from '@/components/gridview/gridStack';
import { Oscilloscope } from '@/components/oscilloscope';
import { StateButton } from '@/components/stateButton';
import { StateInput } from '@/components/stateInput';
import { useControl } from '@/lib/controlHub';
// import { Pressure } from '@/components/pressure';
import { faGear, faSave } from '@/lib/fortawesome/pro-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
	Button,
	Popover,
	PopoverContent,
	PopoverTrigger,
} from '@nextui-org/react';

interface MainState {
	saveDirectory: string;
	lastFilename: string;
}

export default function Home() {
	const { isConnected, action, state } = useControl<MainState>('main');
	return (
		<GridStack className="h-full">
			<Oscilloscope
				deviceId="het"
				topContent={
					<>
						<div className="flex-1" />
						<StateInput
							className="max-w-sm"
							placeholder="Filename"
							isDisabled={!isConnected}
							state={state}
							action={action}
							actionName="setLastFilename"
							variableName="lastFilename"
						/>
						<StateButton
							className="ml-2"
							startContent={<FontAwesomeIcon icon={faSave} />}
							state={state}
							action={action}
							actionName="Save"
						>
							Save
						</StateButton>
						<div className="flex-1" />
						{/* <Pressure /> */}
						<Popover>
							<PopoverTrigger>
								<Button isIconOnly className="h-12 ml-2">
									<FontAwesomeIcon icon={faGear} />
								</Button>
							</PopoverTrigger>
							<PopoverContent
								aria-label="General settings"
								className="w-[300px] items-start gap-3 py-2 px-3"
							>
								<h2 className="text-xl">General Settings</h2>
								<StateInput
									label="Save directory"
									labelPlacement="outside"
									className="pt-2"
									placeholder=" "
									isDisabled={!isConnected}
									state={state}
									action={action}
									actionName="setSaveDirectory"
									variableName="saveDirectory"
								/>
							</PopoverContent>
						</Popover>
					</>
				}
			/>
			<Oscilloscope deviceId="split" />
		</GridStack>
	);
}

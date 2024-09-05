'use client';

import { Button, ButtonProps, Spinner } from '@nextui-org/react';
import { useState } from 'react';

type Props = {
	state: any;
	action: (name: string) => Promise<void>;
	actionName: string;
	className?: string;
} & ButtonProps;

export function StateButton({
	state,
	action,
	actionName,
	startContent,
	children,
	className,
	...props
}: Props) {
	const [isWaiting, setIsWaiting] = useState(false);
	return (
		<Button
			className={className}
			startContent={isWaiting ? <Spinner size="sm" /> : startContent}
			isDisabled={!state || isWaiting}
			// eslint-disable-next-line react/jsx-props-no-spreading
			{...props}
			onPress={async () => {
				setIsWaiting(true);
				try {
					await action(actionName);
				} catch (e) {
					// eslint-disable-next-line no-alert
					alert(e);
				}
				setIsWaiting(false);
			}}
		>
			{children}
		</Button>
	);
}

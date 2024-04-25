'use client';

import { controlHubUrl, streamHubUrl } from '@/lib/connection';
import { ControlStateProvider } from '@/lib/controlHub';
import { SignalRHubProviderWithTwoUrls } from '@/lib/signalR';
import { NextUIProvider } from '@nextui-org/react';
import { PropsWithChildren } from 'react';

export default function RootProvider({ children }: PropsWithChildren) {
	return (
		<NextUIProvider className="h-full">
			<SignalRHubProviderWithTwoUrls
				provider1={{ url: controlHubUrl }}
				provider2={{ url: streamHubUrl, useBinaryProtocol: true }}
			>
				<ControlStateProvider>{children}</ControlStateProvider>
			</SignalRHubProviderWithTwoUrls>
		</NextUIProvider>
	);
}

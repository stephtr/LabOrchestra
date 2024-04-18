'use client';

import { controlHubUrl } from '@/lib/connection';
import { ControlStateProvider } from '@/lib/controlHub';
import { SignalRHubProvider } from '@/lib/signalR';
import { NextUIProvider } from "@nextui-org/react";
import { PropsWithChildren } from 'react';

export default function RootProvider({ children }: PropsWithChildren) {
    return (
        <NextUIProvider className="h-full">
            <SignalRHubProvider url={controlHubUrl}>
                <ControlStateProvider>
                    {children}
                </ControlStateProvider>
            </SignalRHubProvider>
        </NextUIProvider >
    );
}
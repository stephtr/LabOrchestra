'use client';

import { useState, useEffect } from 'react';
import { HubConnectionBuilder } from '@microsoft/signalr';
import { MessagePackHubProtocol } from '@microsoft/signalr-protocol-msgpack';
import { Chart } from 'react-chartjs-2';
import "chart.js/auto";

const ServerUrl = 'http://localhost:5095';

const labels = new Array(5000).fill(0).map((_, i) => i);
export default function Oscilloscope() {
    const [data, setData] = useState<number[]>([]);

    useEffect(() => {
        const connection = new HubConnectionBuilder()
            .withUrl(`${ServerUrl}/hub/oscilloscope`)
            .withHubProtocol(new MessagePackHubProtocol())
            .build();
        connection.on('ReceiveData', (data: number[]) => {
            setData(data);
        });
        connection.start().catch(console.error);
        return () => {
            connection.stop();
        }
    }, []);

    return <Chart options={{
        animation: false, scales: {
            x: {
                type: 'linear',
            },
            y: {
                type: 'linear',
                min: -1,
                max: 1,
            }
        }
    }} data={{ datasets: [{ data: data, pointRadius: 0 }], labels }} type="line" />;
}

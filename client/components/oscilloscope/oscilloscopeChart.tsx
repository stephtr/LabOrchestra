'use client';

import { useCallback, useState } from 'react';
import { Chart } from 'react-chartjs-2';
import "chart.js/auto";
import { useStream } from '@/lib/controlHub';

const labels = new Array(5000).fill(0).map((_, i) => i);
export function OscilloscopeChart() {
    const [data, setData] = useState<number[]>([]);

    const { isConnected } = useStream('myOsci', useCallback((data: number[]) => setData(data), []))

    return <div className="h-full bg-white dark:bg-black dark:bg-opacity-50 rounded-lg p-2">
        <div className="relative h-full">
            <Chart
                type="line"
                options={{
                    animation: false,
                    scales: {
                        x: {
                            type: 'linear',
                            grid: { color: '#555' }
                        },
                        y: {
                            type: 'linear',
                            min: -1,
                            max: 1,
                            grid: { color: '#555' }
                        },
                    },
                    resizeDelay: 10,
                    maintainAspectRatio: false,
                    plugins: {
                        tooltip: { enabled: false },
                        legend: { display: false }
                    },
                }}
                data={{
                    datasets: [{
                        data: isConnected ? data : [],
                        pointRadius: 0,
                        borderWidth: 2
                    }],
                    labels,
                }}
            />
        </div>
    </div>;
}

'use client';

import { Oscilloscope } from '@/components/oscilloscope';
import { Pressure } from '@/components/pressure';

export default function Home() {
	return (
		<Oscilloscope
			topContent={
				<>
					<div className="flex-1" />
					<Pressure />
				</>
			}
		/>
	);
}

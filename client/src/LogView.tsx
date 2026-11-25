import { useEffect } from 'react';
import { subscribeLogs, unsubscribeLogs, useStore } from './store';

const LEVEL_STYLE: Record<string, string> = { DEBUG: 'text-faint', INFO: 'text-muted', WARNING: 'text-warn', ERROR: 'text-bad', CRITICAL: 'text-bad font-bold' };

/** The log of a source ("server", "device:<id>", "run:<id>"), live, with the latest entries first loaded. */
export function LogView({ source }: { source: string }) {
	const entries = useStore().logs[source] ?? [];
	useEffect(() => {
		void subscribeLogs(source);
		return () => unsubscribeLogs(source);
	}, [source]);
	return (
		<div data-testid={`logs-${source}`} className="mt-2 max-h-48 overflow-auto rounded-md bg-ground p-2 font-mono text-xs">
			{entries.length === 0 && <p className="text-muted">No entries yet.</p>}
			{entries.map((e) => (
				<div key={e.seq} className={LEVEL_STYLE[e.level]}>
					<span className="text-muted">{e.time.slice(11, 19)}</span> {e.level} {e.message}
					{e.traceback && (
						<details>
							<summary className="cursor-pointer text-muted">Traceback</summary>
							<pre className="overflow-x-auto">{e.traceback}</pre>
						</details>
					)}
				</div>
			))}
		</div>
	);
}

import { useEffect, useState } from 'react';
import { api, EnvironmentInfo } from './api';
import { Section, TABLE } from './Section';
import { Button } from './ui';

/** The Python environments on disk (one per set of dependencies, shared by devices that need the same) and their clean-up. */
export function EnvironmentsPanel() {
	const [environments, setEnvironments] = useState<EnvironmentInfo[] | null>(null);
	const [message, setMessage] = useState<string | null>(null);

	const refresh = () => api.listEnvironments().then(setEnvironments, (e: Error) => setMessage(e.message));
	useEffect(() => void refresh(), []);

	async function cleanUp(days: number) {
		try {
			const removed = await api.cleanupEnvironments(days);
			setMessage(removed.length === 0 ? 'Nothing to remove.' : `Removed ${removed.length} environment(s), ${removed.reduce((s, e) => s + e.size_mb, 0).toFixed(0)} MB.`);
			await refresh();
		} catch (e) {
			setMessage((e as Error).message);
		}
	}

	return (
		<Section
			testId="environments"
			title="Python environments"
			description="One per set of dependencies. Old ones stay for a while, for going back."
			actions={
				<span className="flex items-center gap-2">
					{message && <span role="status" className="text-xs text-muted">{message}</span>}
					<Button variant="ghost" data-testid="env-cleanup" onClick={() => void cleanUp(30)}>Remove unused for 30 days</Button>
					<Button variant="ghost" onClick={() => void cleanUp(0)}>Remove all unused</Button>
				</span>
			}
		>
			{(environments ?? []).length > 0 && (
				<table className={TABLE}>
					<thead>
						<tr><th>Used by</th><th>Packages</th><th>Python</th><th>Size</th><th>Last used</th><th>Key</th></tr>
					</thead>
					<tbody>
						{(environments ?? []).map((e) => (
							<tr key={e.key} data-testid={`env-${e.key}`}>
								<td>{e.used_by.join(', ') || <span className="text-faint">unused</span>}</td>
								<td className="break-all text-muted">{e.dependencies.join(', ') || 'none'}</td>
								<td className="text-muted">{e.python ?? 'any'}</td>
								<td className="whitespace-nowrap tabular-nums text-muted">{e.size_mb.toFixed(0)} MB</td>
								<td className="whitespace-nowrap text-muted">{new Date(e.last_used * 1000).toLocaleDateString()}</td>
								<td className="font-mono text-xs text-faint">{e.key}</td>
							</tr>
						))}
					</tbody>
				</table>
			)}
			{environments?.length === 0 && <p className="px-4 py-4 text-sm text-muted">No environments yet.</p>}
		</Section>
	);
}

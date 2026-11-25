import { useEffect, useState } from 'react';
import { api, EnvironmentInfo } from './api';

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
		<section className="mt-8" data-testid="environments">
			<h2 className="mb-1 text-lg font-semibold">Python environments</h2>
			<p className="mb-3 text-sm text-zinc-500">
				Every device runs in an environment with the dependencies of its file. An old one stays for a while, so that going back to an
				older file (git) works at once.
			</p>
			<div className="overflow-x-auto rounded-lg bg-white shadow dark:bg-slate-900">
				<table className="w-full text-left text-sm">
					<thead className="text-zinc-500">
						<tr><th className="p-2">Key</th><th className="p-2">Python</th><th className="p-2">Packages</th><th className="p-2">Size</th><th className="p-2">Last used</th><th className="p-2">Used by</th></tr>
					</thead>
					<tbody>
						{(environments ?? []).map((e) => (
							<tr key={e.key} data-testid={`env-${e.key}`} className="border-t border-zinc-200 dark:border-slate-800">
								<td className="p-2 font-mono text-xs">{e.key}</td>
								<td className="p-2">{e.python ?? 'any'}</td>
								<td className="p-2">{e.dependencies.join(', ') || 'none'}</td>
								<td className="p-2">{e.size_mb.toFixed(0)} MB</td>
								<td className="p-2">{new Date(e.last_used * 1000).toLocaleDateString()}</td>
								<td className="p-2">{e.used_by.join(', ') || <span className="text-zinc-400">unused</span>}</td>
							</tr>
						))}
						{environments?.length === 0 && <tr><td colSpan={6} className="p-3 text-zinc-500">No environments yet.</td></tr>}
					</tbody>
				</table>
			</div>
			<div className="mt-2 flex items-center gap-3 text-sm">
				<button data-testid="env-cleanup" className="rounded bg-zinc-200 px-3 py-1 dark:bg-slate-700" onClick={() => void cleanUp(30)}>
					Remove unused for 30 days
				</button>
				<button className="rounded bg-zinc-200 px-3 py-1 dark:bg-slate-700" onClick={() => void cleanUp(0)}>
					Remove all unused
				</button>
				{message && <span role="status" className="text-zinc-500">{message}</span>}
			</div>
		</section>
	);
}

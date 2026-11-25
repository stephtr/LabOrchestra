import { useEffect, useState } from 'react';
import { api, CreatedToken, DeviceEntry, TokenInfo } from './api';

/** Tokens for workers on other machines. A token belongs to one device and is shown once; revoking it stops the worker from connecting again. */
export function RemoteWorkersPanel({ entries }: { entries: Record<string, DeviceEntry> }) {
	const remote = Object.keys(entries).filter((id) => entries[id]!.remote).sort();
	const [tokens, setTokens] = useState<TokenInfo[]>([]);
	const [device, setDevice] = useState('');
	const [label, setLabel] = useState('');
	const [created, setCreated] = useState<CreatedToken | null>(null);
	const [error, setError] = useState<string | null>(null);

	const refresh = () => api.listTokens().then((t) => setTokens(t.filter((x) => x.kind === 'worker')), (e: Error) => setError(e.message));
	useEffect(() => void refresh(), []);
	useEffect(() => {
		if (!remote.includes(device)) setDevice(remote[0] ?? '');
	}, [remote.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

	async function create() {
		try {
			setError(null);
			setCreated(await api.createToken(device, label));
			setLabel('');
			await refresh();
		} catch (e) {
			setError((e as Error).message);
		}
	}

	const command = created
		? `python -m laborchestra.worker path/to/${created.device}.py --id ${created.device} --url ${location.origin} --token ${created.token}`
		: '';
	return (
		<section className="mt-8" data-testid="remote-workers">
			<h2 className="mb-1 text-lg font-semibold">Remote workers</h2>
			<p className="mb-3 text-sm text-zinc-500">
				A device added as “Remote worker” runs on another machine and connects with a token that only works for that device. Use TLS when the worker is not on this machine.
			</p>
			{remote.length === 0 ? (
				<p className="text-sm text-zinc-500">No remote devices yet: add one with “Add existing”, kind “Remote worker”.</p>
			) : (
				<form className="mb-3 flex flex-wrap items-center gap-2 text-sm" onSubmit={(e) => { e.preventDefault(); void create(); }}>
					<select data-testid="token-device" aria-label="Device" className="rounded border border-zinc-300 bg-transparent px-2 py-1 dark:border-slate-700" value={device} onChange={(e) => setDevice(e.target.value)}>
						{remote.map((id) => <option key={id}>{id}</option>)}
					</select>
					<input data-testid="token-label" aria-label="Label" className="rounded border border-zinc-300 bg-transparent px-2 py-1 dark:border-slate-700" placeholder="Label, e.g. lab PC 2" value={label} onChange={(e) => setLabel(e.target.value)} />
					<button data-testid="token-create" className="rounded bg-brand px-3 py-1 text-white">Create token</button>
				</form>
			)}
			{created && (
				<div data-testid="token-created" className="mb-3 rounded border border-amber-400 bg-amber-50 p-3 text-sm dark:bg-amber-950">
					<p className="mb-1 font-medium">Copy this now: the token is not shown again.</p>
					<pre className="overflow-x-auto font-mono text-xs" data-testid="token-command">{command}</pre>
					<button className="mt-2 text-xs underline" onClick={() => setCreated(null)}>Hide</button>
				</div>
			)}
			{error && <p role="alert" className="mb-2 text-sm text-red-600">{error}</p>}
			{tokens.length > 0 && (
				<table className="w-full text-left text-sm">
					<thead className="text-zinc-500"><tr><th className="p-1">Device</th><th className="p-1">Label</th><th className="p-1">Created</th><th /></tr></thead>
					<tbody>
						{tokens.map((t) => (
							<tr key={t.id} data-testid={`token-${t.id}`} className="border-t border-zinc-200 dark:border-slate-800">
								<td className="p-1 font-mono">{t.device}</td>
								<td className="p-1">{t.label}</td>
								<td className="p-1 text-zinc-500">{new Date(t.created * 1000).toLocaleString()}</td>
								<td className="p-1 text-right">
									<button className="text-red-600 hover:underline" onClick={() => { if (window.confirm(`Revoke the token "${t.label}"? The worker cannot connect again.`)) void api.revokeToken(t.id).then(refresh, (e: Error) => setError(e.message)); }}>Revoke</button>
								</td>
							</tr>
						))}
					</tbody>
				</table>
			)}
		</section>
	);
}

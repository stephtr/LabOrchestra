import { useEffect, useState } from 'react';
import { api, CreatedToken, DeviceEntry, TokenInfo } from './api';
import { Section, TABLE } from './Section';
import { useStore } from './store';
import { Button, IconButton, Input, Select } from './ui';

/** Tokens for workers on other machines. A token belongs to one device and is shown once; revoking it stops the worker from connecting again. */
export function RemoteWorkersPanel({ entries }: { entries: Record<string, DeviceEntry> }) {
	const remote = Object.keys(entries).filter((id) => entries[id]!.remote).sort();
	const [tokens, setTokens] = useState<TokenInfo[]>([]);
	const [device, setDevice] = useState('');
	const [label, setLabel] = useState('');
	const [created, setCreated] = useState<CreatedToken | null>(null);
	const [error, setError] = useState<string | null>(null);

	const { epoch } = useStore();
	const refresh = () => api.listTokens().then((t) => { setTokens(t.filter((x) => x.kind === 'worker')); setError(null); }, (e: Error) => setError(e.message));
	useEffect(() => void refresh(), [epoch]); // eslint-disable-line react-hooks/exhaustive-deps
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
		<Section testId="remote-workers" title="Remote workers" description="Devices that run on another machine connect with a token that works for that device only. Use TLS when the machine is not this one.">
			{remote.length === 0 && tokens.length === 0 && <p className="px-4 py-4 text-sm text-muted">No remote devices yet. Add one with “Add existing…”, kind “Remote”.</p>}
			{tokens.length > 0 && (
				<table className={TABLE}>
					<thead><tr><th>Device</th><th>Label</th><th>Created</th><th /></tr></thead>
					<tbody>
						{tokens.map((t) => (
							<tr key={t.id} data-testid={`token-${t.id}`}>
								<td className="font-medium">{t.device}</td>
								<td>{t.label}</td>
								<td className="text-muted">{new Date(t.created * 1000).toLocaleString()}</td>
								<td className="text-right">
									<IconButton icon="trash" variant="danger" label={`Revoke ${t.label}`} onClick={() => { if (window.confirm(`Revoke the token "${t.label}"? The worker cannot connect again.`)) void api.revokeToken(t.id).then(refresh, (e: Error) => setError(e.message)); }} />
								</td>
							</tr>
						))}
					</tbody>
				</table>
			)}
			{remote.length > 0 && (
				<form className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-3" onSubmit={(e) => { e.preventDefault(); void create(); }}>
					<Select data-testid="token-device" aria-label="Device" className="w-56" value={device} onChange={(e) => setDevice(e.target.value)}>
						{remote.map((id) => <option key={id}>{id}</option>)}
					</Select>
					<Input data-testid="token-label" aria-label="Label" placeholder="Label, e.g. lab PC 2" className="w-56" value={label} onChange={(e) => setLabel(e.target.value)} />
					<Button data-testid="token-create">Create token</Button>
				</form>
			)}
			{created && (
				<div data-testid="token-created" className="border-t border-line bg-warn/10 px-4 py-3 text-sm">
					<p className="mb-2 font-medium">Copy this now: the token is not shown again.</p>
					<pre className="overflow-x-auto rounded-md bg-ground p-2.5 font-mono text-xs" data-testid="token-command">{command}</pre>
					<Button variant="ghost" className="mt-2" onClick={() => setCreated(null)}>Hide</Button>
				</div>
			)}
			{error && <p role="alert" className="border-t border-line px-4 py-3 text-sm text-bad">{error}</p>}
		</Section>
	);
}

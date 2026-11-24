import { useEffect, useState } from 'react';
import { api } from './api';

/** Secrets (API keys, tokens) are stored by the server, outside the workspace. Their values are never shown again. */
export function SecretsPanel() {
	const [names, setNames] = useState<string[]>([]);
	const [name, setName] = useState('');
	const [value, setValue] = useState('');
	const [error, setError] = useState<string | null>(null);

	const refresh = () => api.listSecrets().then(setNames, (e: Error) => setError(e.message));
	useEffect(() => void refresh(), []);

	async function save() {
		try {
			await api.setSecret(name.trim(), value);
			setName('');
			setValue('');
			setError(null);
			await refresh();
		} catch (e) {
			setError((e as Error).message);
		}
	}

	return (
		<section className="mt-8" data-testid="secrets">
			<h2 className="mb-1 text-lg font-semibold">Secrets</h2>
			<p className="mb-3 text-sm text-zinc-500">
				A device option can use a secret instead of a value, so that keys stay out of devices.json. Devices that use a
				secret restart when it changes.
			</p>
			<ul className="mb-3 flex flex-col gap-1">
				{names.length === 0 && <li className="text-sm text-zinc-500">No secrets yet.</li>}
				{names.map((n) => (
					<li key={n} className="flex items-center gap-2 text-sm" data-testid={`secret-${n}`}>
						<span className="font-mono">{n}</span>
						<span className="text-zinc-400">••••••••</span>
						<button
							className="text-red-600 hover:underline"
							onClick={() => void api.deleteSecret(n).then(refresh, (e: Error) => setError(e.message))}
						>
							Delete
						</button>
					</li>
				))}
			</ul>
			<form
				className="flex flex-wrap items-center gap-2"
				onSubmit={(e) => {
					e.preventDefault();
					void save();
				}}
			>
				<input aria-label="Secret name" placeholder="name, e.g. openai_key" className={FIELD} value={name} onChange={(e) => setName(e.target.value)} />
				<input aria-label="Secret value" placeholder="value" type="password" className={FIELD} value={value} onChange={(e) => setValue(e.target.value)} />
				<button className="rounded bg-brand px-3 py-1 text-sm text-white disabled:opacity-50" disabled={!name.trim() || !value}>
					Save secret
				</button>
			</form>
			{error && <p role="alert" className="mt-2 text-sm text-red-600">{error}</p>}
		</section>
	);
}

const FIELD = 'rounded border border-zinc-300 bg-transparent px-2 py-1 text-sm dark:border-slate-700';

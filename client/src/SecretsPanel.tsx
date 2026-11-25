import { useEffect, useState } from 'react';
import { api } from './api';
import { Section } from './Section';
import { useStore } from './store';
import { Button, IconButton, Input } from './ui';

/** Secrets (API keys, tokens) are stored by the server, outside the workspace. Their values are never shown again. */
export function SecretsPanel() {
	const [names, setNames] = useState<string[]>([]);
	const [name, setName] = useState('');
	const [value, setValue] = useState('');
	const [error, setError] = useState<string | null>(null);

	const { epoch } = useStore();
	const refresh = () => api.listSecrets().then((n) => { setNames(n); setError(null); }, (e: Error) => setError(e.message));
	useEffect(() => void refresh(), [epoch]); // eslint-disable-line react-hooks/exhaustive-deps

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
		<Section testId="secrets" title="Secrets" description="A device option can use a secret instead of a value, so that keys stay out of devices.json. Devices that use a secret restart when it changes.">
			{names.map((n) => (
				<div key={n} className="flex items-center gap-4 border-b border-line py-1 pl-4 pr-2 text-sm" data-testid={`secret-${n}`}>
					<span className="font-mono text-xs">{n}</span>
					<span className="flex-1 text-faint">••••••••</span>
					<IconButton icon="trash" variant="danger" label={`Delete ${n}`} onClick={() => void api.deleteSecret(n).then(refresh, (e: Error) => setError(e.message))} />
				</div>
			))}
			<form
				className="flex flex-wrap items-center gap-2 px-4 py-3"
				onSubmit={(e) => {
					e.preventDefault();
					void save();
				}}
			>
				<Input aria-label="Secret name" placeholder="Name, e.g. openai_key" className="w-56" value={name} onChange={(e) => setName(e.target.value)} />
				<Input aria-label="Secret value" placeholder="Value" type="password" className="w-56" value={value} onChange={(e) => setValue(e.target.value)} />
				<Button disabled={!name.trim() || !value}>Save secret</Button>
				{error && <span role="alert" className="text-sm text-bad">{error}</span>}
			</form>
		</Section>
	);
}

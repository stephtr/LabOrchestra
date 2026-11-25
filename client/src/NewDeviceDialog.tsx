import { useEffect, useState } from 'react';
import { OpenFileButtons } from './OpenFileButtons';
import { Button, Dialog, DialogBody, DialogFooter, ErrorText, FormRow, Input, Select } from './ui';
import { api, PythonInfo, Scaffolded, TemplateInfo } from './api';

const SNAKE = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;
const CONNECTIONS = [
	['none', 'None (software only)'],
	['serial', 'Serial port'],
	['tcp', 'Network (TCP)'],
	['visa', 'VISA'],
] as const;

/** "New device": pick what kind of device, give it a name and a connection; the server writes devices/<name>.py and starts it simulated. */
export function NewDeviceDialog({ onClose }: { onClose: () => void }) {
	const [templates, setTemplates] = useState<TemplateInfo[]>([]);
	const [pythons, setPythons] = useState<PythonInfo[]>([]);
	const [template, setTemplate] = useState('blank');
	const [id, setId] = useState('');
	const [connection, setConnection] = useState<string>('serial');
	const [python, setPython] = useState('');
	const [error, setError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const [made, setMade] = useState<Scaffolded | null>(null);

	useEffect(() => {
		void api.listTemplates().then(setTemplates, (e: Error) => setError(e.message));
		void api.listPythons().then(setPythons, () => setPythons([]));
	}, []);

	async function create() {
		setError(null);
		if (!SNAKE.test(id)) return setError('The name must be snake_case: lowercase letters, digits and underscores, e.g. vacuum_pump');
		setSaving(true);
		try {
			setMade(await api.scaffoldDevice(template, id, connection, python.trim() || null));
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setSaving(false);
		}
	}

	return (
		<Dialog title={made ? `Device “${made.device}” created` : 'New device'} testId="new-device-dialog" width="max-w-lg" onClose={onClose}>
			{(close) =>
				made ? (
					<div className="flex min-h-0 flex-col" data-testid="new-device-done">
						<DialogBody>
							<p className="text-sm text-muted">
								<code className="font-mono text-ink">{made.file}</code> is in your workspace, and the device is running on <b className="text-ink">simulated values</b>. Replace the <code className="font-mono text-ink">TODO</code>s in the file with the code for your instrument. After you save it, the Devices page shows “file changed”; Restart applies it.
							</p>
							<p className="break-all rounded-md bg-ground p-2.5 font-mono text-xs" data-testid="new-device-path">{made.path}</p>
							<OpenFileButtons file={made.file} />
						</DialogBody>
						<DialogFooter>
							<Button variant="primary" onClick={close}>Done</Button>
						</DialogFooter>
					</div>
				) : (
					<form className="flex min-h-0 flex-col" onSubmit={(e) => { e.preventDefault(); void create(); }}>
						<DialogBody>
							<fieldset className="flex flex-col gap-1.5" aria-label="Kind of device">
								{templates.map((t) => (
							<label key={t.id} className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm ${template === t.id ? 'border-accent bg-accent/10' : 'border-line hover:bg-raised'}`}>
								<input type="radio" name="template" data-testid={`template-${t.id}`} className="mt-0.5" checked={template === t.id} onChange={() => setTemplate(t.id)} />
								<span>
									<span className="font-medium">{t.title}</span>
									{t.source === 'workspace' && <span className="ml-2 rounded bg-raised px-1.5 text-xs text-muted">your template</span>}
									<span className="block text-xs text-muted">{t.description}</span>
								</span>
							</label>
								))}
							</fieldset>
						<FormRow label="Name" htmlFor="new-name">
							<Input id="new-name" data-testid="new-device-name" autoFocus value={id} placeholder="e.g. vacuum_pump" onChange={(e) => setId(e.target.value)} />
						</FormRow>
						<div className="grid gap-4 sm:grid-cols-2">
							<FormRow label="Connection" htmlFor="new-connection">
								<Select id="new-connection" data-testid="new-device-connection" value={connection} onChange={(e) => setConnection(e.target.value)}>
									{CONNECTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
								</Select>
							</FormRow>
							<FormRow label="Python (optional)" htmlFor="new-python">
								<Input id="new-python" list="new-pythons" value={python} placeholder="version or path" onChange={(e) => setPython(e.target.value)} />
								<datalist id="new-pythons">
									{pythons.map((p) => <option key={p.path} value={p.path}>{`${p.implementation ?? 'Python'} ${p.version}`}</option>)}
								</datalist>
							</FormRow>
						</div>
						<p className="text-xs text-faint">The device starts on simulated values. Switch to real hardware once the code in the file works.</p>
							{error && <ErrorText testId="dialog-error">{error}</ErrorText>}
						</DialogBody>
						<DialogFooter>
							<Button type="button" variant="ghost" onClick={close}>Cancel</Button>
							<Button variant="primary" data-testid="create-device" disabled={saving || templates.length === 0}>Create</Button>
						</DialogFooter>
					</form>
				)
			}
		</Dialog>
	);
}

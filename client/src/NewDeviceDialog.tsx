import { useEffect, useRef, useState } from 'react';
import { api, PythonInfo, Scaffolded, TemplateInfo } from './api';

const FIELD = 'rounded border border-zinc-300 bg-transparent px-2 py-1 text-sm dark:border-slate-700';
const SNAKE = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;
const CONNECTIONS = [
	['none', 'None (software only)'],
	['serial', 'Serial port'],
	['tcp', 'Network (TCP)'],
	['visa', 'VISA'],
] as const;

/** "New device": pick what kind of device, give it a name and a connection; the server writes devices/<name>.py and starts it simulated. */
export function NewDeviceDialog({ onClose }: { onClose: () => void }) {
	const dialog = useRef<HTMLDialogElement>(null);
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
		dialog.current?.showModal();
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
		<dialog
			ref={dialog}
			data-testid="new-device-dialog"
			onClose={onClose}
			className="m-auto w-full max-w-xl rounded-lg bg-white p-5 text-zinc-900 shadow-xl backdrop:bg-black/40 dark:bg-slate-900 dark:text-zinc-100"
		>
			{made ? (
				<div className="flex flex-col gap-3" data-testid="new-device-done">
					<h2 className="text-lg font-semibold">Device “{made.device}” created</h2>
					<p className="text-sm">
						The file <code className="font-mono">{made.file}</code> is in your workspace and the device is running on <b>simulated values</b>. Open the file in your editor and replace the
						<code className="font-mono"> TODO</code>s with the code for your instrument; the Devices page shows “file changed” when you save, and Restart applies it.
					</p>
					<p className="break-all rounded bg-zinc-100 p-2 font-mono text-xs dark:bg-slate-800" data-testid="new-device-path">{made.path}</p>
					<div className="flex justify-end">
						<button className="rounded bg-brand px-3 py-1 text-sm text-white" onClick={() => dialog.current?.close()}>Done</button>
					</div>
				</div>
			) : (
				<form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); void create(); }}>
					<h2 className="text-lg font-semibold">New device</h2>
					<fieldset className="flex flex-col gap-1" aria-label="Kind of device">
						{templates.map((t) => (
							<label key={t.id} className={`flex cursor-pointer gap-2 rounded border p-2 text-sm ${template === t.id ? 'border-brand bg-emerald-50 dark:bg-emerald-950' : 'border-zinc-200 dark:border-slate-700'}`}>
								<input type="radio" name="template" data-testid={`template-${t.id}`} checked={template === t.id} onChange={() => setTemplate(t.id)} />
								<span>
									<span className="font-medium">{t.title}</span>
									{t.source === 'workspace' && <span className="ml-2 rounded bg-zinc-200 px-1 text-xs dark:bg-slate-700">your template</span>}
									<span className="block text-xs text-zinc-500">{t.description}</span>
								</span>
							</label>
						))}
					</fieldset>
					<div className="flex flex-wrap items-center gap-2">
						<label className="w-32 text-sm" htmlFor="new-name">Name</label>
						<input id="new-name" data-testid="new-device-name" autoFocus className={`${FIELD} w-56 font-mono`} value={id} placeholder="e.g. vacuum_pump" onChange={(e) => setId(e.target.value)} />
					</div>
					<div className="flex flex-wrap items-center gap-2">
						<label className="w-32 text-sm" htmlFor="new-connection">Connection</label>
						<select id="new-connection" data-testid="new-device-connection" className={`${FIELD} w-56`} value={connection} onChange={(e) => setConnection(e.target.value)}>
							{CONNECTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
						</select>
					</div>
					<div className="flex flex-wrap items-center gap-2">
						<label className="w-32 text-sm" htmlFor="new-python">Python (optional)</label>
						<input id="new-python" list="new-pythons" className={`${FIELD} w-56`} value={python} placeholder='a version such as "3.12", or a path' onChange={(e) => setPython(e.target.value)} />
						<datalist id="new-pythons">
							{pythons.map((p) => <option key={p.path} value={p.path}>{`${p.implementation ?? 'Python'} ${p.version}`}</option>)}
						</datalist>
					</div>
					<p className="text-xs text-zinc-500">The device starts on simulated values. Switching to real hardware is up to you, once the code in the file works.</p>
					{error && <p role="alert" data-testid="dialog-error" className="whitespace-pre-wrap text-sm text-red-600">{error}</p>}
					<div className="mt-1 flex justify-end gap-2">
						<button type="button" className="rounded px-3 py-1 text-sm hover:bg-zinc-100 dark:hover:bg-slate-800" onClick={() => dialog.current?.close()}>Cancel</button>
						<button data-testid="create-device" className="rounded bg-brand px-3 py-1 text-sm text-white disabled:opacity-50" disabled={saving || templates.length === 0}>Create</button>
					</div>
				</form>
			)}
		</dialog>
	);
}

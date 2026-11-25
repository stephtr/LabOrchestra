import { useEffect, useState } from 'react';
import { api, DeviceEntry } from './api';
import { DeviceDialog } from './DeviceDialog';
import { NewDeviceDialog } from './NewDeviceDialog';
import { EnvironmentsPanel } from './EnvironmentsPanel';
import { RemoteWorkersPanel } from './RemoteWorkersPanel';
import { SecretsPanel } from './SecretsPanel';
import { STATUS_STYLE } from './DeviceCard';
import { navigate } from './router';
import { useStore } from './store';

/** Add, change, restart and remove the devices of the workspace (devices.json), and manage secrets. */
export function DevicesPage() {
	const { devices } = useStore();
	const [entries, setEntries] = useState<Record<string, DeviceEntry>>({});
	const [dialog, setDialog] = useState<{ id: string | null } | null>(null);
	const [creating, setCreating] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const ids = Object.keys(devices).sort();

	useEffect(() => {
		void api.listDeviceEntries().then(setEntries, (e: Error) => setError(e.message));
	}, [ids.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps
	const sourceOf = (id: string) => (entries[id]?.package ? `package: ${entries[id]!.package}${entries[id]!.entry ? ` (${entries[id]!.entry})` : ''}` : entries[id]?.driver ? `driver: ${entries[id]!.driver}` : entries[id]?.remote ? 'remote worker' : (entries[id]?.file ?? ''));

	async function run(action: Promise<unknown>) {
		try {
			setError(null);
			await action;
		} catch (e) {
			setError((e as Error).message);
		}
	}

	return (
		<div>
			<div className="mb-3 flex items-center gap-3">
				<h2 className="text-lg font-semibold">Devices</h2>
				<span className="flex-1" />
				<button data-testid="new-device" className="rounded bg-brand px-3 py-1 text-sm text-white" onClick={() => setCreating(true)}>
					New device…
				</button>
				<button data-testid="add-device" className="rounded bg-zinc-200 px-3 py-1 text-sm dark:bg-slate-800" onClick={() => setDialog({ id: null })}>
					Add existing
				</button>
			</div>
			{error && <p role="alert" className="mb-2 text-sm text-red-600">{error}</p>}
			<div className="overflow-x-auto rounded-lg bg-white shadow dark:bg-slate-900">
				<table className="w-full text-left text-sm">
					<thead className="text-zinc-500">
						<tr>
							<th className="p-2">Id</th>
							<th className="p-2">Class</th>
							<th className="p-2">Status</th>
							<th className="p-2">File or driver</th>
							<th className="p-2" />
						</tr>
					</thead>
					<tbody>
						{ids.map((id) => {
							const info = devices[id]!;
							return (
								<tr key={id} data-testid={`row-${id}`} className="border-t border-zinc-200 dark:border-slate-800">
									<td className="p-2 font-mono">
										<a href="/" className="hover:underline" onClick={(e) => { e.preventDefault(); navigate('/'); }}>{id}</a>
									</td>
									<td className="p-2">{info.schema?.class ?? ''}</td>
									<td className="p-2">
										<span data-testid={`row-status-${id}`} className={`rounded-full px-2 py-0.5 text-xs ${STATUS_STYLE[info.status] ?? STATUS_STYLE.stopped}`} title={info.error ?? undefined}>
											{info.status}
										</span>
										{info.changed && <span data-testid={`row-changed-${id}`} className="ml-2 text-xs text-sky-700 dark:text-sky-300">file changed</span>}
									</td>
									<td className="p-2 font-mono text-xs text-zinc-500">{sourceOf(id)}</td>
									<td className="flex justify-end gap-3 p-2">
										<button data-testid={`restart-${id}`} className="hover:underline" onClick={() => void run(api.restartDevice(id))}>Restart</button>
										<button data-testid={`edit-${id}`} className="hover:underline" onClick={() => setDialog({ id })}>Change</button>
										<button
											data-testid={`remove-${id}`}
											className="text-red-600 hover:underline"
											onClick={() => {
												if (window.confirm(`Remove the device "${id}" from devices.json? Its saved settings stay.`)) void run(api.removeDevice(id));
											}}
										>
											Remove
										</button>
									</td>
								</tr>
							);
						})}
						{ids.length === 0 && (
							<tr>
								<td colSpan={5} className="p-3 text-zinc-500">No devices yet.</td>
							</tr>
						)}
					</tbody>
				</table>
			</div>
			<RemoteWorkersPanel entries={entries} />
			<EnvironmentsPanel />
			<SecretsPanel />
			{creating && <NewDeviceDialog onClose={() => setCreating(false)} />}
			{dialog && <DeviceDialog key={dialog.id ?? '+'} deviceId={dialog.id} onClose={() => setDialog(null)} />}
		</div>
	);
}

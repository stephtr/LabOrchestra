import { useEffect, useState } from 'react';
import { api, DeviceEntry } from './api';
import { DeviceDialog } from './DeviceDialog';
import { OpenFileButtons } from './OpenFileButtons';
import { NewDeviceDialog } from './NewDeviceDialog';
import { EnvironmentsPanel } from './EnvironmentsPanel';
import { RemoteWorkersPanel } from './RemoteWorkersPanel';
import { SecretsPanel } from './SecretsPanel';
import { Header } from './Header';
import { Section, TABLE } from './Section';
import { Button, ErrorText, IconButton, StatusBadge } from './ui';
import { useStore } from './store';

/** Add, change, restart and remove the devices of the workspace (devices.json), and manage secrets. */
export function DevicesPage() {
	const { devices, epoch } = useStore();
	const [entries, setEntries] = useState<Record<string, DeviceEntry>>({});
	const [dialog, setDialog] = useState<{ id: string | null } | null>(null);
	const [creating, setCreating] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const ids = Object.keys(devices).sort();

	useEffect(() => {
		void api.listDeviceEntries().then((loaded) => { setEntries(loaded); setError(null); }, (e: Error) => setError(e.message));
	}, [ids.join(','), epoch]); // eslint-disable-line react-hooks/exhaustive-deps
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
		<>
			<Header />
			<main className="min-h-0 flex-1 overflow-y-auto">
				<div className="mx-auto flex max-w-5xl flex-col gap-8 px-4 py-6">
					{error && <ErrorText>{error}</ErrorText>}
					<Section
						title="Devices"
						actions={
							<span className="flex gap-2">
								<Button data-testid="add-device" onClick={() => setDialog({ id: null })}>Add existing…</Button>
								<Button data-testid="new-device" variant="primary" icon="plus" onClick={() => setCreating(true)}>New device…</Button>
							</span>
						}
					>
						<table className={TABLE}>
							<thead>
								<tr><th>Device</th><th>Status</th><th>Source</th><th /></tr>
							</thead>
							<tbody>
								{ids.map((id) => {
									const info = devices[id]!;
									return (
										<tr key={id} data-testid={`row-${id}`}>
											<td>
												<div className="font-medium">{id}</div>
												<div className="text-xs text-faint">{info.schema?.class ?? ''}</div>
											</td>
											<td>
												<StatusBadge status={info.status} testId={`row-status-${id}`} title={info.error ?? undefined} />
												{info.changed && <div data-testid={`row-changed-${id}`} className="text-xs text-accent">file changed</div>}
												{info.error && <div className="max-w-64 truncate text-xs text-bad" title={info.error}>{info.error.split('\n').filter(Boolean).at(-1)}</div>}
											</td>
											<td className="break-all font-mono text-xs text-muted">{sourceOf(id)}</td>
											<td>
												<div className="flex items-center justify-end">
													{entries[id]?.file && <OpenFileButtons file={entries[id]!.file!} compact />}
													<IconButton icon="restart" label={`Restart ${id}`} data-testid={`restart-${id}`} onClick={() => void run(api.restartDevice(id))} />
													<IconButton icon="edit" label={`Change ${id}`} data-testid={`edit-${id}`} onClick={() => setDialog({ id })} />
													<IconButton
														icon="trash"
														variant="danger"
														label={`Remove ${id}`}
														data-testid={`remove-${id}`}
														onClick={() => {
															if (window.confirm(`Remove the device "${id}" from devices.json? Its saved settings stay.`)) void run(api.removeDevice(id));
														}}
													/>
												</div>
											</td>
										</tr>
									);
								})}
							</tbody>
						</table>
						{ids.length === 0 && <p className="border-t border-line px-4 py-8 text-center text-sm text-muted">No devices yet. Start with “New device…”.</p>}
					</Section>
					<RemoteWorkersPanel entries={entries} />
					<EnvironmentsPanel />
					<SecretsPanel />
				</div>
			</main>
			{creating && <NewDeviceDialog onClose={() => setCreating(false)} />}
			{dialog && <DeviceDialog key={dialog.id ?? '+'} deviceId={dialog.id} onClose={() => setDialog(null)} />}
		</>
	);
}

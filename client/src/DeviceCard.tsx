import { useState } from 'react';
import { api } from './api';
import { formatNumber, unitFor } from './format';
import { LogView } from './LogView';
import { Button, Input, StatusBadge } from './ui';
import {
	ActionSchema,
	callAction,
	DeviceInfo,
	Param,
	RemoteError,
	useStore,
} from './store';

function Value({ id, path, value, units }: { id: string; path: string; value: unknown; units?: Record<string, string> }) {
	if (value !== null && typeof value === 'object') {
		const entries = Array.isArray(value) ? value.map((v, i) => [String(i), v] as const) : Object.entries(value);
		return (
			<dl className={`grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 ${path ? 'border-l border-line pl-3' : ''}`}>
				{entries.map(([key, item]) => (
					<div key={key} className="contents">
						<dt className="text-muted">{key}</dt>
						<dd>
							<Value id={id} path={path ? `${path}.${key}` : key} value={item} units={units} />
						</dd>
					</div>
				))}
			</dl>
		);
	}
	const text = typeof value === 'number' ? formatNumber(value) : typeof value === 'string' ? value || '""' : String(value);
	const unit = typeof value === 'number' ? unitFor(units, path) : undefined;
	return (
		<>
			<span data-testid={`state-${id}-${path}`} className="tabular-nums">
				{text}
			</span>
			{unit && <span className="ml-1 text-muted" data-testid={`unit-${id}-${path}`}>{unit}</span>}
		</>
	);
}

function toArgument(param: Param, raw: string | boolean): unknown {
	if (param.type === 'bool') return Boolean(raw);
	const text = String(raw);
	if (text === '' && !param.required) return param.default;
	if (text === '') throw new Error(`"${param.name}" is required`);
	if (param.type === 'int' || param.type === 'float') {
		const number = Number(text);
		if (Number.isNaN(number)) throw new Error(`"${param.name}" must be a number`);
		return number;
	}
	if (param.type === 'json') return JSON.parse(text);
	return text;
}

function ActionRow({ device, action }: { device: string; action: ActionSchema }) {
	const [values, setValues] = useState<Record<string, string | boolean>>(() =>
		Object.fromEntries(
			action.params.map((p) => [p.name, p.type === 'bool' ? Boolean(p.default) : p.default == null ? '' : String(p.default)]),
		),
	);
	const [busy, setBusy] = useState(false);
	const [outcome, setOutcome] = useState<{ ok: boolean; text: string; details?: string } | null>(null);

	async function run() {
		setBusy(true);
		try {
			const args = action.params.map((p) => toArgument(p, values[p.name] ?? ''));
			const result = await callAction(device, action.name, args);
			setOutcome({ ok: true, text: result == null ? 'done' : JSON.stringify(result) });
		} catch (e) {
			const error = e as Error;
			setOutcome({
				ok: false,
				text: error instanceof RemoteError && error.type ? `${error.type}: ${error.message}` : error.message,
				details: error instanceof RemoteError ? error.traceback : undefined,
			});
		} finally {
			setBusy(false);
		}
	}

	return (
		<form
			className="flex flex-wrap items-center gap-2"
			data-testid={`action-${device}-${action.name}`}
			onSubmit={(e) => {
				e.preventDefault();
				void run();
			}}
		>
			<span className="min-w-36 font-mono text-xs text-muted" title={action.doc ?? undefined}>
				{action.name}
			</span>
			{action.params.map((p) =>
				p.type === 'bool' ? (
					<label key={p.name} className="flex items-center gap-1.5 text-sm">
						<input type="checkbox" className="size-4" checked={Boolean(values[p.name])} onChange={(e) => setValues({ ...values, [p.name]: e.target.checked })} />
						{p.name}
					</label>
				) : (
					<Input
						key={p.name}
						aria-label={p.name}
						placeholder={p.name}
						type={p.type === 'int' || p.type === 'float' ? 'number' : 'text'}
						step="any"
						className="w-28"
						value={String(values[p.name] ?? '')}
						onChange={(e) => setValues({ ...values, [p.name]: e.target.value })}
					/>
				),
			)}
			<Button disabled={busy}>Run</Button>
			{outcome && (
				<span
					role="status"
					data-testid={`result-${device}-${action.name}`}
					className={`text-sm ${outcome.ok ? 'text-good' : 'text-bad'}`}
				>
					{outcome.text}
				</span>
			)}
			{outcome?.details && (
				<details className="w-full text-xs text-muted">
					<summary>Traceback</summary>
					<pre className="overflow-x-auto">{outcome.details}</pre>
				</details>
			)}
		</form>
	);
}

/** The generated widget: shows any device from its schema, state and status. */
export function DeviceCard({ id, info }: { id: string; info: DeviceInfo }) {
	const ready = info.status === 'ready' || info.status === 'degraded';
	const [logsOpen, setLogsOpen] = useState(false);
	return (
		<section data-testid={`device-${id}`} className="h-full overflow-auto rounded-lg border border-line bg-panel p-4">
			<div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
				<h2 className="font-semibold">{id}</h2>
				{info.schema && <span className="text-sm text-muted">{info.schema.class}</span>}
				{info.schema?.profiles?.map((p) => (
					<span key={p.name} data-testid={`profile-${id}-${p.name}`} className="rounded bg-raised px-1.5 py-0.5 text-xs text-muted" title={`Conforms to the profile ${p.name}, version ${p.version}`}>
						{p.name}
					</span>
				))}
				<span className="flex-1" />
				{info.changed && (
					<Button data-testid={`changed-${id}`} className="!h-6 !px-2 text-xs" icon="restart" title="The device file changed after the device started. Click to restart it with the new file." onClick={() => void api.restartDevice(id)}>
						changed · restart
					</Button>
				)}
				<StatusBadge status={info.status} testId={`status-${id}`} />
			</div>
			{info.schema?.doc && <p className="mb-2 text-sm text-muted">{info.schema.doc}</p>}
			{info.error && (
				<pre data-testid={`error-${id}`} className="mb-2 overflow-x-auto rounded-md bg-bad/10 p-2 text-xs text-bad">
					{info.error}
				</pre>
			)}
			{info.state && (
				<div className={`mb-3 text-sm ${ready ? '' : 'opacity-50'}`}>
					<Value id={id} path="" value={info.state} units={info.schema?.units} />
				</div>
			)}
			<div className={`flex flex-col gap-2 ${ready ? '' : 'pointer-events-none opacity-50'}`}>
				{info.schema?.actions.map((action) => (
					<ActionRow key={action.name} device={id} action={action} />
				))}
			</div>
			<details className="mt-3 text-sm" onToggle={(e) => setLogsOpen(e.currentTarget.open)}>
				<summary className="cursor-pointer text-muted">Log</summary>
				{logsOpen && <LogView source={`device:${id}`} />}
			</details>
		</section>
	);
}

import { useEffect, useMemo, useState } from 'react';
import { api } from './api';
import { Header } from './Header';
import { LogView } from './LogView';
import { buildParams, duration, FormValues, initialValues, Procedure, ProcedureListing, ProcedureParam } from './procedureForm';
import { Section, TABLE } from './Section';
import { onProceduresChanged, RunInfo, runIsActive, useStore } from './store';
import { Button, Dialog, DialogBody, DialogFooter, ErrorText, FormRow, Icon, Input, StatusBadge } from './ui';

const isProcedure = (p: ProcedureListing): p is Procedure => p.name !== undefined;
const ACTIVE = runIsActive;

/** Seconds since the start of a run (or its length, once it is over); ticks while it goes on. */
function useElapsed(run: RunInfo): number {
	const [now, setNow] = useState(Date.now() / 1000);
	useEffect(() => {
		if (!ACTIVE(run)) return;
		const timer = setInterval(() => setNow(Date.now() / 1000), 1000);
		return () => clearInterval(timer);
	}, [run.id, run.ended]);
	return (run.ended ?? now) - run.started;
}

function ParamField({ param, value, error, onChange }: { param: ProcedureParam; value: string | boolean; error?: string; onChange: (v: string | boolean) => void }) {
	const id = `param-${param.name}`;
	if (param.type === 'bool')
		return (
			<label className="flex items-center gap-2 text-sm" data-testid={id}>
				<input type="checkbox" className="size-4" checked={value === true} onChange={(e) => onChange(e.target.checked)} />
				<span className="font-mono text-xs">{param.name}</span>
				{param.doc && <span className="text-xs text-faint">{param.doc}</span>}
			</label>
		);
	const hint = param.doc ?? (param.type === 'list' ? 'a list, separated by commas' : param.type === 'json' ? 'JSON' : undefined);
	return (
		<FormRow label={<>{param.name}{param.required && <span className="text-bad" title="required"> *</span>}</>} htmlFor={id} hint={hint} error={error && `${param.name} ${error}`} mono>
			{param.type === 'json' ? (
				<textarea id={id} data-testid={id} rows={3} className="rounded-md border border-line bg-field px-2.5 py-1.5 font-mono text-sm" value={String(value)} onChange={(e) => onChange(e.target.value)} />
			) : (
				<Input id={id} data-testid={id} className={param.type === 'str' ? '' : 'tabular-nums'} placeholder={param.required ? 'required' : ''} value={String(value)} onChange={(e) => onChange(e.target.value)} />
			)}
		</FormRow>
	);
}

/** The form that the procedure's signature makes, and the start of a run. */
function RunDialog({ procedure, busy, onStarted, onClose }: { procedure: Procedure; busy: string | null; onStarted: (run: RunInfo) => void; onClose: () => void }) {
	const [values, setValues] = useState<FormValues>(() => initialValues(procedure.params));
	const [errors, setErrors] = useState<Record<string, string>>({});
	const [failure, setFailure] = useState<string | null>(null);
	const [starting, setStarting] = useState(false);

	async function start(close: () => void) {
		const built = buildParams(procedure.params, values);
		setErrors(built.errors);
		if (Object.keys(built.errors).length > 0) return;
		setStarting(true);
		setFailure(null);
		try {
			onStarted(await api.startProcedure(procedure.name, built.params));
			close();
		} catch (e) {
			setFailure((e as Error).message);
		} finally {
			setStarting(false);
		}
	}

	return (
		<Dialog title={procedure.title} testId="run-dialog" onClose={onClose}>
			{(close) => (
				<form className="flex min-h-0 flex-col" onSubmit={(e) => { e.preventDefault(); void start(close); }}>
					<DialogBody>
						{procedure.doc && <p className="whitespace-pre-wrap text-sm text-muted">{procedure.doc}</p>}
						{procedure.devices.length > 0 && (
							<p className="text-xs text-faint">
								Uses <span className="font-mono">{procedure.devices.join(', ')}</span>; no other procedure can use {procedure.devices.length > 1 ? 'them' : 'it'} while this one runs.
							</p>
						)}
						{busy && <ErrorText testId="busy">{busy}</ErrorText>}
						{procedure.params.length === 0 && <p className="text-sm text-faint">This procedure has no parameters.</p>}
						<div className="flex flex-col gap-3">
							{procedure.params.map((p) => (
								<ParamField key={p.name} param={p} value={values[p.name] ?? ''} error={errors[p.name]} onChange={(v) => setValues({ ...values, [p.name]: v })} />
							))}
						</div>
						{failure && <ErrorText testId="dialog-error">{failure}</ErrorText>}
					</DialogBody>
					<DialogFooter>
						<Button type="button" variant="ghost" onClick={close}>Cancel</Button>
						<Button variant="primary" icon="play" data-testid="start-run" disabled={starting}>Start</Button>
					</DialogFooter>
				</form>
			)}
		</Dialog>
	);
}

function Progress({ run }: { run: RunInfo }) {
	const p = run.progress;
	const fraction = p && p.total ? Math.min(1, p.done / p.total) : null;
	const active = ACTIVE(run);
	return (
		<div className="flex flex-col gap-1" data-testid="run-progress">
			<div className="h-2 overflow-hidden rounded-full bg-raised">
				<div
					className={`h-full rounded-full ${run.status === 'failed' || run.status === 'crashed' ? 'bg-bad' : run.status === 'finished' ? 'bg-good' : 'bg-accent'} ${active && fraction === null ? 'w-1/3 animate-pulse' : ''}`}
					style={fraction !== null ? { width: `${fraction * 100}%` } : run.status === 'finished' ? { width: '100%' } : undefined}
				/>
			</div>
			<div className="flex gap-2 text-xs tabular-nums text-muted">
				<span data-testid="run-progress-text">{p ? (p.total ? `${p.done} of ${p.total}` : `${p.done} done`) : active ? 'Starting…' : ''}{p?.label ? ` ${p.label}` : ''}</span>
				<span className="flex-1" />
				{run.message && <span data-testid="run-message" className="text-ink">{run.message}</span>}
			</div>
		</div>
	);
}

function RunPanel({ run, title }: { run: RunInfo; title: string }) {
	const elapsed = useElapsed(run);
	const [problem, setProblem] = useState<string | null>(null);
	const act = (action: Promise<unknown>) => action.then(() => setProblem(null), (e: Error) => setProblem(e.message));
	const active = ACTIVE(run);
	const paused = run.status === 'paused';
	return (
		<section data-testid={`run-${run.id}`} className="flex flex-col gap-3 rounded-lg border border-line bg-panel p-4">
			<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
				<h3 className="font-semibold">{title}</h3>
				<StatusBadge status={run.status} testId="run-status" />
				<span className="text-xs tabular-nums text-muted">{duration(elapsed)}</span>
				<span className="font-mono text-xs text-faint" title="Run id">{run.id}</span>
				<span className="flex-1" />
				{active && run.status !== 'aborting' && (
					<>
						<Button data-testid="pause-run" icon={paused ? 'play' : undefined} onClick={() => void act(api.pauseRun(run.id, !paused))}>{paused ? 'Resume' : 'Pause'}</Button>
						<Button data-testid="abort-run" variant="default" className="!bg-bad/15 !text-bad hover:!bg-bad/25" icon="stop" onClick={() => window.confirm('Abort the procedure? It stops where it is and cleans up (its finally blocks run).') && void act(api.abortRun(run.id))}>Abort</Button>
					</>
				)}
				{run.status === 'aborting' && (
					<Button data-testid="kill-run" className="!bg-bad/15 !text-bad hover:!bg-bad/25" icon="warning" title="Kill the process at once, without cleanup" onClick={() => window.confirm('Kill the process now? Its cleanup does not run. A recording it has open is stopped by the server.') && void act(api.abortRun(run.id, true))}>Kill now</Button>
				)}
			</div>
			{problem && <ErrorText>{problem}</ErrorText>}
			<Progress run={run} />
			{Object.keys(run.params).length > 0 && (
				<dl className="flex flex-wrap gap-x-5 gap-y-0.5 text-xs">
					{Object.entries(run.params).map(([k, v]) => (
						<div key={k} className="flex gap-1.5"><dt className="font-mono text-faint">{k}</dt><dd className="tabular-nums" title={JSON.stringify(v)}>{Array.isArray(v) && v.length > 6 ? `${v.slice(0, 6).join(', ')}, … (${v.length})` : Array.isArray(v) ? v.join(', ') : String(v)}</dd></div>
					))}
				</dl>
			)}
			{run.reason && <p className="text-sm text-warn" data-testid="run-reason">{run.reason}</p>}
			{run.error && (
				<div data-testid="run-error" className="rounded-md bg-bad/10 p-3 text-sm text-bad">
					<p className="whitespace-pre-wrap font-medium">{run.error.type}: {run.error.message}</p>
					{run.error.traceback && <details className="mt-1 text-xs"><summary className="cursor-pointer">Traceback</summary><pre className="mt-1 overflow-x-auto">{run.error.traceback}</pre></details>}
				</div>
			)}
			{run.result != null && <pre data-testid="run-result" className="overflow-x-auto rounded-md bg-ground p-2.5 font-mono text-xs"><span className="text-faint">result </span>{JSON.stringify(run.result, null, 1)}</pre>}
			<details open={active} className="text-sm">
				<summary className="cursor-pointer text-muted">Log</summary>
				<LogView source={`run:${run.id}`} />
			</details>
		</section>
	);
}

export function ProceduresPage() {
	const { runs, epoch } = useStore();
	const [listing, setListing] = useState<ProcedureListing[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [running, setRunning] = useState<Procedure | null>(null);
	const [selected, setSelected] = useState<string | null>(null);

	const load = () => api.listProcedures().then((l) => { setListing(l); setError(null); }, (e: Error) => setError(e.message));
	useEffect(() => { void load(); return onProceduresChanged(() => void load()); }, [epoch]); // eslint-disable-line react-hooks/exhaustive-deps

	const all = useMemo(() => Object.values(runs).sort((a, b) => b.started - a.started), [runs]);
	const active = all.filter(ACTIVE);
	const current = (selected ? runs[selected] : undefined) ?? active[0] ?? all[0];
	const reserved = useMemo(() => {
		const map = new Map<string, RunInfo>();
		for (const r of active) for (const d of r.devices) map.set(d, r);
		return map;
	}, [active.map((r) => r.id).join()]); // eslint-disable-line react-hooks/exhaustive-deps
	const busyFor = (p: Procedure) => {
		const clash = p.devices.map((d) => reserved.get(d)).find(Boolean);
		return clash ? `The device is reserved by the run ${clash.id} of “${clash.procedure}”, which is still going.` : null;
	};
	const titleOf = (run: RunInfo) => (listing?.find((p): p is Procedure => isProcedure(p) && p.name === run.procedure)?.title ?? run.procedure.replaceAll('_', ' '));
	const procedures = (listing ?? []).filter(isProcedure);
	const broken = (listing ?? []).filter((p): p is { file: string; error: string } => !isProcedure(p));

	return (
		<>
			<Header />
			<main className="min-h-0 flex-1 overflow-y-auto">
				<div className="mx-auto flex max-w-5xl flex-col gap-8 px-4 py-6">
					{error && <ErrorText>{error}</ErrorText>}
					<Section title="Procedures" description={<>Python functions in <code className="font-mono">procedures/</code> of the workspace (marked with <code className="font-mono">@procedure</code>). Their parameters make the form.</>}>
						{listing === null && !error && <p className="px-4 py-4 text-sm text-muted">Looking at the files…</p>}
						{listing !== null && procedures.length === 0 && broken.length === 0 && <p className="px-4 py-6 text-center text-sm text-muted">No procedures yet. Put a file with an <code className="font-mono">@procedure</code> async function into <code className="font-mono">procedures/</code>.</p>}
						<ul className="divide-y divide-line">
							{procedures.map((p) => {
								const busy = busyFor(p);
								return (
									<li key={p.name} data-testid={`procedure-${p.name}`} className="flex items-center gap-4 px-4 py-3">
										<div className="min-w-0 flex-1">
											<div className="flex items-baseline gap-2"><span className="font-medium">{p.title}</span><span className="font-mono text-xs text-faint">{p.name}</span></div>
											{p.doc && <p className="truncate text-sm text-muted">{p.doc.split('\n')[0]}</p>}
											<div className="mt-1 flex flex-wrap gap-1.5 text-xs text-faint">
												{p.devices.map((d) => <span key={d} className={`rounded bg-raised px-1.5 py-0.5 font-mono ${reserved.has(d) ? 'text-warn' : ''}`} title={reserved.has(d) ? 'Reserved by a run that is still going' : 'Used by this procedure'}>{d}</span>)}
												{p.params.length > 0 && <span>{p.params.length} parameter{p.params.length > 1 ? 's' : ''}</span>}
											</div>
										</div>
										<Button data-testid={`run-${p.name}`} variant="primary" icon="play" title={busy ?? undefined} onClick={() => setRunning(p)}>Run…</Button>
									</li>
								);
							})}
							{broken.map((b) => (
								<li key={b.file} data-testid={`broken-${b.file}`} className="px-4 py-3">
									<div className="flex items-center gap-2 text-sm text-bad"><Icon name="warning" size={14} /><span className="font-mono">{b.file}</span> could not be loaded</div>
									<pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap text-xs text-muted">{b.error}</pre>
								</li>
							))}
						</ul>
					</Section>
					{current && <RunPanel key={current.id} run={current} title={titleOf(current)} />}
					<Section title="Runs" description="The latest runs, with their parameters, source and outcome.">
						{all.length === 0 && <p className="px-4 py-4 text-sm text-muted">Nothing has run yet.</p>}
						{all.length > 0 && (
							<table className={TABLE}>
								<thead><tr><th>Procedure</th><th>Started</th><th>Duration</th><th>Status</th><th>By</th></tr></thead>
								<tbody>
									{all.slice(0, 30).map((r) => (
										<tr key={r.id} data-testid={`history-${r.id}`} onClick={() => setSelected(r.id)} className={`cursor-pointer hover:bg-raised ${current?.id === r.id ? 'bg-raised' : ''}`}>
											<td>{titleOf(r)}</td>
											<td className="whitespace-nowrap text-muted">{new Date(r.started * 1000).toLocaleString()}</td>
											<td className="whitespace-nowrap tabular-nums text-muted">{duration((r.ended ?? Date.now() / 1000) - r.started)}</td>
											<td><StatusBadge status={r.status} /></td>
											<td className="text-xs text-faint">{r.caller}</td>
										</tr>
									))}
								</tbody>
							</table>
						)}
					</Section>
				</div>
			</main>
			{running && (
				<RunDialog
					procedure={running}
					busy={busyFor(running)}
					onStarted={(run) => setSelected(run.id)}
					onClose={() => setRunning(null)}
				/>
			)}
		</>
	);
}


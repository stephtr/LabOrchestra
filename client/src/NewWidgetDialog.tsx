import { useEffect, useRef, useState } from 'react';
import { api, ScaffoldedWidget, TemplateInfo } from './api';

const FIELD = 'rounded border border-zinc-300 bg-transparent px-2 py-1 text-sm dark:border-slate-700';
const SNAKE = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;

/** "New widget": the server writes widgets/<name>.tsx from a template and builds it; it then shows up in the picker by itself. */
export function NewWidgetDialog({ onClose }: { onClose: () => void }) {
	const dialog = useRef<HTMLDialogElement>(null);
	const [templates, setTemplates] = useState<TemplateInfo[]>([]);
	const [template, setTemplate] = useState('blank');
	const [name, setName] = useState('');
	const [error, setError] = useState<string | null>(null);
	const [made, setMade] = useState<ScaffoldedWidget | null>(null);

	useEffect(() => {
		dialog.current?.showModal();
		void api.listWidgetTemplates().then(setTemplates, (e: Error) => setError(e.message));
	}, []);

	async function create() {
		setError(null);
		if (!SNAKE.test(name)) return setError('The name must be snake_case: lowercase letters, digits and underscores, e.g. big_pressure');
		try {
			setMade(await api.scaffoldWidget(template, name));
		} catch (e) {
			setError((e as Error).message);
		}
	}

	return (
		<dialog ref={dialog} data-testid="new-widget-dialog" onClose={onClose} className="m-auto w-full max-w-lg rounded-lg bg-white p-5 text-zinc-900 shadow-xl backdrop:bg-black/40 dark:bg-slate-900 dark:text-zinc-100">
			{made ? (
				<div className="flex flex-col gap-3" data-testid="new-widget-done">
					<h2 className="text-lg font-semibold">Widget “{made.name}” created</h2>
					<p className="text-sm">
						Open the file in your editor. Every time you save it the page updates by itself, and a mistake is shown in the widget. It is in the picker under “Add widget”, next to the device it should show.
					</p>
					<p className="break-all rounded bg-zinc-100 p-2 font-mono text-xs dark:bg-slate-800" data-testid="new-widget-path">{made.path}</p>
					<div className="flex justify-end">
						<button className="rounded bg-brand px-3 py-1 text-sm text-white" onClick={() => dialog.current?.close()}>Done</button>
					</div>
				</div>
			) : (
				<form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); void create(); }}>
					<h2 className="text-lg font-semibold">New widget</h2>
					<fieldset className="flex flex-col gap-1" aria-label="Kind of widget">
						{templates.map((t) => (
							<label key={t.id} className={`flex cursor-pointer gap-2 rounded border p-2 text-sm ${template === t.id ? 'border-brand bg-emerald-50 dark:bg-emerald-950' : 'border-zinc-200 dark:border-slate-700'}`}>
								<input type="radio" name="widget-template" data-testid={`widget-template-${t.id}`} checked={template === t.id} onChange={() => setTemplate(t.id)} />
								<span>
									<span className="font-medium">{t.title}</span>
									<span className="block text-xs text-zinc-500">{t.description}</span>
								</span>
							</label>
						))}
					</fieldset>
					<div className="flex flex-wrap items-center gap-2">
						<label className="w-24 text-sm" htmlFor="new-widget-name">Name</label>
						<input id="new-widget-name" data-testid="new-widget-name" autoFocus className={`${FIELD} w-56 font-mono`} value={name} placeholder="e.g. big_pressure" onChange={(e) => setName(e.target.value)} />
					</div>
					{error && <p role="alert" data-testid="dialog-error" className="whitespace-pre-wrap text-sm text-red-600">{error}</p>}
					<div className="flex justify-end gap-2">
						<button type="button" className="rounded px-3 py-1 text-sm hover:bg-zinc-100 dark:hover:bg-slate-800" onClick={() => dialog.current?.close()}>Cancel</button>
						<button data-testid="create-widget" className="rounded bg-brand px-3 py-1 text-sm text-white disabled:opacity-50" disabled={templates.length === 0}>Create</button>
					</div>
				</form>
			)}
		</dialog>
	);
}

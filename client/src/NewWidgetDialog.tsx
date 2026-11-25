import { useEffect, useState } from 'react';
import { OpenFileButtons } from './OpenFileButtons';
import { Button, Dialog, DialogBody, DialogFooter, ErrorText, FormRow, Input } from './ui';
import { api, ScaffoldedWidget, TemplateInfo } from './api';

const SNAKE = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;

/** "New widget": the server writes widgets/<name>.tsx from a template and builds it; it then shows up in the picker by itself. */
export function NewWidgetDialog({ onClose }: { onClose: () => void }) {
	const [templates, setTemplates] = useState<TemplateInfo[]>([]);
	const [template, setTemplate] = useState('blank');
	const [name, setName] = useState('');
	const [error, setError] = useState<string | null>(null);
	const [made, setMade] = useState<ScaffoldedWidget | null>(null);

	useEffect(() => {
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
		<Dialog title={made ? `Widget “${made.name}” created` : 'New widget'} testId="new-widget-dialog" width="max-w-lg" onClose={onClose}>
			{(close) =>
				made ? (
					<div className="flex min-h-0 flex-col" data-testid="new-widget-done">
						<DialogBody>
							<p className="text-sm text-muted">
								Every time you save the file the page updates by itself, and a mistake is shown in the widget. You find it under “Add widget”, next to the device it should show.
							</p>
							<p className="break-all rounded-md bg-ground p-2.5 font-mono text-xs" data-testid="new-widget-path">{made.path}</p>
							<OpenFileButtons file={made.file} />
						</DialogBody>
						<DialogFooter>
							<Button variant="primary" onClick={close}>Done</Button>
						</DialogFooter>
					</div>
				) : (
					<form className="flex min-h-0 flex-col" onSubmit={(e) => { e.preventDefault(); void create(); }}>
						<DialogBody>
							<fieldset className="flex flex-col gap-1.5" aria-label="Kind of widget">
								{templates.map((t) => (
							<label key={t.id} className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm ${template === t.id ? 'border-accent bg-accent/10' : 'border-line hover:bg-raised'}`}>
								<input type="radio" name="widget-template" data-testid={`widget-template-${t.id}`} className="mt-0.5" checked={template === t.id} onChange={() => setTemplate(t.id)} />
								<span>
									<span className="font-medium">{t.title}</span>
									{t.source === 'workspace' && <span className="ml-2 rounded bg-raised px-1.5 text-xs text-muted">your template</span>}
									<span className="block text-xs text-muted">{t.description}</span>
								</span>
							</label>
								))}
							</fieldset>
						<FormRow label="Name" htmlFor="new-widget-name">
							<Input id="new-widget-name" data-testid="new-widget-name" autoFocus value={name} placeholder="e.g. big_pressure" onChange={(e) => setName(e.target.value)} />
						</FormRow>
							{error && <ErrorText testId="dialog-error">{error}</ErrorText>}
						</DialogBody>
						<DialogFooter>
							<Button type="button" variant="ghost" onClick={close}>Cancel</Button>
							<Button variant="primary" data-testid="create-widget" disabled={templates.length === 0}>Create</Button>
						</DialogFooter>
					</form>
				)
			}
		</Dialog>
	);
}

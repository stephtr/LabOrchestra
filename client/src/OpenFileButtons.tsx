import { useState } from 'react';
import { api } from './api';

/** "Open in editor" and "Show in folder" for a file of the workspace. They start programs on the server's computer: elsewhere the server says so
 *  and names the path, which is shown here. */
export function OpenFileButtons({ file, compact = false }: { file: string; compact?: boolean }) {
	const [message, setMessage] = useState<string | null>(null);
	async function open(how: 'editor' | 'folder') {
		try {
			await api.openFile(file, how);
			setMessage(null);
		} catch (e) {
			setMessage((e as Error).message);
		}
	}
	const button = compact ? 'hover:underline' : 'rounded bg-zinc-200 px-2 py-1 text-sm hover:bg-brand hover:text-white dark:bg-slate-800';
	return (
		<span className={compact ? 'inline-flex gap-2' : 'flex flex-wrap items-center gap-2'}>
			<button type="button" data-testid={`open-editor-${file}`} className={button} onClick={() => void open('editor')}>Open in editor</button>
			<button type="button" data-testid={`open-folder-${file}`} className={button} onClick={() => void open('folder')}>Show in folder</button>
			{message && <span role="alert" className="break-all text-xs text-amber-700 dark:text-amber-400" data-testid="open-file-message">{message}</span>}
		</span>
	);
}

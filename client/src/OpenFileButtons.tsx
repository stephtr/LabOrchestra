import { useState } from 'react';
import { api } from './api';
import { Button, IconButton } from './ui';

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
	return (
		<span className={compact ? 'inline-flex items-center' : 'flex flex-wrap items-center gap-2'}>
			{compact ? (
				<>
					<IconButton type="button" icon="code" label="Open in editor" data-testid={`open-editor-${file}`} onClick={() => void open('editor')} />
					<IconButton type="button" icon="folder" label="Show in folder" data-testid={`open-folder-${file}`} onClick={() => void open('folder')} />
				</>
			) : (
				<>
					<Button type="button" icon="code" data-testid={`open-editor-${file}`} onClick={() => void open('editor')}>Open in editor</Button>
					<Button type="button" icon="folder" data-testid={`open-folder-${file}`} onClick={() => void open('folder')}>Show in folder</Button>
				</>
			)}
			{message && <span role="alert" className="break-all text-xs text-warn" data-testid="open-file-message">{message}</span>}
		</span>
	);
}

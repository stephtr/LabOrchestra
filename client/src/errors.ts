import { invokeHub } from './store';

/** Errors of the page go to the server's log (source "client"), where AI and people look for them. */
const seen = new Set<string>();

export function reportError(message: string, stack?: string, where = 'window'): void {
	const key = `${where}:${message}`;
	if (seen.has(key) || seen.size >= 30) return; // the same error again and again says nothing new
	seen.add(key);
	void invokeHub('report_client_error', message, stack ?? null, where).catch(() => {
		seen.delete(key); // not connected (yet): the next occurrence tries again
	});
}

export function describe(error: unknown): { message: string; stack?: string } {
	if (error instanceof Error) return { message: `${error.name}: ${error.message}`, stack: error.stack };
	return { message: String(error) };
}

export function installErrorReporting(): void {
	window.addEventListener('error', (e) => {
		const { message, stack } = e.error ? describe(e.error) : { message: e.message, stack: `${e.filename}:${e.lineno}:${e.colno}` };
		reportError(message, stack, 'window.onerror');
	});
	window.addEventListener('unhandledrejection', (e) => {
		const { message, stack } = describe(e.reason);
		reportError(message, stack, 'unhandledrejection');
	});
}

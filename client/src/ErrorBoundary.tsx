import { Component, ErrorInfo, ReactNode } from 'react';
import { describe, reportError } from './errors';

/** Catches errors while rendering: reports them to the server and shows what happened instead of a blank page. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
	state = { error: null as Error | null };

	static getDerivedStateFromError(error: Error) {
		return { error };
	}

	componentDidCatch(error: Error, info: ErrorInfo) {
		const { message, stack } = describe(error);
		reportError(message, `${stack ?? ''}\n${info.componentStack ?? ''}`, 'react');
	}

	render() {
		if (!this.state.error) return this.props.children;
		return (
			<div role="alert" data-testid="error-boundary" className="mx-auto mt-24 max-w-lg rounded-lg bg-white p-6 shadow dark:bg-slate-900">
				<h1 className="mb-2 text-xl font-semibold">Something went wrong</h1>
				<p className="mb-3 text-sm text-zinc-500">The error was sent to the server's log (source "client").</p>
				<pre className="mb-3 overflow-x-auto rounded bg-red-50 p-2 text-xs text-red-800 dark:bg-red-950 dark:text-red-300">{String(this.state.error)}</pre>
				<button className="rounded bg-zinc-200 px-3 py-1 dark:bg-slate-700" onClick={() => location.reload()}>
					Reload
				</button>
			</div>
		);
	}
}

import { useSyncExternalStore } from 'react';
import { flushSync } from 'react-dom';

const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());
window.addEventListener('popstate', notify);

/** Goes to another page of the app without reloading. */
export function navigate(path: string) {
	if (path === location.pathname) return;
	history.pushState(null, '', path);
	notify();
}

export function usePath(): string {
	return useSyncExternalStore(
		(listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		() => location.pathname,
	);
}

/** Goes to another page and slides the content region (`view-transition-name: dashboard-content`) in from the side the target lies on.
 * Uses the browser's View Transitions: the old content is a picture, so nothing is rendered twice (streams run once). Without that API, or
 * with reduced motion, it just navigates. */
export function navigateSliding(path: string, direction: 'forward' | 'back') {
	const doc = document as Document & { startViewTransition?: (update: () => void) => { finished: Promise<void> } };
	if (path === location.pathname) return;
	if (!doc.startViewTransition || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return navigate(path);
	const root = document.documentElement;
	root.dataset.slide = direction;
	const clear = () => delete root.dataset.slide;
	try {
		doc.startViewTransition(() => flushSync(() => navigate(path))).finished.then(clear, clear);
	} catch {
		clear();
		navigate(path);
	}
}

import { useSyncExternalStore } from 'react';

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

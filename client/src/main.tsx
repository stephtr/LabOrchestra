import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { ErrorBoundary } from './ErrorBoundary';
import { installErrorReporting } from './errors';
import { start } from './store';
import './styles.css';

installErrorReporting();
void start();
// a login link pasted into an open tab only changes the hash
window.addEventListener('hashchange', () => void start());
createRoot(document.getElementById('root')!).render(
	<StrictMode>
		<ErrorBoundary>
			<App />
		</ErrorBoundary>
	</StrictMode>,
);

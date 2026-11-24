import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { start } from './store';
import './styles.css';

void start();
// a login link pasted into an open tab only changes the hash
window.addEventListener('hashchange', () => void start());
createRoot(document.getElementById('root')!).render(
	<StrictMode>
		<App />
	</StrictMode>,
);

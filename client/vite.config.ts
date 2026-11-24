import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const server = process.env.LABORCHESTRA_SERVER ?? 'http://127.0.0.1:5095';

export default defineConfig({
	plugins: [react(), tailwindcss()],
	server: {
		proxy: {
			'/hub': {
				target: server,
				ws: true,
				// development only: the server accepts browsers only from its own origin
				configure: (proxy) => {
					proxy.on('proxyReqWs', (request) => request.setHeader('origin', server));
					proxy.on('proxyReq', (request) => request.setHeader('origin', server));
				},
			},
		},
	},
});

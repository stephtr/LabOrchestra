// Screenshots of the real app for the website: node e2e/screenshots.mjs [outdir]
// Needs the same as the e2e (pnpm build, dotnet build -c Release, the python package). Starts a server on a copy of workspace/ with a few
// extra services, takes the pictures in light and dark, and stops the server again.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const out = path.resolve(process.argv[2] ?? path.join(root, 'docs/screenshots'));
const win = process.platform === 'win32';
const python = process.env.LABORCHESTRA_PYTHON ?? path.join(root, 'python/.venv', win ? 'Scripts/python.exe' : 'bin/python');
const dll = path.join(root, 'server/LabOrchestra.Server/bin/Release/net11.0/LabOrchestra.Server.dll');
const PASSPHRASE = 'shots';
fs.mkdirSync(out, { recursive: true });

// --- a workspace like the lab's, with some services ---
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lo-shots-'));
const ws = path.join(dir, 'workspace');
fs.cpSync(path.join(root, 'workspace'), ws, { recursive: true, filter: (s) => !s.includes('__pycache__') });
const devices = JSON.parse(fs.readFileSync(path.join(ws, 'devices.json'), 'utf8'));
delete devices.devices.test_device;
devices.devices.particle_name = { file: 'services/particle_name.py', description: 'Names the trapped particle when the pressure drops' };
devices.devices.pressure_upload = { file: 'services/pressure_upload.py', config: { device: 'pressure', path: 'channels.1.pressure', url: 'https://sensors.example.org/upload', interval_s: 60 } };
fs.writeFileSync(path.join(ws, 'devices.json'), JSON.stringify(devices, null, '\t'));
fs.rmSync(path.join(ws, 'views/test.json'), { force: true });
fs.mkdirSync(path.join(ws, 'services'));
fs.writeFileSync(path.join(ws, 'services/particle_name.py'), `from laborchestra import Service


class ParticleName(Service):
    """Names the trapped particle when the pressure drops below the threshold."""

    threshold = 1e-2  # mbar
    state = {"name": "Petra Groundwell", "status": "ok"}
    persist = ["name"]

    def run(self):
        while self.running:
            self.sleep(1)
`);
fs.writeFileSync(path.join(ws, 'services/pressure_upload.py'), `from laborchestra import Service


class PressureUpload(Service):
    """Sends the average chamber pressure to the sensor website once a minute."""

    device: str = ""
    path: str = ""
    url: str = ""
    interval_s: float = 60.0
    state = {"status": "ok", "uploads": 42}

    def run(self):
        while self.running:
            self.sleep(1)
`);
// the example view as committed (a live workspace may have been edited); version 1 has a strip, which becomes an area along the bottom
const view = JSON.parse(execFileSync('git', ['show', 'HEAD:workspace/views/dashboard.json'], { cwd: root, encoding: 'utf8' }));
if (view.strip) {
	view.root = { id: 'n_root', kind: 'split', dir: 'column', children: [view.root, { id: 'a_strip', kind: 'area', widgets: view.strip }], sizes: [80, 20] };
	delete view.strip;
	view.version = 2;
}
// the layout has areas of compact widgets (version 2): drop the duplicate pump tile, add two traces
const area = (n) => (n.kind === 'area' ? n : n.kind === 'split' ? n.children.map(area).find(Boolean) : null);
const compact = area(view.root);
compact.widgets = compact.widgets.filter((w) => !(w.type === 'turbo_pump' && !w.props?.label));
compact.widgets.push({ id: 'w_trace1', type: 'trace', device: 'pressure', props: { path: 'channels.1.pressure', scale: 'log', label: 'Chamber pressure' } }, { id: 'w_trace2', type: 'trace', device: 'pressure', props: { path: 'channels.0.pressure', label: 'Fore vacuum' } });
for (const w of area(view.root).widgets) if (w.props?.label === 'Vorvakuum') w.props.label = 'Fore vacuum'; else if (w.props?.label === 'Kammer') w.props.label = 'Chamber';
fs.writeFileSync(path.join(ws, 'views/dashboard.json'), JSON.stringify(view, null, '\t'));

const port = await new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const url = `http://127.0.0.1:${port}`;
const server = spawn('dotnet', [dll, '--urls', url], {
	env: { ...process.env, LABORCHESTRA_WORKSPACE: ws, LABORCHESTRA_PYTHON: python, LABORCHESTRA_PASSPHRASE: PASSPHRASE, LABORCHESTRA_DATA_DIR: path.join(dir, 'data') },
	stdio: 'ignore',
});
const script = (code) => execFileSync(python, ['-c', `import laborchestra, time\nlab = laborchestra.connect()\n${code}`], { env: { ...process.env, LABORCHESTRA_URL: url, LABORCHESTRA_TOKEN: PASSPHRASE }, encoding: 'utf8' }).trim();

let browser;
try {
	for (let i = 0; ; i++) {
		try { await fetch(url); break; } catch { if (i > 150) throw new Error('server did not start'); await new Promise((r) => setTimeout(r, 200)); }
	}
	script("for d in ('acq', 'acq2', 'waveplates', 'rf', 'pressure', 'turbo', 'particle_name'): getattr(lab, d).wait_ready(90)");
	script("lab.acq.start(); lab.acq2.start(); lab.turbo.start(0); lab.turbo.start(1); time.sleep(12)");
	browser = await chromium.launch();
	for (const scheme of ['light', 'dark']) {
		const context = await browser.newContext({ viewport: { width: 1440, height: 860 }, deviceScaleFactor: 2, colorScheme: scheme });
		const page = await context.newPage();
		page.setDefaultTimeout(30000);
		const shot = async (name, opts = {}) => { await page.waitForTimeout(opts.wait ?? 1500); await page.screenshot({ path: path.join(out, `${name}-${scheme}.png`) }); console.log('shot', `${name}-${scheme}`); };
		await page.goto(`${url}/#token=${PASSPHRASE}`);
		await page.getByTestId('nav-dashboard').waitFor();
		await shot('dashboard', { wait: 4000 });

		await page.getByTestId('edit-toggle').click();
		await page.getByTestId('add-widget').click();
		await page.getByTestId('picker').waitFor();
		await shot('layout-editor');
		await page.getByLabel('Close panel').click();
		await page.getByTestId('edit-toggle').click();

		await page.getByTestId('nav-devices').click();
		await page.getByTestId('services').waitFor();
		await shot('devices');
		await page.getByTestId('new-service').click();
		await page.getByTestId('new-device-dialog').waitFor();
		await shot('new-service', { wait: 800 });
		await page.keyboard.press('Escape');

		await page.getByTestId('nav-procedures').click();
		await shot('procedures', { wait: 800 });
		await context.close();
	}
	// a run in progress, for the procedures page
	for (const scheme of ['light', 'dark']) {
		script("run = lab.start_procedure('detuning_scan', offsets_khz=[-300, -200, -100, 0, 100, 200, 300], duration_s=4, name='scan_" + scheme + "')\ntime.sleep(8)");
		const context = await browser.newContext({ viewport: { width: 1440, height: 860 }, deviceScaleFactor: 2, colorScheme: scheme });
		const page = await context.newPage();
		await page.goto(`${url}/#token=${PASSPHRASE}`);
		await page.getByTestId('nav-procedures').click();
		await page.waitForTimeout(2000);
		await page.screenshot({ path: path.join(out, `procedures-run-${scheme}.png`) });
		await context.close();
		script("for r in lab.list_runs():\n    if r['status'] in ('running', 'paused'): lab.abort_run(r['id'])\ntime.sleep(3)");
	}
} finally {
	await browser?.close();
	server.kill();
}

import * as React from 'react'; import * as jsx from 'react/jsx-runtime'; import * as ReactDOM from 'react-dom';
import { createRoot } from 'react-dom/client';
import { HubConnectionBuilder } from '@microsoft/signalr'; import { MessagePackHubProtocol } from '@microsoft/signalr-protocol-msgpack';
import * as sdk from './sdk';
(globalThis as any).__lo = { react: React, 'react/jsx-runtime': jsx, 'react-dom': ReactDOM, '@laborchestra/sdk': sdk };
const hub = new HubConnectionBuilder().withUrl('/hub').withHubProtocol(new MessagePackHubProtocol()).build();
class Boundary extends React.Component<any, any> { state = { e: null as any }; static getDerivedStateFromError(e: any) { return { e }; }
  componentDidCatch(e: any) { hub.invoke('ReportError', String(e)); } render() { return this.state.e ? <div id="crash">{String(this.state.e)}</div> : this.props.children; } }
const style = document.createElement('style'); document.head.append(style);
let W: any = null, v = '', err = ''; const root = createRoot(document.getElementById('root')!);
const render = () => root.render(<sdk.DeviceContext value={{ pressure: { value: '3.2e-7' } }}>
  <div id="hostbox" className="p-2 md:p-4">host</div>{err && <pre id="builderr">{err}</pre>}
  {W && <Boundary key={v}><W /></Boundary>}</sdk.DeviceContext>);
async function update(u: any) { err = u.Error ?? ''; if (!err) { style.textContent = await (await fetch('/widgets.css?v=' + u.Version)).text(); W = (await import(/* @vite-ignore */ '/widgets/demo.js?v=' + u.Version)).default; v = u.Version; } render(); }
hub.on('widget', update);
hub.on('bin', (d: any) => { (window as any).bin = { type: d.constructor.name, aligned: d.byteOffset % 4 === 0, sum: Array.from(new Float32Array(d.slice().buffer)).reduce((a, b) => a + b, 0) }; });
hub.start().then(async () => { await update(await hub.invoke('Current')); await hub.invoke('Bin'); });

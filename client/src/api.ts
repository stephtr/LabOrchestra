import { invokeHub, Schema } from './store';

export type DeviceFile = { file: string; devices: string[] };
/** An entry of devices.json: {"noise": {"secret": "name"}} in config refers to a secret. */
export type DeviceEntry = {
	file: string;
	python: string | null;
	config: Record<string, unknown> | null;
	description: string | null;
};

export const api = {
	listDeviceFiles: () => invokeHub<DeviceFile[]>('list_device_files'),
	describeDeviceFile: (file: string) => invokeHub<Schema>('describe_device_file', file),
	getDeviceConfig: (id: string) => invokeHub<DeviceEntry>('get_device_config', id),
	addDevice: (id: string, entry: Partial<DeviceEntry>) => invokeHub('add_device', id, entry),
	updateDevice: (id: string, entry: Partial<DeviceEntry>) => invokeHub('update_device', id, entry),
	removeDevice: (id: string) => invokeHub('remove_device', id),
	restartDevice: (id: string) => invokeHub('restart_device', id),
	listSecrets: () => invokeHub<string[]>('list_secrets'),
	setSecret: (name: string, value: string) => invokeHub('set_secret', name, value),
	deleteSecret: (name: string) => invokeHub('delete_secret', name),
};

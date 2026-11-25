import { invokeHub, Schema } from './store';

export type DeviceFile = { file: string; devices: string[] };
export type DriverInfo = { driver: string; class: string; doc: string | null };
/** An entry of devices.json: {"noise": {"secret": "name"}} in config refers to a secret. */
export type DeviceEntry = {
	file: string | null;
	driver: string | null;
	python: string | null;
	config: Record<string, unknown> | null;
	description: string | null;
};

export type EnvironmentInfo = {
	key: string;
	python: string | null;
	dependencies: string[];
	size_mb: number;
	last_used: number;
	used_by: string[];
};
export type PythonInfo = { version: string; path: string; implementation: string | null };

export const api = {
	listEnvironments: () => invokeHub<EnvironmentInfo[]>('list_environments'),
	cleanupEnvironments: (days: number) => invokeHub<EnvironmentInfo[]>('cleanup_environments', days),
	listPythons: () => invokeHub<PythonInfo[]>('list_pythons'),
	listDeviceFiles: () => invokeHub<DeviceFile[]>('list_device_files'),
	describeDeviceFile: (file: string) => invokeHub<Schema>('describe_device_file', file),
	listDrivers: () => invokeHub<DriverInfo[]>('list_drivers'),
	describeDriver: (driver: string) => invokeHub<Schema>('describe_driver', driver),
	listDeviceEntries: () => invokeHub<Record<string, DeviceEntry>>('list_device_entries'),
	getDeviceConfig: (id: string) => invokeHub<DeviceEntry>('get_device_config', id),
	addDevice: (id: string, entry: Partial<DeviceEntry>) => invokeHub('add_device', id, entry),
	updateDevice: (id: string, entry: Partial<DeviceEntry>) => invokeHub('update_device', id, entry),
	removeDevice: (id: string) => invokeHub('remove_device', id),
	restartDevice: (id: string) => invokeHub('restart_device', id),
	listSecrets: () => invokeHub<string[]>('list_secrets'),
	setSecret: (name: string, value: string) => invokeHub('set_secret', name, value),
	deleteSecret: (name: string) => invokeHub('delete_secret', name),
};

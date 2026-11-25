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
	/** A worker on another machine provides this device. */
	remote?: boolean;
	/** A device that an installed Python package offers: the package (a pip requirement, or a folder) and the name of its entry point. */
	package?: string | null;
	entry?: string | null;
};
export type TokenInfo = { id: string; kind: string; device: string | null; label: string; created: number };
export type CreatedToken = { token: string; id: string; device: string; label: string };

export type EnvironmentInfo = {
	key: string;
	python: string | null;
	dependencies: string[];
	size_mb: number;
	last_used: number;
	used_by: string[];
};
export type PythonInfo = { version: string; path: string; implementation: string | null };

export type TemplateInfo = { id: string; title: string; description: string; profile: string | null; source: string };
export type Scaffolded = { device: string; file: string; path: string; template: string };

export type ScaffoldedWidget = { widget: string; name: string; file: string; path: string; template: string };

export type PackageContents = {
	devices: { name: string; value: string; package: string | null; version: string | null }[];
	widgets: { name: string; package: string | null; file: string | null; error: string | null }[];
	entry: string | null;
	schema: Schema | null;
};

export const api = {
	openFile: (path: string, how: 'editor' | 'folder') => invokeHub<string>('open_file', path, how),
	describePackage: (pkg: string, entry: string | null, python: string | null) => invokeHub<PackageContents>('describe_package', pkg, entry, python),
	listWidgetTemplates: () => invokeHub<TemplateInfo[]>('list_widget_templates'),
	scaffoldWidget: (template: string, name: string) => invokeHub<ScaffoldedWidget>('scaffold_widget', template, name),
	listTemplates: () => invokeHub<TemplateInfo[]>('list_templates'),
	scaffoldDevice: (template: string, id: string, connection: string, python: string | null) => invokeHub<Scaffolded>('scaffold_device', template, id, connection, python),
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
	createToken: (device: string, label: string) => invokeHub<CreatedToken>('create_token', device, label),
	listTokens: () => invokeHub<TokenInfo[]>('list_tokens'),
	revokeToken: (id: string) => invokeHub('revoke_token', id),
	listSecrets: () => invokeHub<string[]>('list_secrets'),
	setSecret: (name: string, value: string) => invokeHub('set_secret', name, value),
	deleteSecret: (name: string) => invokeHub('delete_secret', name),
};

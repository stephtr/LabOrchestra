/** State patches, see python/src/laborchestra/_patch.py: {"set": {"channels.1.pressure": 3e-7}, "del": ["name"]}. */
export type Patch = { set?: Record<string, unknown>; del?: string[] };

type Container = Record<string, unknown> | unknown[];

function change(node: unknown, parts: string[], path: string, value: unknown, remove: boolean): Container {
	if (node === null || typeof node !== 'object') throw new Error(`Path '${path}' does not exist`);
	const [head, ...rest] = parts as [string, ...string[]];
	const isList = Array.isArray(node);
	const copy = (isList ? [...node] : { ...node }) as Record<string, unknown>;
	if (isList && !(/^\d+$/.test(head) && Number(head) < node.length)) throw new Error(`Path '${path}' does not exist`);
	if (rest.length === 0) {
		if (remove) {
			if (isList || !(head in copy)) throw new Error(`Nothing to delete at '${path}'`);
			delete copy[head];
		} else {
			copy[head] = value;
		}
	} else {
		copy[head] = change(copy[head], rest, path, value, remove);
	}
	return copy;
}

/** A new state with the patch applied (the old one is left alone). Throws if a path does not exist. */
export function applyPatch<T extends Container>(state: T, patch: Patch): T {
	let result: Container = state;
	for (const path of patch.del ?? []) result = change(result, path.split('.'), path, undefined, true);
	for (const [path, value] of Object.entries(patch.set ?? {})) result = change(result, path.split('.'), path, value, false);
	return result as T;
}

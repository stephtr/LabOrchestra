// What a package ships: a built ES module (here written by hand). react and the SDK come from the page.
import { jsx } from 'react/jsx-runtime';
import { Tile, useDevice } from '@laborchestra/widget';

export const meta = { title: 'Packaged tile', size: 'S' };

export default function PackagedTile({ device }) {
	const d = useDevice(device);
	return jsx(Tile, { label: 'from a package', testId: 'packaged-tile', children: jsx('span', { className: 'text-lime-600', 'data-testid': 'packaged-count', children: String(d?.state.count) }) });
}

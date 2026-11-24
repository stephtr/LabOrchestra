export function NumberParser(format: Intl.NumberFormat) {
	const parts = format.formatToParts(12345.6);
	const numerals = Array.from({ length: 10 }).map((_, i) => format.format(i));
	const index = new Map(numerals.map((d, i) => [d, i]));
	const _group = new RegExp(
		`[${parts.find((d) => d.type === 'group')!.value}]`,
		'g',
	);
	const _decimal = new RegExp(
		`[${parts.find((d) => d.type === 'decimal')!.value}]`,
	);
	const _numeral = new RegExp(`[${numerals.join('')}]`, 'g');
	const _index = (d: string) => index.get(d)!.toString();
	return function parse(string: string) {
		return (string = string
			.trim()
			.replace(_group, '')
			.replace(_decimal, '.')
			.replace(_numeral, _index))
			? +string
			: NaN;
	};
}

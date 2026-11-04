/**
 * Just enough XML for EC2's responses: elements, text, CDATA, comments and
 * the standard entities. It scans with indexOf, so it runs in linear time
 * on any input. Attributes are ignored (EC2 only uses them for xmlns).
 */

export interface XmlNode {
	name: string;
	text: string;
	children: XmlNode[];
}

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decode(value: string) {
	return value.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,4});/gi, (entity, code: string) => {
		if (code.startsWith('#x') || code.startsWith('#X')) {
			return String.fromCodePoint(parseInt(code.slice(2), 16));
		}
		if (code.startsWith('#')) return String.fromCodePoint(parseInt(code.slice(1), 10));
		return ENTITIES[code] ?? entity;
	});
}

export function parseXml(xml: string): XmlNode {
	const root: XmlNode = { name: '#document', text: '', children: [] };
	const stack = [root];
	const close = (marker: string, from: number) => {
		const end = xml.indexOf(marker, from);
		if (end === -1) throw new Error('Unterminated XML');
		return end;
	};
	let i = 0;
	while (i < xml.length) {
		const open = xml.indexOf('<', i);
		const current = stack[stack.length - 1]!;
		if (open === -1) {
			current.text += decode(xml.slice(i));
			break;
		}
		if (open > i) current.text += decode(xml.slice(i, open));
		if (xml.startsWith('<?', open)) {
			i = close('?>', open) + 2;
		} else if (xml.startsWith('<!--', open)) {
			i = close('-->', open) + 3;
		} else if (xml.startsWith('<![CDATA[', open)) {
			const end = close(']]>', open);
			current.text += xml.slice(open + 9, end);
			i = end + 3;
		} else if (xml.startsWith('<!', open)) {
			// a DOCTYPE: no entities or DTDs are ever expanded
			i = close('>', open) + 1;
		} else {
			const end = close('>', open);
			const tag = xml.slice(open + 1, end);
			if (tag.startsWith('/')) {
				if (stack.length < 2 || current.name !== tag.slice(1).trim()) {
					throw new Error(`Unexpected </${tag.slice(1).trim()}> in XML`);
				}
				stack.pop();
			} else {
				const selfClosing = tag.endsWith('/');
				const body = (selfClosing ? tag.slice(0, -1) : tag).trim();
				const space = body.search(/\s/);
				const node: XmlNode = {
					name: space === -1 ? body : body.slice(0, space),
					text: '',
					children: []
				};
				current.children.push(node);
				if (!selfClosing) stack.push(node);
			}
			i = end + 1;
		}
	}
	if (stack.length !== 1) throw new Error(`Unclosed <${stack[stack.length - 1]!.name}> in XML`);
	return root;
}

/** The element at a path of child names, e.g. `at(response, 'vpcSet', 'item')`. */
export function at(node: XmlNode | undefined, ...names: string[]): XmlNode | undefined {
	let found = node;
	for (const name of names) found = found?.children.find((child) => child.name === name);
	return found;
}

/** The trimmed text at a path, or null when it's missing. */
export function text(node: XmlNode | undefined, ...names: string[]): string | null {
	const found = at(node, ...names);
	return found ? found.text.trim() : null;
}

/** The `<item>`s of the set at a path, as EC2 writes lists. */
export function items(node: XmlNode | undefined, ...names: string[]): XmlNode[] {
	return at(node, ...names)?.children.filter((child) => child.name === 'item') ?? [];
}

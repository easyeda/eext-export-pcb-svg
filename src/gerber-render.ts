/**
 * 把 tracespace plotter 输出的 image-tree 转换为 SVG 字符串。
 *
 * 这里使用 @tracespace/renderer 渲染出 SVG 抽象树，再手动序列化为字符串。
 * 与 tracespace 官方渲染保持一致： Gerber Y 向上 → SVG Y 向下，
 * 通过直接对坐标取负实现，避免自定义路径拼接错误。
 */

import type { ImageTree } from '@tracespace/plotter';
import type { GerberLayerText } from './gerber-source.ts';
import { parse } from '@tracespace/parser';
import { plot } from '@tracespace/plotter';
import { render } from '@tracespace/renderer';

export interface RenderedSvg {
	filename: string;
	content: string;
	role: GerberLayerText['role'];
}

interface HastElement {
	type: 'element';
	tagName: string;
	properties?: Record<string, unknown>;
	children?: (HastElement | string)[];
}

const VOID_TAGS = new Set([
	'area',
	'base',
	'br',
	'col',
	'embed',
	'hr',
	'img',
	'input',
	'link',
	'meta',
	'param',
	'source',
	'track',
	'wbr',
	'circle',
	'ellipse',
	'line',
	'path',
	'polygon',
	'polyline',
	'rect',
	'stop',
]);

function escapeAttr(s: string): string {
	return s.replace(/[&<>"']/g, c => (
		{ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&apos;' }[c]!
	));
}

const SPECIAL_ATTRS: Record<string, string> = {
	xmlnsXLink: 'xmlns:xlink',
	strokeLineCap: 'stroke-linecap',
	strokeLineJoin: 'stroke-linejoin',
	strokeWidth: 'stroke-width',
	fillRule: 'fill-rule',
	clipRule: 'clip-rule',
	viewBox: 'viewBox',
};

function propertyNameToAttr(name: string): string {
	if (SPECIAL_ATTRS[name])
		return SPECIAL_ATTRS[name];
	return name.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`);
}

function propertiesToAttrs(properties: Record<string, unknown>): string {
	const parts: string[] = [];
	for (const [key, value] of Object.entries(properties)) {
		if (value == null || value === false)
			continue;
		const attr = propertyNameToAttr(key);
		const v = value === true ? '' : String(value);
		parts.push(`${attr}="${escapeAttr(v)}"`);
	}
	return parts.join(' ');
}

function hastToXml(node: HastElement | string): string {
	if (typeof node === 'string')
		return escapeAttr(node);

	const { tagName, properties = {}, children = [] } = node;
	const attrs = propertiesToAttrs(properties);
	const open = attrs ? `<${tagName} ${attrs}` : `<${tagName}`;

	if (VOID_TAGS.has(tagName) && children.length === 0)
		return `${open}/>`;

	const inner = children.map(hastToXml).join('');
	return `${open}>${inner}</${tagName}>`;
}

function safeGerberFilename(name: string): string {
	const sanitized = name.replace(/[\\/:*?"<>|]/g, '_').trim() || 'Layer';
	return `${sanitized}.svg`;
}

/** 渲染一层的 SVG 文件 */
function renderLayer(layer: GerberLayerText): RenderedSvg {
	let tree;
	try {
		tree = parse(layer.text);
	}
	catch (e) {
		return {
			filename: safeGerberFilename(layer.originalFilename),
			role: layer.role,
			content: `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" version="1.1" viewBox="0 0 100 100"><text x="10" y="50" font-size="6">Parse error: ${escapeAttr(String((e as Error).message || e))}</text></svg>`,
		};
	}

	let image: ImageTree;
	try {
		image = plot(tree);
	}
	catch (e) {
		return {
			filename: safeGerberFilename(layer.originalFilename),
			role: layer.role,
			content: `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" version="1.1" viewBox="0 0 100 100"><text x="10" y="50" font-size="6">Plot error: ${escapeAttr(String((e as Error).message || e))}</text></svg>`,
		};
	}

	const color = layer.color || '#888888';
	const svg = render(image) as HastElement;

	// 设置整层颜色（fill/stroke 使用 currentColor）
	svg.properties = {
		...svg.properties,
		style: `color:${escapeAttr(color)}`,
	};

	const xml = hastToXml(svg);

	return {
		filename: safeGerberFilename(layer.originalFilename),
		role: layer.role,
		content: `<?xml version="1.0" encoding="UTF-8"?>\n${xml}\n`,
	};
}

/** 入口：渲染所有层 */
export function renderGerberLayersToSvgs(layers: GerberLayerText[]): RenderedSvg[] {
	return layers.map(renderLayer);
}

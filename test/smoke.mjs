#!/usr/bin/env node
/* eslint-disable no-console */

/**
 * test/smoke.mjs — Node-only smoke test for the tracespace v5 pipeline.
 *
 * Reads test/test.zip, parses each Gerber/Excellon layer with the same
 * parser/plotter/renderer used by the extension, and asserts that the
 * required layers produce valid SVGs with paths.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parse } from '@tracespace/parser';
import { plot } from '@tracespace/plotter';
import { render } from '@tracespace/renderer';
import JSZip from 'jszip';

const __dirname = path.dirname(fileURLToPath(new URL(import.meta.url)));
const FIXTURE = path.join(__dirname, 'test.zip');

const REQUIRED_LAYERS = ['GTL', 'GBL', 'GTO', 'GKO'];
const MIN_PATH_ELEMENTS = { GTL: 100, GBL: 10 };

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

const SPECIAL_ATTRS = {
	xmlnsXLink: 'xmlns:xlink',
	strokeLineCap: 'stroke-linecap',
	strokeLineJoin: 'stroke-linejoin',
	strokeWidth: 'stroke-width',
	fillRule: 'fill-rule',
	clipRule: 'clip-rule',
	viewBox: 'viewBox',
};

function propertyNameToAttr(name) {
	if (SPECIAL_ATTRS[name])
		return SPECIAL_ATTRS[name];
	return name.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`);
}

function escapeAttr(s) {
	return String(s)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;');
}

function propertiesToAttrs(properties) {
	const parts = [];
	for (const [key, value] of Object.entries(properties || {})) {
		if (value == null || value === false)
			continue;
		const attr = propertyNameToAttr(key);
		const v = value === true ? '' : String(value);
		parts.push(`${attr}="${escapeAttr(v)}"`);
	}
	return parts.join(' ');
}

function hastToXml(node) {
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

let pass = 0;
let fail = 0;
function assert(cond, msg) {
	if (cond) {
		console.log('  ✓', msg);
		pass++;
	}
	else {
		console.error('  ✗', msg);
		fail++;
	}
}

(async () => {
	console.log(`[smoke] fixture: ${FIXTURE}`);
	if (!fs.existsSync(FIXTURE)) {
		console.error(`missing fixture: ${FIXTURE}`);
		process.exit(1);
	}

	const zip = await JSZip.loadAsync(fs.readFileSync(FIXTURE));
	const stats = {};

	for (const name of Object.keys(zip.files)) {
		const entry = zip.files[name];
		if (entry.dir)
			continue;
		const filename = name.split('/').pop();
		const ext = (filename.split('.').pop() || '').toUpperCase();
		const text = await entry.async('string');
		if (!text || !text.trim())
			continue;

		try {
			const tree = parse(text);
			const image = plot(tree);
			const svg = render(image);
			const xml = hastToXml(svg);
			const paths = (xml.match(/<path\b/g) || []).length;
			stats[ext] = { filename, paths, size: xml.length };
		}
		catch (err) {
			stats[ext] = { filename, error: String(err.message || err).slice(0, 80) };
		}
	}

	console.log('[smoke] parse report:');
	console.table(Object.fromEntries(
		Object.entries(stats).map(([k, v]) => [k, {
			filename: v.filename,
			paths: v.paths ?? '-',
			size: v.size ?? '-',
			error: v.error ?? '',
		}]),
	));

	console.log('[smoke] assertions:');
	for (const ext of REQUIRED_LAYERS) {
		assert(stats[ext] && !stats[ext].error, `layer ${ext} parsed without error`);
	}
	assert(stats.GTL?.paths >= MIN_PATH_ELEMENTS.GTL, `GTL emits ≥${MIN_PATH_ELEMENTS.GTL} SVG paths (got ${stats.GTL?.paths})`);
	assert(stats.GBL?.paths >= MIN_PATH_ELEMENTS.GBL, `GBL emits ≥${MIN_PATH_ELEMENTS.GBL} SVG paths (got ${stats.GBL?.paths})`);

	console.log(`[smoke] ${pass} passed, ${fail} failed`);
	process.exit(fail ? 1 : 0);
})().catch((e) => {
	console.error('[smoke] crashed:', e);
	process.exit(1);
});

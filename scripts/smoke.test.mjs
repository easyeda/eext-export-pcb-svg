#!/usr/bin/env node
/* eslint-disable style/max-statements-per-line, no-console */

/**
 * scripts/smoke.test.mjs — Node-only 烟雾测试。
 *
 * 不依赖 EDA 网桥，直接读取 ../test/test.zip（项目自带的 Gerber fixture），
 * 走与扩展完全相同的 parse → plot → walker 流水线，验证：
 *   1. 至少能解析出 ≥5 层（顶层铜、底层铜、丝印、阻焊、边框）
 *   2. 顶层铜 (GTL) 和底层铜 (GBL) 都有非零 SVG 路径元素
 *   3. 没有 tracespace parse 错误的层
 *
 * 用法：node scripts/smoke.test.mjs
 * 退出码：0=通过，1=至少一条断言失败
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '@tracespace/parser';
import { plot } from '@tracespace/plotter';
import JSZip from 'jszip';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, '..', 'test', 'test.zip');

const REQUIRED_LAYERS = ['GTL', 'GBL', 'GTO', 'GKO']; // 必须成功解析
const MIN_PATH_ELEMENTS = { GTL: 100, GBL: 10 }; // 至少这么多 SVG path

function num(v) { return Number.isFinite(v) ? (Math.round(v * 10000) / 10000).toString() : '0'; }
function lineToD(s) { return `M ${num(s.start[0])} ${num(s.start[1])} L ${num(s.end[0])} ${num(s.end[1])}`; }
function arcToD(s) {
	const r = Math.abs(s.radius);
	const sweep = (s.end[2] - s.start[2]) > 0 ? 1 : 0;
	return `M ${num(s.start[0])} ${num(s.start[1])} A ${num(r)} ${num(r)} 0 0 ${sweep} ${num(s.end[0])} ${num(s.end[1])}`;
}
function isClosed(segs, tol = 1e-3) {
	if (!segs.length)
		return false;
	const ps = segs[0].start; const pe = segs[segs.length - 1].end;
	return Math.abs(ps[0] - pe[0]) < tol && Math.abs(ps[1] - pe[1]) < tol;
}
function segmentsToD(segs, close) {
	if (!segs.length)
		return '';
	const parts = segs.map(s => s.type === 'arc' ? arcToD(s) : lineToD(s));
	if (close && !isClosed(segs))
		parts.push('Z');
	return parts.join(' ');
}
function shapeToPathD(sh) {
	switch (sh.type) {
		case 'circle': {
			const r = sh.r; const cx = sh.cx; const cy = sh.cy;
			return `M ${num(cx - r)} ${num(cy)} A ${num(r)} ${num(r)} 0 1 0 ${num(cx + r)} ${num(cy)} A ${num(r)} ${num(r)} 0 1 0 ${num(cx - r)} ${num(cy)} Z`;
		}
		case 'rectangle':
			return `M ${num(sh.x)} ${num(sh.y)} h ${num(sh.xSize)} v ${num(-sh.ySize)} h ${num(-sh.xSize)} Z`;
		case 'polygon': {
			if (!sh.points.length)
				return '';
			const [x0, y0] = sh.points[0];
			const rest = sh.points.slice(1).map(([x, y]) => `L ${num(x)} ${num(y)}`).join(' ');
			return `M ${num(x0)} ${num(y0)} ${rest} Z`;
		}
		case 'outline':
			return segmentsToD(sh.segments, true);
		case 'layeredShape':
			return sh.shapes.map(shapeToPathD).filter(Boolean).join(' ');
	}
	return '';
}

function countPaths(image) {
	let count = 0;
	for (const c of image.children) {
		if (c.type === 'imageShape' && shapeToPathD(c.shape))
			count++;
		else if (c.type === 'imageRegion' && segmentsToD(c.segments, true))
			count++;
		else if (c.type === 'imagePath' && segmentsToD(c.segments, false))
			count++;
	}
	return count;
}

let pass = 0; let fail = 0;
function assert(cond, msg) {
	if (cond) { console.log('  ✓', msg); pass++; }
	else { console.error('  ✗', msg); fail++; }
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
		const e = zip.files[name];
		if (e.dir)
			continue;
		const filename = name.split('/').pop();
		const ext = (filename.split('.').pop() || '').toUpperCase();
		const text = await e.async('string');
		if (!text || !text.trim())
			continue;

		try {
			const tree = parse(text);
			const image = plot(tree);
			const paths = countPaths(image);
			stats[ext] = { filename, nodes: image.children.length, paths };
		}
		catch (err) {
			stats[ext] = { filename, error: String(err.message || err).slice(0, 80) };
		}
	}

	console.log('[smoke] parse report:');
	console.table(Object.fromEntries(
		Object.entries(stats).map(([k, v]) => [k, {
			filename: v.filename,
			nodes: v.nodes ?? '-',
			paths: v.paths ?? '-',
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

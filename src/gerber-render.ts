/**
 * 把 tracespace plotter 输出的 image-tree 转换为 SVG 字符串。
 *
 * 节点类型见 @tracespace/plotter 的 ImageGraphic 联合：
 *   - ImageShape: 几何体（circle / rectangle / polygon / outline / layeredShape）
 *   - ImagePath:  描边路径（带 width）
 *   - ImageRegion: 填充区域（多段闭合路径）
 */

import type {
	ImagePath,
	ImageShape,
	ImageTree,
	PathArcSegment,
	PathLineSegment,
	PathSegment,
} from '@tracespace/plotter';
import type { GerberLayerText } from './gerber-source.ts';
import { parse } from '@tracespace/parser';
import { plot } from '@tracespace/plotter';

export interface RenderedSvg {
	filename: string;
	content: string;
	role: GerberLayerText['role'];
}

/** file 名清洗（保留中文与 ASCII，去掉文件系统非法字符） */
function sanitizeFilename(name: string): string {
	return name.replace(/[\\/:*?"<>|]/g, '_').trim() || 'Layer';
}

function num(v: number): string {
	if (!Number.isFinite(v))
		return '0';
	return (Math.round(v * 10000) / 10000).toString();
}

/** line segment → M/L */
function lineToD(s: PathLineSegment): string {
	return `M ${num(s.start[0])} ${num(s.start[1])} L ${num(s.end[0])} ${num(s.end[1])}`;
}

/** arc segment → SVG A 命令。ArcPosition 第三个元素是切线角，Y 向上 → SVG Y 向下，sweep 翻转。 */
function arcToD(s: PathArcSegment): string {
	const r = Math.abs(s.radius);
	// Y 向上 → SVG Y 向下 翻转：sweep 1↔0
	const sweep = (s.end[2] - s.start[2]) > 0 ? 1 : 0;
	return `M ${num(s.start[0])} ${num(s.start[1])} A ${num(r)} ${num(r)} 0 0 ${sweep} ${num(s.end[0])} ${num(s.end[1])}`;
}

/** 路径是否在视觉上闭合（首尾点重合） */
function isClosed(segs: PathSegment[], tol = 1e-3): boolean {
	if (segs.length === 0)
		return false;
	const first = segs[0];
	const last = segs[segs.length - 1];
	const ps = first.type === 'line' ? first.start : first.start;
	const pe = last.type === 'line' ? last.end : last.end;
	return Math.abs(ps[0] - pe[0]) < tol && Math.abs(ps[1] - pe[1]) < tol;
}

function segmentsToD(segs: PathSegment[], close: boolean): string {
	if (segs.length === 0)
		return '';
	const parts: string[] = [];
	for (const seg of segs) {
		parts.push(seg.type === 'arc' ? arcToD(seg) : lineToD(seg));
	}
	if (close && !isClosed(segs))
		parts.push('Z');
	return parts.join(' ');
}

function escapeAttr(s: string): string {
	return s.replace(/[&<>"']/g, c => (
		{ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&apos;' }[c]!
	));
}

/** 从 ImageTree 求 size 包围盒（SizeEnvelope = [x1,y1,x2,y2] 或 []） */
function envelopeOf(img: ImageTree): [number, number, number, number] | null {
	const s = img.size;
	if (s.length === 0)
		return null;
	return [s[0], s[1], s[2], s[3]];
}

/** 把 ImageShape 里的几何描述拼成 SVG 片段 */
function shapeToPathD(shape: ImageShape['shape']): string {
	const sh = shape as ImageShape['shape'];
	switch (sh.type) {
		case 'circle': {
			const r = sh.r;
			const cx = sh.cx;
			const cy = sh.cy;
			return `M ${num(cx - r)} ${num(cy)} A ${num(r)} ${num(r)} 0 1 0 ${num(cx + r)} ${num(cy)} A ${num(r)} ${num(r)} 0 1 0 ${num(cx - r)} ${num(cy)} Z`;
		}
		case 'rectangle': {
			const x = sh.x;
			const y = sh.y;
			const w = sh.xSize;
			const h = sh.ySize;
			return `M ${num(x)} ${num(y)} h ${num(w)} v ${num(-h)} h ${num(-w)} Z`;
		}
		case 'polygon': {
			if (!sh.points.length)
				return '';
			const [x0, y0] = sh.points[0]!;
			const rest = sh.points.slice(1).map(([x, y]) => `L ${num(x)} ${num(y)}`).join(' ');
			return `M ${num(x0)} ${num(y0)} ${rest} Z`;
		}
		case 'outline': {
			return segmentsToD(sh.segments, true);
		}
		case 'layeredShape': {
			const parts = sh.shapes.map(s => shapeToPathD(s));
			return parts.filter(Boolean).join(' ');
		}
	}
	return '';
}

/** 渲染一层的 SVG 文件 */
function renderLayer(layer: GerberLayerText): RenderedSvg {
	let tree;
	try {
		tree = parse(layer.text);
	}
	catch (e) {
		return {
			filename: safeLayerFilename(layer.layerName),
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
			filename: safeLayerFilename(layer.layerName),
			role: layer.role,
			content: `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" version="1.1" viewBox="0 0 100 100"><text x="10" y="50" font-size="6">Plot error: ${escapeAttr(String((e as Error).message || e))}</text></svg>`,
		};
	}
	// 包围盒
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	const expandPos = (x: number, y: number) => {
		if (x < minX)
			minX = x;
		if (y < minY)
			minY = y;
		if (x > maxX)
			maxX = x;
		if (y > maxY)
			maxY = y;
	};
	for (const child of image.children) {
		if (child.type === 'imageShape') {
			const sh = child.shape;
			if (sh.type === 'circle') {
				expandPos(sh.cx - sh.r, sh.cy - sh.r);
				expandPos(sh.cx + sh.r, sh.cy + sh.r);
			}
			else if (sh.type === 'rectangle') {
				expandPos(sh.x, sh.y);
				expandPos(sh.x + sh.xSize, sh.y - sh.ySize);
			}
			else if (sh.type === 'polygon') {
				for (const [x, y] of sh.points) expandPos(x, y);
			}
			else if (sh.type === 'outline' || sh.type === 'layeredShape') {
				// 粗略包含：遍历 segments
				const segs = sh.type === 'outline' ? sh.segments : [];
				for (const s of segs) {
					expandPos(s.start[0], s.start[1]);
					expandPos(s.end[0], s.end[1]);
				}
				if (sh.type === 'layeredShape') {
					for (const s of sh.shapes) {
						if (s.type === 'circle') {
							expandPos(s.cx - s.r, s.cy - s.r);
							expandPos(s.cx + s.r, s.cy + s.r);
						}
						else if (s.type === 'rectangle') {
							expandPos(s.x, s.y);
							expandPos(s.x + s.xSize, s.y - s.ySize);
						}
					}
				}
			}
		}
		else if (child.type === 'imagePath' || child.type === 'imageRegion') {
			for (const s of child.segments) {
				expandPos(s.start[0], s.start[1]);
				expandPos(s.end[0], s.end[1]);
			}
		}
	}
	const env = envelopeOf(image);
	if (env) {
		expandPos(env[0], env[1]);
		expandPos(env[2], env[3]);
	}
	if (!Number.isFinite(minX)) {
		minX = 0;
		minY = 0;
		maxX = 100;
		maxY = 100;
	}
	const pad = 1;
	const w = maxX - minX + 2 * pad;
	const h = maxY - minY + 2 * pad;
	const color = layer.color || '#888888';

	const bodyParts: string[] = [];
	for (const child of image.children) {
		if (child.type === 'imageShape') {
			const d = shapeToPathD(child.shape);
			if (!d)
				continue;
			bodyParts.push(`<path class="pcb-fill" d="${d}" />`);
		}
		else if (child.type === 'imageRegion') {
			const d = segmentsToD(child.segments, true);
			if (!d)
				continue;
			bodyParts.push(`<path class="pcb-fill" d="${d}" fill-rule="evenodd" />`);
		}
		else if (child.type === 'imagePath') {
			const d = segmentsToD(child.segments, false);
			if (!d)
				continue;
			const w = (child as ImagePath).width || 0;
			bodyParts.push(`<path class="pcb-stroke" d="${d}"${w ? ` stroke-width="${num(w)}"` : ''} />`);
		}
	}

	const svg = `<?xml version="1.0" encoding="UTF-8"?>\n`
		+ `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="${num(w)}" height="${num(h)}" viewBox="${num(minX - pad)} ${num(-(maxY + pad))} ${num(w)} ${num(h)}">\n`
		+ `<defs><style>.pcb-fill{fill:${escapeAttr(color)};stroke:none;}.pcb-stroke{fill:none;stroke:${escapeAttr(color)};stroke-linejoin:round;stroke-linecap:round;}</style></defs>\n`
		+ `<g class="pcb-layer" transform="scale(1,-1)">\n${
			bodyParts.join('')
		}\n</g>\n</svg>\n`;

	return {
		filename: safeLayerFilename(layer.layerName),
		role: layer.role,
		content: svg,
	};
}

function safeLayerFilename(name: string): string {
	return `${sanitizeFilename(name)}.svg`;
}

/** 入口：渲染所有层 */
export function renderGerberLayersToSvgs(layers: GerberLayerText[]): RenderedSvg[] {
	return layers.map(renderLayer);
}

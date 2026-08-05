/**
 * 从 EDA 画布获取铜皮/图元对应的网络名称，供 SVG 输出时给铜皮区域标注 `net` 属性。
 *
 * 画布坐标为 mil，SVG（Gerber）坐标为 mm，且均使用 Y 向上的坐标系：
 * mil = mm × 39.3701，无需镜像/平移（已用走线坐标验证）。
 *
 * 解析策略分两层：
 * 1. 焊盘/走线/过孔等普通图元：对代表点调用 `getPrimitiveAtPoint()` 直接命中，
 *    取其网络；层 12（Multi-Layer 通孔/过孔）跨所有铜层，放行。
 * 2. 铺铜（POUR）：`getPrimitiveAtPoint` 命中不到铺铜填充面，改按铜皮图元的
 *    ComplexPolygon（draw rect）做重心点包含测试。该矩形在 EDA 的偏移坐标系里，
 *    偏移量由板框（Board Outline，layer 11）的 ComplexPolygon 与画布实际位置之差推导，
 *    因为板框的 draw rect 与画布位置是精确对应的（已验证 Y 偏移 +1260、X 无偏移）。
 */

export const MM2MIL = 1000 / 25.4;

export interface PourNet {
	net: string;
	layerId: number;
	primitiveId: string;
}

/** 铜皮的 draw rect（ComplexPolygon 包围盒，EDA 偏移坐标系）。 */
export interface PourGeom {
	primitiveId: string;
	net: string;
	layer: number;
	rect: { x: number; y: number; w: number; h: number } | null;
}

declare const eda: {
	pcb_PrimitivePour: {
		getAll: () => Promise<Array<{
			toAsync?: () => {
				getState_Net: () => string;
				getState_Layer: () => number;
				getState_PrimitiveId: () => string;
				getState_ComplexPolygon: () => unknown;
			};
			getState_Net?: () => string;
			getState_Layer?: () => number;
			getState_PrimitiveId?: () => string;
			getState_ComplexPolygon?: () => unknown;
			net?: string;
			layer?: number;
			primitiveId?: string;
		}>>;
	};
	pcb_Document: {
		getPrimitiveAtPoint: (x: number, y: number) => Promise<unknown>;
		getPrimitivesInRegion: (
			left: number,
			right: number,
			top: number,
			bottom: number,
		) => Promise<unknown[]>;
	};
};

interface HitPrimitive {
	getState_Net?: () => string;
	getState_Layer?: () => number;
	getState_PrimitiveId?: () => string;
	getState_ComplexPolygon?: () => unknown;
	net?: string;
	layer?: number;
	primitiveId?: string;
}

function asHitPrimitive(p: unknown): HitPrimitive | null {
	if (!p || typeof p !== 'object')
		return null;
	const anyP = p as { toAsync?: () => HitPrimitive } & HitPrimitive;
	if (typeof anyP.toAsync === 'function')
		return anyP.toAsync();
	return anyP;
}

/**
 * 枚举当前板子的所有铜皮图元，建立 primitiveId → 网络 的映射。
 * 仅读取，不修改画布。失败时返回空映射（不影响导出）。
 */
export async function collectPourNets(): Promise<Map<string, PourNet>> {
	const map = new Map<string, PourNet>();
	try {
		const pours = await eda.pcb_PrimitivePour.getAll();
		if (!Array.isArray(pours))
			return map;
		for (const p of pours) {
			const a = asHitPrimitive(p);
			if (!a)
				continue;
			const id = a.getState_PrimitiveId ? a.getState_PrimitiveId() : a.primitiveId;
			if (!id)
				continue;
			const net = (a.getState_Net ? a.getState_Net() : a.net) || '';
			const layer = a.getState_Layer ? a.getState_Layer() : a.layer;
			map.set(id, { net, layerId: typeof layer === 'number' ? layer : -1, primitiveId: id });
		}
	}
	catch (e) {
		console.warn('[export-pcb-svg] collectPourNets failed:', e);
	}
	return map;
}

/** 从 ComplexPolygon 提取 axis-aligned 包围盒（EDA 偏移坐标系）。 */
function polygonBBox(polygon: unknown): { x: number; y: number; w: number; h: number } | null {
	if (!Array.isArray(polygon))
		return null;
	if (polygon[0] === 'R') {
		const [, x, y, w, h] = polygon as [string, number, number, number, number];
		if ([x, y, w, h].every(n => typeof n === 'number'))
			return { x, y, w, h };
		return null;
	}
	const nums = (polygon as unknown[]).filter(v => typeof v === 'number');
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (let i = 0; i + 1 < nums.length; i += 2) {
		const x = nums[i] as number;
		const y = nums[i + 1] as number;
		if (x < minX)
			minX = x;
		if (x > maxX)
			maxX = x;
		if (y < minY)
			minY = y;
		if (y > maxY)
			maxY = y;
	}
	if (minX === Infinity)
		return null;
	return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** 枚举所有铜皮的 draw rect（偏移坐标系），供铺铜包含测试使用。失败时返回空数组。 */
export async function collectPourGeoms(): Promise<PourGeom[]> {
	const out: PourGeom[] = [];
	try {
		const pours = await eda.pcb_PrimitivePour.getAll();
		if (!Array.isArray(pours))
			return out;
		for (const p of pours) {
			const a = asHitPrimitive(p);
			if (!a)
				continue;
			const id = a.getState_PrimitiveId ? a.getState_PrimitiveId() : a.primitiveId;
			if (!id)
				continue;
			const net = (a.getState_Net ? a.getState_Net() : a.net) || '';
			const layer = a.getState_Layer ? a.getState_Layer() : a.layer;
			let rect: PourGeom['rect'] = null;
			try {
				const cp = a.getState_ComplexPolygon ? a.getState_ComplexPolygon() : null;
				const poly = cp && Array.isArray((cp as { polygon?: unknown }).polygon)
					? (cp as { polygon: unknown }).polygon
					: cp;
				rect = polygonBBox(poly);
			}
			catch {}
			out.push({
				primitiveId: id,
				net,
				layer: typeof layer === 'number' ? layer : -1,
				rect,
			});
		}
	}
	catch (e) {
		console.warn('[export-pcb-svg] collectPourGeoms failed:', e);
	}
	return out;
}

/**
 * 读取板框（Board Outline，layer 11）的 ComplexPolygon 包围盒（偏移坐标系）。
 * 板框的 draw rect 与画布实际位置精确对应，用它和画布位置的差推导出偏移量。
 * 返回 null 表示找不到板框。
 */
export async function collectBoardOutlineRect(): Promise<{ x: number; y: number; w: number; h: number } | null> {
	try {
		const prims = await eda.pcb_Document.getPrimitivesInRegion(-1e9, 1e9, -1e9, 1e9);
		if (!Array.isArray(prims))
			return null;
		for (const p of prims) {
			const a = asHitPrimitive(p);
			if (!a)
				continue;
			const layer = a.getState_Layer ? a.getState_Layer() : a.layer;
			if (typeof layer !== 'number' || layer !== 11)
				continue;
			const cp = a.getState_ComplexPolygon ? a.getState_ComplexPolygon() : null;
			const poly = cp && Array.isArray((cp as { polygon?: unknown }).polygon)
				? (cp as { polygon: unknown }).polygon
				: cp;
			const rect = polygonBBox(poly);
			if (rect)
				return rect;
		}
	}
	catch (e) {
		console.warn('[export-pcb-svg] collectBoardOutlineRect failed:', e);
	}
	return null;
}

export interface NetAtPointOptions {
	/** 当前铜皮 SVG 层对应的画布层 id */
	expectedLayerId: number;
	/** primitiveId → 网络（铜皮表） */
	pourById: Map<string, PourNet>;
	/** 铜皮 draw rect 列表（偏移坐标系） */
	pourGeoms?: PourGeom[];
	/** 偏移量：画布坐标 = 偏移坐标 - offset */
	offset?: { dx: number; dy: number };
}

/**
 * 命中画布上 (milX, milY) 处的图元，解析其网络。
 * 焊盘/走线/过孔走 getPrimitiveAtPoint；铺铜命中不到时按 draw rect 包含测试反查。
 * 返回 null 表示该点无网络（非铜皮区域 / 命中失败）。
 */
export async function netAtPoint(
	milX: number,
	milY: number,
	opts: NetAtPointOptions,
): Promise<string | null> {
	const { expectedLayerId, pourById, pourGeoms, offset } = opts;

	let prim: unknown;
	try {
		prim = await eda.pcb_Document.getPrimitiveAtPoint(milX, milY);
	}
	catch {
		prim = null;
	}
	const a = asHitPrimitive(prim);
	if (a) {
		// 层校验：命中图元需落在当前铜皮层，避免跨层误标。
		// 层 12 = Multi-Layer（通孔焊盘/过孔跨所有铜层），对任意铜皮层都有效。
		const layer = a.getState_Layer ? a.getState_Layer() : a.layer;
		if (typeof layer === 'number' && layer !== expectedLayerId && layer !== 12) {
			// 层号不匹配，但可能仍是铺铜区域，继续走 draw rect 包含测试
		}
		else {
			const net = (a.getState_Net ? a.getState_Net() : a.net) || '';
			if (net)
				return net;
			const id = a.getState_PrimitiveId ? a.getState_PrimitiveId() : a.primitiveId;
			if (id) {
				const pour = pourById.get(id);
				if (pour?.net)
					return pour.net;
			}
		}
	}

	// 铺铜区域：getPrimitiveAtPoint 命中不到，按 draw rect（偏移坐标 → 画布坐标）包含测试
	if (pourGeoms?.length && offset) {
		for (const g of pourGeoms) {
			if (g.layer !== expectedLayerId || !g.rect)
				continue;
			const x0 = g.rect.x - offset.dx;
			const y0 = g.rect.y - offset.dy;
			const x1 = x0 + g.rect.w;
			const y1 = y0 + g.rect.h;
			if (milX >= x0 && milX <= x1 && milY >= y0 && milY <= y1)
				return g.net || null;
		}
	}
	return null;
}

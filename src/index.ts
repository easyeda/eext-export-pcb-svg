/**
 * 嘉立创EDA 扩展入口：导出 PCB 为按层拆分的 SVG 文件，并打包为 ZIP。
 *
 * 流程：`getGerberFile` → JSZip 解压 → tracespace 解析/铺铜 → 自定义 SVG 拼装 → ZIP 打包。
 */

import extensionConfig from '../extension.json' with { type: 'json' };
import { renderGerberLayersToSvgs } from './gerber-render.ts';
import { collectGerberSources } from './gerber-source.ts';
import { buildZipBlobFromText } from './zip-builder.ts';

declare const eda: {
	sys_Message: { showToastMessage: (msg: string) => void };
	sys_Dialog: { showInformationMessage: (title: string, msg: string) => void };
	sys_I18n: { text: (key: string, fallback?: string, ...args: unknown[]) => string };
	sys_FileSystem: { saveFile: (blob: Blob, name: string) => Promise<boolean> };
	dmt_SelectControl: { getCurrentDocumentInfo: () => Promise<{ documentType?: number } | null> };
	dmt_Project: { getCurrentProjectInfo: () => Promise<{ friendlyName?: string; name?: string } | null> };
	dmt_Board: {
		getCurrentBoardInfo: () => Promise<{ name?: string; pcb?: { name?: string } } | null>;
		getAllBoardsInfo: () => Promise<Array<{ name?: string; pcb?: { name?: string } }>>;
	};
	pcb_Layer: { getAllLayers: () => Promise<Array<{ id: number; name: string; color: string; type: string }>> };
	pcb_ManufactureData: {
		getGerberFile: (
			fileName?: string,
			colorSilkscreen?: boolean,
			unit?: number,
			digitalFormat?: { integerNumber: number; decimalNumber: number },
		) => Promise<File | null | undefined>;
	};
};

function sanitizeFilename(name: string): string {
	return name.replace(/[\\/:*?"<>|]/g, '_').trim() || 'PCB';
}

function t(key: string, fallback: string, ...args: unknown[]): string {
	try {
		const v = eda.sys_I18n.text(key, fallback, ...args);
		if (v && v !== key)
			return v;
	}
	catch {}
	return fallback;
}

const MESSAGES = {
	openPcbFirst: 'Please open a PCB document first.',
	noLayers: 'No Gerber layers found in the export bundle.',
	noBoards: 'No boards found in the current project.',
	collecting: 'Exporting Gerber, please wait...',
	menuHint: 'Please open the PCB document and use the Export PCB to SVG menu.',
	exportedForBoard: (count: number, board: string) => `Exported ${count} SVG file(s) for ${board}.`,
	exportedBoards: (count: number) => `Exported ${count} board(s).`,
	exportFailed: (reason: string) => `Export failed: ${reason}`,
	aboutTitle: (version: string) => `Export PCB to SVG v${version}`,
	about: 'About',
} as const;

async function checkPcbActive(): Promise<boolean> {
	try {
		const doc = await eda.dmt_SelectControl.getCurrentDocumentInfo();
		return !!doc && doc.documentType === 3; // EDMT_EditorDocumentType.PCB
	}
	catch {
		return false;
	}
}

async function getBoardName(): Promise<string> {
	try {
		const info = await eda.dmt_Board.getCurrentBoardInfo();
		if (info?.name)
			return info.name;
		if (info?.pcb?.name)
			return info.pcb.name;
		const project = await eda.dmt_Project.getCurrentProjectInfo();
		if (project?.friendlyName)
			return project.friendlyName;
		if (project?.name)
			return project.name;
		return 'PCB';
	}
	catch {
		return 'PCB';
	}
}

async function exportOneBoard(boardName: string): Promise<{ zipName: string; blob: Blob; fileCount: number }> {
	console.log('[export-pcb-svg] step: getGerberFile');
	const layers = await collectGerberSources();
	console.log(`[export-pcb-svg] step: layers=${layers.length}`);

	if (layers.length === 0)
		throw new Error('No Gerber layers in bundle');

	console.log('[export-pcb-svg] step: render SVG');
	const rendered = renderGerberLayersToSvgs(layers);
	const fileMap: Record<string, string> = {};
	for (const f of rendered) fileMap[f.filename] = f.content;

	const blob = await buildZipBlobFromText(fileMap);
	const zipName = `${sanitizeFilename(boardName)}.zip`;
	return { zipName, blob, fileCount: rendered.length };
}

export function activate(_status?: 'onStartupFinished', _arg?: string): void {
	// no-op
}

export function menuPlaceholder(): void {
	eda.sys_Message.showToastMessage(t(MESSAGES.menuHint, MESSAGES.menuHint));
}

export async function exportCurrentBoardToSvg(): Promise<void> {
	try {
		if (!(await checkPcbActive())) {
			eda.sys_Dialog.showInformationMessage('', t(MESSAGES.openPcbFirst, MESSAGES.openPcbFirst));
			return;
		}
		const boardName = await getBoardName();
		eda.sys_Message.showToastMessage(t(MESSAGES.collecting, MESSAGES.collecting));

		const { zipName, blob, fileCount } = await exportOneBoard(boardName);
		console.log(`[export-pcb-svg] step: fileCount=${fileCount}`);

		if (fileCount === 0) {
			eda.sys_Dialog.showInformationMessage('', t(MESSAGES.noLayers, MESSAGES.noLayers));
			return;
		}

		await eda.sys_FileSystem.saveFile(blob, zipName);
		eda.sys_Message.showToastMessage(MESSAGES.exportedForBoard(fileCount, boardName));
	}
	catch (e) {
		console.error('[export-pcb-svg] exportCurrentBoardToSvg failed:', e);
		eda.sys_Message.showToastMessage(MESSAGES.exportFailed(String((e as Error)?.message ?? e)));
	}
}

export async function exportAllBoardsToSvg(): Promise<void> {
	try {
		const allBoards = await eda.dmt_Board.getAllBoardsInfo();
		if (!Array.isArray(allBoards) || allBoards.length === 0) {
			eda.sys_Dialog.showInformationMessage('', t(MESSAGES.noBoards, MESSAGES.noBoards));
			return;
		}
		// 当前 EDA 没有 per-board Gerber 接口，先只导出当前 PCB
		await exportCurrentBoardToSvg();
	}
	catch (e) {
		console.error('[export-pcb-svg] exportAllBoardsToSvg failed:', e);
		eda.sys_Message.showToastMessage(MESSAGES.exportFailed(String((e as Error)?.message ?? e)));
	}
}

export function about(): void {
	eda.sys_Dialog.showInformationMessage(
		MESSAGES.aboutTitle(extensionConfig.version),
		MESSAGES.about,
	);
}

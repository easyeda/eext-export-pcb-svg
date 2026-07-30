/**
 * 浏览器端 ZIP 打包工具
 *
 * 使用 JSZip 在浏览器（EasyEDA 扩展运行时）内创建 ZIP 文件，最终以 Blob 形式交给
 * `eda.sys_FileSystem.saveFile` 保存。
 */

import JSZip from 'jszip';

export interface ZipEntry {
	path: string;
	content: string | Uint8Array;
}

/**
 * 把若干个文本/二进制片段打包成一个 ZIP Blob。
 *
 * @param entries 文件名 → 内容映射
 * @returns ZIP 的 Blob，可直接用于 `saveFile`
 */
export async function buildZipBlob(entries: ZipEntry[]): Promise<Blob> {
	const zip = new JSZip();
	for (const entry of entries) {
		zip.file(entry.path, entry.content);
	}
	return zip.generateAsync({
		type: 'blob',
		compression: 'DEFLATE',
		compressionOptions: { level: 6 },
		mimeType: 'application/zip',
	});
}

/**
 * 把若干个文本片段打包成一个 ZIP Blob 的便捷方法。
 */
export async function buildZipBlobFromText(files: Record<string, string>): Promise<Blob> {
	const entries: ZipEntry[] = [];
	for (const [path, content] of Object.entries(files)) {
		entries.push({ path, content });
	}
	return buildZipBlob(entries);
}

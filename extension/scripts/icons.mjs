import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceDir = fileURLToPath(new URL('../assets/icons/', import.meta.url));

/** 复用选定图标的各尺寸成品，避免构建时重新绘制旧图标；跨平台无需图像工具。 */
export async function generateIcons(outDir) {
  await mkdir(outDir, { recursive: true });
  await copyFile(path.join(sourceDir, 'bilirecall.svg'), path.join(outDir, 'bilirecall.svg'));
  for (const size of [16, 32, 48, 128]) {
    const name = `icon${size}.png`;
    await copyFile(path.join(sourceDir, name), path.join(outDir, name));
  }
}

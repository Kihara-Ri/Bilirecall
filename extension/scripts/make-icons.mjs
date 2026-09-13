import { generateIcons } from './icons.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await generateIcons(path.join(root, 'public/icons'));
console.log('icons written');

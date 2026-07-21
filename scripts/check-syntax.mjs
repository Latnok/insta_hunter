import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import ejs from 'ejs';

async function collect(directory, pattern = /\.(?:js|mjs)$/) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const files = [];
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collect(target, pattern));
    else if (pattern.test(entry.name)) files.push(target);
  }
  return files;
}

const files = [...await collect('src'), ...await collect('scripts'), ...await collect('test')];
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
const templates = await collect('src/views', /\.ejs$/);
for (const template of templates) ejs.compile(await readFile(template, 'utf8'), { filename: template });
console.log(`Syntax OK: ${files.length} JavaScript files, ${templates.length} EJS templates`);

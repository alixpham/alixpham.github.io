#!/usr/bin/env node
/* ============================================================================
   FLAGSTER — SYNTAX CHECK

   There is no bundler and no transpiler here, so nothing sits between a typo
   and the browser. `node --check` on every source file is the whole linter:
   it catches the class of mistake that actually ships — an unclosed brace, a
   stray comma — before a deploy does.

   It does NOT catch undefined variables. That has bitten this repo before
   (`F.activeShell` where `F` was never bound passed a syntax check and threw
   in the browser), so a browser sweep is still the real gate.

     node tools/lint.mjs
   ============================================================================ */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIRS = ['flagster/js', 'tools'];
const SKIP = new Set(['node_modules', '.git']);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(js|mjs)$/.test(e.name)) out.push(p);
  }
  return out;
}

const files = DIRS.flatMap(d => (fs.existsSync(path.join(ROOT, d)) ? walk(path.join(ROOT, d)) : []));
let bad = 0;
for (const f of files) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  } catch (e) {
    bad++;
    console.error('✗ ' + path.relative(ROOT, f));
    console.error(String(e.stderr || e.message).trim().split('\n').slice(0, 4).join('\n'));
  }
}
console.log(`${files.length - bad}/${files.length} files parse` + (bad ? ` — ${bad} FAILED` : ' — clean'));
process.exit(bad ? 1 : 0);

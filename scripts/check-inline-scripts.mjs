// Syntax-checks inline <script> blocks in static public/ HTML files.
// tsc/vite never parse these (they're copied verbatim), so a broken bracket
// ships silently and breaks the page at runtime. Runs as part of `build`.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FILES = ['public/preview/snapshot.html', 'public/preview/checkin.html'];
const tmp = mkdtempSync(join(tmpdir(), 'inline-'));
let failed = 0;

for (const file of FILES) {
  let html;
  try { html = readFileSync(file, 'utf8'); } catch { continue; } // file optional
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  if (!scripts.length) continue;
  const js = scripts.join('\n;\n');
  const out = join(tmp, file.replace(/[\/]/g, '_') + '.js');
  writeFileSync(out, js);
  try {
    execFileSync(process.execPath, ['--check', out], { stdio: 'pipe' });
    console.log(`✓ ${file} — inline script OK`);
  } catch (e) {
    failed++;
    console.error(`✗ ${file} — inline script SYNTAX ERROR:\n${e.stderr?.toString() || e.message}`);
  }
}

if (failed) { console.error(`\n${failed} file(s) with broken inline scripts.`); process.exit(1); }

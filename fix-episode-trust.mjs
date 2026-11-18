import fs from 'node:fs';
import path from 'node:path';

const DIR = path.join(process.env.MEM_VAULT || findVault(), '40-归档/episodes');
const APPLY = process.argv.includes('--apply');

function* walk(d, dep = 0) {
  if (dep > 4) return;
  let e; try { e = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
  for (const x of e) {
    const f = path.join(d, x.name);
    if (x.isDirectory()) yield* walk(f, dep + 1);
    else if (x.name.endsWith('.md')) yield f;
  }
}

let fixed = 0, skip = 0;
for (const f of walk(DIR)) {
  let t = fs.readFileSync(f, 'utf8');
  const bom = t.charCodeAt(0) === 0xfeff;
  if (bom) t = t.slice(1);

  const i = t.indexOf('\n---', 3);
  if (i === -1) { skip++; continue; }
  let fm = t.slice(3, i);
  const rest = t.slice(i);

  if (/^trust\s*:/m.test(fm)) { skip++; continue; }

  // Episode 是亲历记录，默认 verified
  fm = fm.replace(/\s*$/, '') + '\ntrust: verified';
  fs.writeFileSync(f, '---' + fm + rest, 'utf8');
  fixed++;
  console.log('✓ ' + path.basename(f));
}

console.log(`\n补齐 ${fixed} 条，跳过 ${skip} 条（已有或非 Episode）`);

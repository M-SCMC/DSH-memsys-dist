#!/usr/bin/env node
/**
 * 拆分 source 字段的两个语义（2026-11-18）
 *
 * 问题：
 *   - 库里原有 source = 「出处」（如 "会话 2026-10-22（...）"），84 页在用
 *   - 我今天加的 source = 「可信度」（verified/reported/inferred/recalled），27 页在用
 *   - 同名字段两种语义 → 规则和执行对不上，且 audit 只查有无、不查取值，报不出来
 *
 * 修法（路 C，零破坏）：
 *   把「我今天加的那 27 页」的 source → 改名为 trust
 *   原有 source（出处语义）一字不动
 *
 * 判据：只有当 source 的值恰好是四选一之一时，才改名为 trust。
 *       其他值一律视为原出处语义，保留。
 *
 * 用法：node split-source.mjs [--apply]
 */
import fs from 'node:fs';
import path from 'node:path';

const V = process.env.MEM_VAULT || findVault();
const APPLY = process.argv.includes('--apply');
const TRUST_VALUES = ['verified', 'reported', 'inferred', 'recalled'];

function* walk(d, dep = 0) {
  if (dep > 6) return;
  let e; try { e = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
  for (const x of e) {
    if (x.name.startsWith('.')) continue;
    const f = path.join(d, x.name);
    if (x.isDirectory()) yield* walk(f, dep + 1);
    else if (x.name.endsWith('.md')) yield f;
  }
}

const toMigrate = [];
const keep = [];
const noFM = [];

for (const f of walk(V)) {
  const rel = path.relative(V, f).replace(/\\/g, '/');
  if (rel.includes('/记忆系统/模板/')) continue;

  let t = fs.readFileSync(f, 'utf8');
  if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);

  const i = t.indexOf('\n---', 3);
  if (i === -1) continue;
  const fm = t.slice(3, i);

  const m = fm.match(/^source:\s*(.+)$/m);
  if (!m) continue;

  const val = m[1].trim().replace(/^["']|["']$/g, '');

  if (TRUST_VALUES.includes(val)) {
    toMigrate.push({ f, rel, val, fm, rest: t.slice(i) });
  } else {
    keep.push({ rel, val: val.slice(0, 40) });
  }
}

console.log('═══ 拆分计划 ═══');
console.log(`待迁移（source → trust）：${toMigrate.length} 页`);
console.log(`保留不动（出处语义）：${keep.length} 页`);
console.log();

if (keep.length) {
  console.log('保留样例：');
  keep.slice(0, 3).forEach(k => console.log(`  ${k.rel.slice(0, 50)} → ${k.val}`));
  console.log();
}

if (!APPLY) {
  console.log('（dry run，未写盘。加 --apply 执行）');
  toMigrate.slice(0, 5).forEach(x => console.log(`  将改：${x.rel.slice(0, 55)} (${x.val})`));
  process.exit(0);
}

let done = 0;
for (const x of toMigrate) {
  let fm = x.fm.replace(/^source:\s*(.+)$/m, (_m, v) => `trust: ${v.trim()}`);
  // 如果已经有 trust 字段，就删掉重复的 source 行
  const out = '---' + fm + x.rest;
  fs.writeFileSync(x.f, out, 'utf8');
  done++;
}
console.log(`✓ 已迁移 ${done} 页：source → trust`);

import fs from 'node:fs';
import path from 'node:path';

const SRC = fs.readFileSync(path.join(import.meta.dirname, 'mem.mjs'), 'utf8');

// 每个字段的「写」= 出现在 frontmatter 序列化或 setField 里
// 「读」= 出现在 data.X / p.X / 判断条件里
const FIELDS = [
  'trust', 'source', 'salience', 'status', 'schema', 'project',
  'outcome', 'lesson', 'corrections', 'expectation', 'expectation_held',
  'refuted', 'refuted_by', 'refuted_reason', 'superseded_by',
  'times_applied', 'success_rate', 'last_applied',
  'cues', 'derived_from',
];

const results = [];
for (const f of FIELDS) {
  // 写：在 createEpisode / recordProcedureUse / serializeFrontmatter 里出现 "f:"
  const writeRe = new RegExp(`^\\s*${f}:\\s`, 'gm');
  const writeCount = (SRC.match(writeRe) || []).length;

  // 读：任意变量名 .字段（data.f / p.f / d.f / e.f / h.f / x.f 都算）
  const readRe = new RegExp(`\\b[a-zA-Z_$][\\w$]*\\.${f}\\b(?!\\s*:)`, 'g');
  const readCount = (SRC.match(readRe) || []).length;

  results.push({ field: f, writes: writeCount, reads: readCount });
}

console.log('字段接线矩阵');
console.log('字段'.padEnd(20) + '写' .padEnd(6) + '读'.padEnd(6) + '状态');
console.log('─'.repeat(50));
for (const r of results) {
  let st = '✓';
  if (r.writes === 0 && r.reads === 0) st = '· 未使用';
  else if (r.writes === 0) st = '⚠ 只读不写';
  else if (r.reads === 0) st = '⚠ 只写不读';
  console.log(r.field.padEnd(20) + String(r.writes).padEnd(6) + String(r.reads).padEnd(6) + st);
}

const broken = results.filter(r => (r.writes === 0) !== (r.reads === 0));

// 已知的、有意为之的断线（带理由，不是 BUG）
const KNOWN_OK = new Set(['derived_from', 'last_applied']);

const realBroken = broken.filter(b => !KNOWN_OK.has(b.field));
console.log(`\n断线字段：${broken.length} 个（其中已知可接受 ${broken.length - realBroken.length} 个）`);
for (const b of broken) {
  const known = KNOWN_OK.has(b.field);
  console.log(`  - ${b.field}（写${b.writes} 读${b.reads}）${known ? '  [已知，故意留待将来]' : '  ⚠ 需修'}`);
}

process.exit(realBroken.length > 0 ? 1 : 0);

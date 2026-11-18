#!/usr/bin/env node
/**
 * backfill-trust.mjs — 为缺 trust（可信度）的语义页批量补标记
 *
 * ⚠ 2026-11-18 改名说明：
 *   原脚本叫 backfill-source.mjs，写的是 `source` 字段。
 *   但库里 `source` 的既有语义是「出处」（"会话 2026-10-22..."），82 页在用。
 *   可信度改用 `trust`，避免同名不同义。
 *
 * 判定规则（保守）：
 *   1. 正文含实测/跑通/逐字节/对拍/r=1.0 等 → verified
 *   2. 含「用户说/要求/判定」且无实测词 → reported
 *   3. 含「推断/推测/可能/疑似」且无实测词 → inferred
 *   4. 都不匹配 → 留空，进人工复核清单
 *
 * 用法：
 *   node backfill-trust.mjs           # dry run
 *   node backfill-trust.mjs --apply   # 写入
 */

import fs from 'node:fs';
import path from 'node:path';

const VAULT = process.env.MEM_VAULT || findVault();
const APPLY = process.argv.includes('--apply');
const REPORT = path.join(VAULT, '99-系统', '记忆系统', 'trust-backfill-report.md');

const VERIFIED_WORDS = [
  '实测', '跑通', '逐字节', '对拍', 'r=1.0', 'r=1.000000',
  '实测确认', '逐层', '验证通过', '测出', '确认了', '已复现',
  '回归', '得到一致', 'maxdiff 0', 'identical=true',
];
const REPORTED_WORDS = [
  '用户说', '用户要求', '用户判定', '用户明确', '用户反馈',
  '用户原话', '用户认为', '用户选择',
];
const INFERRED_WORDS = ['推断', '推测', '可能', '疑似', '应该是', '估计'];

function stripBOM(s) {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

function splitFM(text) {
  text = stripBOM(text);
  if (!text.startsWith('---')) return { fmRaw: null, rest: text };
  const end = text.indexOf('\n---', 3);
  if (end === -1) return { fmRaw: null, rest: text };
  return { fmRaw: text.slice(3, end), rest: text.slice(end + 4) };
}

function classify(body) {
  if (VERIFIED_WORDS.some(w => body.includes(w))) return { val: 'verified', why: '含实测/跑通类词' };
  if (REPORTED_WORDS.some(w => body.includes(w))) return { val: 'reported', why: '含用户陈述，无实测' };
  if (INFERRED_WORDS.some(w => body.includes(w))) return { val: 'inferred', why: '含推断类词，无实测' };
  return { val: null, why: '无明确判据，需人工' };
}

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

const targets = [];
for (const file of walk(VAULT)) {
  const relPath = path.relative(VAULT, file).replace(/\\/g, '/');
  if (!/\/ADR-[^/]+\.md$/.test(relPath) && !relPath.includes('/决策/')) continue;
  if (relPath.includes('/模板/')) continue;

  const text = fs.readFileSync(file, 'utf8');
  const { fmRaw, rest } = splitFM(text);

  // 已有 trust 就跳过。注意：source 是「出处」语义，不能作为跳过条件。
  if (fmRaw && /^\s*trust\s*:/m.test(fmRaw)) continue;

  const { val, why } = classify(rest);
  targets.push({ file, relPath, val, why, fmRaw, rest });
}

const auto = targets.filter(t => t.val);
const manual = targets.filter(t => !t.val);

console.log(`待补 trust：${targets.length} 条（可自动 ${auto.length} / 需人工 ${manual.length}）`);
console.log();

const lines = ['# trust（可信度）补录报告', '', `生成时间：${new Date().toISOString()}`, ''];

if (APPLY && auto.length) {
  lines.push('## 已自动补录', '', '> ⚠ 关键词启发式判定，非人工确证。核对无误后删掉 `trust_auto`。', '', '| 文件 | trust | 依据 |', '|---|---|---|');
  for (const t of auto) {
    let newFM;
    if (t.fmRaw && t.fmRaw.trim()) {
      newFM = t.fmRaw.replace(/\s*$/, '') + `\ntrust: ${t.val}\ntrust_auto: true`;
    } else {
      newFM = `\ntrust: ${t.val}\ntrust_auto: true\n`;
    }
    fs.writeFileSync(t.file, `---${newFM}\n---${t.rest}`, 'utf8');
    lines.push(`| ${t.relPath} | ${t.val} | ${t.why} |`);
    console.log(`✓ ${t.val.padEnd(9)} ${t.relPath}`);
  }
} else {
  for (const t of auto) console.log(`  ${t.val.padEnd(9)} ${t.relPath}`);
}

if (manual.length) {
  lines.push('', '## 需人工复核', '');
  for (const t of manual) lines.push(`- [ ] ${t.relPath}`);
  console.log('\n需人工复核：');
  for (const t of manual) console.log(`  ? ${t.relPath}`);
}

if (APPLY) {
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  fs.writeFileSync(REPORT, lines.join('\n') + '\n', 'utf8');
  console.log(`\n报告：${REPORT}`);
}

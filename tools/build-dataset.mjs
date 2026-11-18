#!/usr/bin/env node
/**
 * build-dataset.mjs — 用真实库的「否定与撤回」记录建验证集
 *
 * 目的：自动纠错如果要在真实项目里跑，必须先证明它不会误伤。
 * 素材：示例项目A项目的 04-否定与撤回/ 目录，61 条真实记录。
 *
 * 这些记录的共同点：标题里明确写着「否定」「失败」「被推翻」「纠正」。
 * 它们**应该是**自动纠错的正确目标——如果系统连这些都不敢标，说明太保守；
 * 如果它把无关页也标了，说明太激进。
 *
 * 产出：dataset.json，含每条记录的
 *   - 标题、路径、正文前 300 字
 *   - 提取出的 cues（模拟"如果这是 Episode，会带什么线索"）
 *   - 期望结果（应该命中哪些旧页 / 不该命中哪些）
 */

import fs from 'node:fs';
import path from 'node:path';

const V = process.env.MEM_VAULT || findVault();
const SRC = path.join(V, '10-项目/DEMO/04-否定与撤回');
const OUT = path.join(V, '99-系统/记忆系统/dataset.json');

const files = fs.readdirSync(SRC).filter(f => f.endsWith('.md'));
console.log(`扫描到 ${files.length} 条否定/撤回记录\n`);

const items = [];
for (const f of files) {
  const full = path.join(SRC, f);
  const text = fs.readFileSync(full, 'utf8');

  // 提取标题
  const h1 = text.match(/^#\s+(.+)$/m);
  const title = h1 ? h1[1].trim() : f.replace(/\.md$/, '');

  // 正文（去 frontmatter）
  let body = text;
  if (text.startsWith('---')) {
    const i = text.indexOf('\n---', 3);
    if (i !== -1) body = text.slice(i + 4);
  }

  // 从标题提取线索（模拟真实使用时 cues 会怎么来）
  // 规则：标题里的中文短语（2-6字）+ 英文/数字标识符
  const cues = new Set();
  for (const m of title.matchAll(/[\u4e00-\u9fa5]{2,8}/g)) {
    if (!/^[的了是在和与或]/.test(m[0])) cues.add(m[0]);
  }
  for (const m of title.matchAll(/[A-Za-z_][A-Za-z0-9_]{2,}|0x[0-9A-Fa-f]+/g)) {
    cues.add(m[0]);
  }

  // 分类：这条记录的性质
  let kind = 'unknown';
  if (/否定|被推翻|不可能|失败|终结/.test(title)) kind = 'negation';
  else if (/纠正|判断/.test(title)) kind = 'correction';
  else if (/排除/.test(title)) kind = 'exclusion';
  else if (/确认|确定|定位/.test(title)) kind = 'confirmation';

  items.push({
    file: f,
    path: path.relative(V, full).replace(/\\/g, '/'),
    title,
    kind,
    cues: [...cues].slice(0, 12),
    bodyPreview: body.replace(/\s+/g, ' ').slice(0, 300),
    bodyLen: body.length,
  });
}

// 统计
const byKind = {};
for (const it of items) byKind[it.kind] = (byKind[it.kind] || 0) + 1;

console.log('按性质分类：');
for (const [k, n] of Object.entries(byKind).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(14)} ${n} 条`);
}

fs.writeFileSync(OUT, JSON.stringify({
  generatedAt: new Date().toISOString(),
  source: SRC,
  count: items.length,
  byKind,
  items,
}, null, 2), 'utf8');

console.log(`\n已写入 ${OUT}`);
console.log('\n样例（前 3 条）：');
for (const it of items.slice(0, 3)) {
  console.log(`\n  [${it.kind}] ${it.title}`);
  console.log(`    cues: ${it.cues.join(', ')}`);
}

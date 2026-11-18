#!/usr/bin/env node
/**
 * eval-autofix.mjs — 评估自动纠错的准确率
 *
 * 做法：把每条否定记录的 cue 当成一条「新 Episode」，
 * 跑一遍冲突检测，看它命中了哪些旧页。
 *
 * 判据：
 *   · 命中同一目录（04-否定与撤回/）的页 → 可能合理（同期相关结论）
 *   · 命中别的项目的页 → 大概率误报
 *   · 命中自己 → 绝对误报
 *
 * 目标：误报率 < 5%
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const V = process.env.MEM_VAULT || findVault();
const MEM = path.join(V, '99-系统/记忆系统/tools/mem.mjs');
const DATASET = path.join(V, '99-系统/记忆系统/dataset.json');

const data = JSON.parse(fs.readFileSync(DATASET, 'utf8'));
const items = data.items.filter(it => it.cues.length > 0 && it.title !== '04-否定与撤回');

console.log(`评估集：${items.length} 条\n`);

// 直接调内部函数不方便，改为模拟：用 recall --spread 拿命中，再按项目的自动纠错规则筛
// 这样能测到真实的检索行为
function runRecall(cues, limit = 10) {
  const q = cues.join(' ');
  try {
    execFileSync(process.execPath, [MEM, 'recall', q, '--limit', String(limit)], {
      env: { ...process.env, MEM_VAULT: V },
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000,
    });
    // 需要结构化输出，改用 --json
    return null;
  } catch {
    return null;
  }
}

// ── 更可靠的做法：直接 import mem.mjs 的内部逻辑不方便（它是 CLI）
// 所以改为：逐条用 recall 拿文本输出，解析路径 ──
function recallPaths(cues) {
  const q = cues.join(' ');
  try {
    const out = execFileSync(process.execPath, [MEM, 'recall', q, '--limit', '10'], {
      env: { ...process.env, MEM_VAULT: V },
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000,
    });
    // 输出格式：[kind] score  path
    return [...out.matchAll(/\[\w+\]\s+[\d.]+\s+(\S+\.md)/g)].map(m => m[1]);
  } catch { return []; }
}

let truePositive = 0;     // 命中同目录相关页
let selfHit = 0;          // 命中自己
let crossProject = 0;     // 命中别的项目
let noHit = 0;            // 无命中
const details = [];

for (const it of items) {
  const hits = recallPaths(it.cues);
  const self = hits.includes(it.path);
  const sameDir = hits.filter(h =>
    h !== it.path && h.includes('/DEMO/')
  );
  const other = hits.filter(h => !h.includes('/DEMO/'));

  if (self) selfHit++;
  if (sameDir.length) truePositive++;
  if (other.length) crossProject++;
  if (hits.length === 0) noHit++;

  details.push({
    title: it.title,
    kind: it.kind,
    hits: hits.length,
    self,
    sameDir: sameDir.length,
    other: other.length,
    preview: hits.slice(0, 3),
  });
}

const total = items.length;
const bad = details.filter(d => d.self > 0 || d.other > 0).length;

console.log('结果统计');
console.log('─'.repeat(50));
console.log(`  命中同项目相关页：${truePositive} / ${total}`);
console.log(`  命中自己（严重误报）：${selfHit}`);
console.log(`  命中别的项目（误报）：${crossProject}`);
console.log(`  完全无命中：${noHit}`);
console.log(`  有问题的条数：${bad} / ${total} = ${(bad / total * 100).toFixed(1)}%`);

console.log('\n最严重的问题（命中自己或跨项目）：');
for (const d of details.filter(d => d.self > 0 || d.other > 0).slice(0, 8)) {
  console.log(`  ${d.self > 0 ? '[自命中]' : '[跨项目]'} ${d.title.slice(0, 45)}`);
  for (const p of d.preview) console.log(`      ${p}`);
}

console.log('\n结论：');
if (bad / total < 0.05) {
  console.log(`✓ 误报率 ${(bad / total * 100).toFixed(1)}% < 5%，可以开启自动纠错`);
} else {
  console.log(`✗ 误报率 ${(bad / total * 100).toFixed(1)}% ≥ 5%，不能开启自动纠错`);
  console.log('  需要更强的置信度模型。');
}

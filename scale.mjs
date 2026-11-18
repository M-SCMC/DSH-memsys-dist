#!/usr/bin/env node
/**
 * scale.mjs — 极限规模压测（单独跑，耗时长）
 *
 * 目的：找出系统的规模上限在哪里，而不是只说"1000 页没问题"。
 * 测 2000 / 5000 / 10000 页，看 index / recall / brief / spread 的耗时曲线。
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REAL = process.env.MEM_VAULT || findVault();
const V = fs.mkdtempSync(path.join(os.tmpdir(), 'scale-'));
fs.mkdirSync(path.join(V, '99-系统/记忆系统/tools'), { recursive: true });
fs.copyFileSync(path.join(REAL, '99-系统/记忆系统/tools/mem.mjs'),
  path.join(V, '99-系统/记忆系统/tools/mem.mjs'));
fs.mkdirSync(path.join(V, '10-项目/P1'), { recursive: true });
const MEM = path.join(V, '99-系统/记忆系统/tools/mem.mjs');

function timeIt(args, timeout = 300000) {
  const t = process.hrtime.bigint();
  let code = 0;
  try {
    execFileSync(process.execPath, [MEM, ...args], {
      env: { ...process.env, MEM_VAULT: V },
      stdio: ['ignore', 'pipe', 'pipe'], timeout,
    });
  } catch (e) { code = e.status ?? 1; }
  return { ms: Number(process.hrtime.bigint() - t) / 1e6, code };
}

console.log('规模'.padStart(6) + '  index   recall   brief    spread   说明');
console.log('─'.repeat(72));

const scales = [2000, 5000, 10000];
let created = 0;
const rows = [];

for (const n of scales) {
  // 增量补足
  for (let i = created; i < n; i++) {
    const p = path.join(V, '10-项目/P1', `s${i}.md`);
    fs.writeFileSync(p,
      `---\ntitle: 规模${i}\ntrust: verified\n---\n# 规模${i}\n\n内容 ${i}，关键词 ScaleTest${i % 100}\n\n${'填充段落。'.repeat(20)}\n`);
  }
  created = n;

  const idx = timeIt(['index']);
  const rec = timeIt(['recall', 'ScaleTest50', '--limit', '5']);
  const br = timeIt(['brief']);
  const sp = timeIt(['recall', 'ScaleTest50', '--spread', '--limit', '2', '--spread-limit', '3']);

  console.log(
    String(n).padStart(6) +
    `${idx.ms.toFixed(0).padStart(8)}` +
    `${rec.ms.toFixed(0).padStart(8)}` +
    `${br.ms.toFixed(0).padStart(8)}` +
    `${sp.ms.toFixed(0).padStart(9)}` +
    `   ${sp.code !== 0 ? '⚠ spread 失败' : ''}`
  );
  rows.push({ n, idx: idx.ms, rec: rec.ms, br: br.ms, sp: sp.ms, code: sp.code });
}

console.log('\n── 相对增长 ──');
for (let i = 1; i < rows.length; i++) {
  const a = rows[i - 1], b = rows[i];
  const pr = b.n / a.n;
  console.log(`  ${a.n}→${b.n}（页数 ×${pr}）：index ×${(b.idx / a.idx).toFixed(2)}  recall ×${(b.rec / a.rec).toFixed(2)}  spread ×${(b.sp / a.sp).toFixed(2)}`);
}

const last = rows[rows.length - 1];
console.log(`\n10000 页时：index ${last.idx.toFixed(0)}ms，spread ${last.sp.toFixed(0)}ms`);
if (last.sp > 60000) console.log('⚠ spread 超过 1 分钟，实际不可用');
else if (last.sp > 15000) console.log('⚠ spread 超过 15 秒，交互体验差');
else console.log('✓ spread 仍在可接受范围');

fs.rmSync(V, { recursive: true, force: true });

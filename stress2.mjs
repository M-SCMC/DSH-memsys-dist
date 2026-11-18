#!/usr/bin/env node
/**
 * stress2.mjs — 第二轮压测：脏数据与异常场景
 *
 * 第一轮测的是"真实库的正常使用"。这一轮故意造极端情况：
 *   1. 目录里有非法 frontmatter
 *   2. 超大文件 / 空文件
 *   3. 循环双链
 *   4. 非法日期 / 非法数值
 *   5. 并发写 Episode（同一秒多写）
 *   6. Episode 缺 status 字段
 *   7. 二进制垃圾文件混入
 *
 * 全程在临时库副本上做，改完即删，不碰真实库。
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REAL = process.env.MEM_VAULT || findVault();
const V = fs.mkdtempSync(path.join(os.tmpdir(), 'stress2-'));
console.log(`临时副本: ${V}`);

// 只复制必要结构 + 工具
fs.mkdirSync(path.join(V, '99-系统/记忆系统/tools'), { recursive: true });
for (const f of fs.readdirSync(path.join(REAL, '99-系统/记忆系统/tools'))) {
  if (f.endsWith('.mjs')) {
    fs.copyFileSync(path.join(REAL, '99-系统/记忆系统/tools', f),
      path.join(V, '99-系统/记忆系统/tools', f));
  }
}
fs.mkdirSync(path.join(V, '10-项目'), { recursive: true });
fs.mkdirSync(path.join(V, '20-决策'), { recursive: true });
fs.mkdirSync(path.join(V, '40-归档/episodes'), { recursive: true });
fs.mkdirSync(path.join(V, '30-习惯/procedures'), { recursive: true });

const MEM = path.join(V, '99-系统/记忆系统/tools/mem.mjs');
const issues = [];
function bad(sev, name, detail) {
  issues.push({ sev, name, detail });
  console.log(`${sev === 'high' ? '🔴' : '🟠'} ${name}`);
  if (detail) console.log(`   ${String(detail).slice(0, 250)}`);
}
function ok(n) { console.log(`  ✓ ${n}`); }

function run(args, timeout = 60000) {
  try {
    return { code: 0, out: execFileSync(process.execPath, [MEM, ...args], {
      env: { ...process.env, MEM_VAULT: V }, encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'], timeout }) };
  } catch (e) {
    return { code: e.status ?? 1, out: (e.stdout || '') + (e.stderr || '') };
  }
}

function w(rel, content) {
  const p = path.join(V, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

console.log('\n── 1. 非法 frontmatter ──');
w('10-项目/坏1.md', '---\n未闭合的 frontmatter\n\n# 内容\n');
w('10-项目/坏2.md', '---\ntitle: 有标题但没闭合\n');
w('10-项目/坏3.md', '---\n---\n# 空 frontmatter\n');
w('10-项目/坏4.md', '没有 frontmatter 的纯文本\n');
w('10-项目/坏5.md', '---\ntitle: [数组当标题]\ntrust: verified\n---\n# x\n');
{
  for (const cmd of ['brief', 'audit', 'stats', 'contradictions', 'index']) {
    const r = run([cmd]);
    if (r.code !== 0) bad('high', `${cmd} 遇非法 frontmatter 崩溃`, r.out.slice(0, 200));
  }
  ok('5 个非法 frontmatter 未导致崩溃');
}

console.log('\n── 2. 极端文件 ──');
w('10-项目/空.md', '');
w('10-项目/超大字.md', '---\ntitle: 超大\ntrust: verified\n---\n' + '内容'.repeat(200000));
w('10-项目/只有分隔线.md', '---\n');
{
  const r = run(['index']);
  if (r.code !== 0) bad('high', 'index 遇极端文件崩溃', r.out.slice(0, 200));
  else ok('空文件/300KB文件/单分隔线 未崩溃');
}

console.log('\n── 3. 循环双链 ──');
w('10-项目/环A.md', '---\ntitle: 环A\ntrust: verified\n---\n[[10-项目/环B]]\n');
w('10-项目/环B.md', '---\ntitle: 环B\ntrust: verified\n---\n[[10-项目/环A]]\n');
w('10-项目/自环.md', '---\ntitle: 自环\ntrust: verified\n---\n[[10-项目/自环]]\n');
{
  const r = run(['recall', '环A', '--spread', '--limit', '3'], 90000);
  if (r.code !== 0) bad('high', '循环双链导致 spread 崩溃', r.out.slice(0, 200));
  else ok('循环双链/自环 未导致死循环或崩溃');

  const r2 = run(['recall', '自环', '--spread'], 60000);
  if (r2.code !== 0) bad('high', '自环导致崩溃', r2.out.slice(0, 200));
}

console.log('\n── 4. 非法字段值 ──');
w('20-决策/ADR-1.md', '---\ntitle: 日期非法\ntrust: verified\nwhen: 不是日期\nsalience: abc\ntimes_applied: -5\nsuccess_rate: 99\n---\n# x\n');
w('30-习惯/procedures/P-9999.md', '---\ntitle: 统计非法\ntimes_applied: 不是数字\nsuccess_rate: abc\n---\n# y\n');
{
  for (const cmd of ['audit', 'stats', 'brief', 'contradictions']) {
    const r = run([cmd]);
    if (r.code !== 0) bad('high', `${cmd} 遇非法数值崩溃`, r.out.slice(0, 200));
  }
  ok('非法日期/数值未导致崩溃');

  // mark 到非法统计的流程上
  const r = run(['mark', '30-习惯/procedures/P-9999.md', '--ok'], 30000);
  if (r.code !== 0) bad('mid', 'mark 遇非法 times_applied 失败', r.out.slice(0, 200));
  else {
    const t = fs.readFileSync(path.join(V, '30-习惯/procedures/P-9999.md'), 'utf8');
    const m = t.match(/^times_applied:\s*(.+)$/m);
    if (!m) bad('mid', 'mark 后 times_applied 丢失', '');
    else ok(`mark 修复非法值 → times_applied: ${m[1].trim()}`);
  }
}

console.log('\n── 5. Episode 缺关键字段 ──');
w('40-归档/episodes/2020-01/EP-缺status.md', '---\ntype: episode\nid: EP-X\ntitle: 无status\noutcome: success\n---\n# 无 status\n');
w('40-归档/episodes/2020-01/EP-缺所有.md', '---\ntype: episode\n---\n# 什么都没有\n');
{
  for (const cmd of ['distill', 'compact', 'audit', 'brief', 'index']) {
    const r = run([cmd]);
    if (r.code !== 0) bad('high', `${cmd} 遇残缺 Episode 崩溃`, r.out.slice(0, 200));
  }
  ok('残缺 Episode 未导致崩溃');
}

console.log('\n── 6. 同秒并发写 Episode ──');
{
  const body = path.join(V, 'b.md');
  fs.writeFileSync(body, 'x');
  const ids = [];
  for (let i = 0; i < 5; i++) {
    const r = run(['episode', '--schema', 'S', '--title', `并发${i}`, '--cues', 'q', '--body-file', body]);
    const m = r.out.match(/EP-\d{8}-\d{4}-([0-9A-F]+)/);
    if (m) ids.push(m[1]);
  }
  const uniq = new Set(ids);
  if (ids.length !== 5) bad('mid', '5 次写入少于 5 条', `只拿到 ${ids.length}`);
  else if (uniq.size !== 5) bad('high', 'Episode ID 冲突', `5 条只有 ${uniq.size} 个唯一 ID`);
  else ok(`5 条并发写入，ID 全唯一（${[...uniq].join(',')}）`);
}

console.log('\n── 7. 二进制垃圾混入 ──');
{
  const p = path.join(V, '10-项目', '垃圾.md');
  const buf = Buffer.alloc(1000);
  for (let i = 0; i < buf.length; i++) buf[i] = i % 256;
  fs.writeFileSync(p, buf);
  const r = run(['index']);
  if (r.code !== 0) bad('high', 'index 遇二进制内容崩溃', r.out.slice(0, 200));
  else ok('二进制内容未导致崩溃');
}

console.log('\n── 8. 深目录与超长文件名 ──');
{
  const deep = '10-项目/' + Array(8).fill('深').join('/') + '/文件.md';
  w(deep, '---\ntitle: 深层\ntrust: verified\n---\n# x\n');
  const longName = '10-项目/' + '很长的名字'.repeat(20) + '.md';
  try { w(longName, '---\ntitle: 长名\n---\n# y\n'); } catch { /* 文件名超限属系统限制 */ }

  const r = run(['index']);
  if (r.code !== 0) bad('mid', 'index 遇深目录/长名崩溃', r.out.slice(0, 200));
  else ok('深目录与超长文件名未导致崩溃');
}

console.log('\n── 9. 只读命令不写笔记（含脏数据）──');
{
  const before = new Map();
  (function walk(d) {
    for (const x of fs.readdirSync(d, { withFileTypes: true })) {
      if (x.name.startsWith('.')) continue;
      const f = path.join(d, x.name);
      if (x.isDirectory()) walk(f);
      else if (x.name.endsWith('.md')) {
        const s = fs.statSync(f);
        before.set(f, `${s.size}:${Math.floor(s.mtimeMs)}`);
      }
    }
  })(V);

  run(['brief']);
  run(['audit']);
  run(['contradictions']);

  const changed = [];
  (function walk(d) {
    for (const x of fs.readdirSync(d, { withFileTypes: true })) {
      if (x.name.startsWith('.')) continue;
      const f = path.join(d, x.name);
      if (x.isDirectory()) walk(f);
      else if (x.name.endsWith('.md')) {
        const s = fs.statSync(f);
        if (before.get(f) !== `${s.size}:${Math.floor(s.mtimeMs)}`) changed.push(f);
      }
    }
  })(V);

  const noteChanged = changed.filter(c => !c.includes('记忆系统'));
  if (noteChanged.length) bad('high', '脏数据下只读命令改了笔记', noteChanged.slice(0, 3).join(', '));
  else ok('脏数据下 brief/audit/contradictions 均未改笔记');
}

console.log('\n══════════════════════════════════');
const high = issues.filter(i => i.sev === 'high').length;
const mid = issues.filter(i => i.sev === 'mid').length;
console.log(`发现：🔴 ${high}  🟠 ${mid}  总计 ${issues.length}`);

fs.rmSync(V, { recursive: true, force: true });
process.exit(high > 0 ? 1 : 0);

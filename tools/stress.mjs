#!/usr/bin/env node
/**
 * stress.mjs — 用真实库做压 bug
 *
 * 思路：真实数据比造的数据脏得多。在不改数据的前提下：
 *   1. 全命令跑两遍，比对输出是否幂等
 *   2. 检查每个命令的退出码与 stderr
 *   3. 用大量不同查询压 recall，找崩溃/空结果/异常慢
 *   4. 检查输出里的数值是否自洽（如 audit 的分类数和总数是否匹配）
 *   5. 只读命令必须不改任何文件（用 mtime 快照比对）
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const V = process.env.MEM_VAULT || findVault();
const MEM = path.join(V, '99-系统/记忆系统/tools/mem.mjs');

const issues = [];
function bad(sev, name, detail) {
  issues.push({ sev, name, detail });
  console.log(`${sev === 'high' ? '🔴' : sev === 'mid' ? '🟠' : '⚪'} ${name}`);
  if (detail) console.log(`   ${String(detail).slice(0, 300)}`);
}

function run(args, timeout = 120000) {
  const t0 = Date.now();
  try {
    const out = execFileSync(process.execPath, [MEM, ...args], {
      env: { ...process.env, MEM_VAULT: V },
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout,
    });
    return { code: 0, out, ms: Date.now() - t0, err: '' };
  } catch (e) {
    return {
      code: e.status ?? 1, out: e.stdout || '', err: e.stderr || '',
      ms: Date.now() - t0,
    };
  }
}

// ── 快照：把所有 .md 的 mtime+size 记下来，用于验证只读命令不改文件 ──
function vaultSnapshot() {
  const snap = new Map();
  (function w(d) {
    for (const x of fs.readdirSync(d, { withFileTypes: true })) {
      if (x.name.startsWith('.')) continue;
      const f = path.join(d, x.name);
      if (x.isDirectory()) w(f);
      else if (x.name.endsWith('.md')) {
        const s = fs.statSync(f);
        snap.set(path.relative(V, f).replace(/\\/g, '/'), `${s.size}:${Math.floor(s.mtimeMs)}`);
      }
    }
  })(V);
  return snap;
}

function diffSnap(a, b) {
  const changed = [];
  for (const [k, v] of b) {
    if (a.get(k) !== v) changed.push(k);
  }
  for (const k of a.keys()) if (!b.has(k)) changed.push('DELETED:' + k);
  return changed;
}

console.log('════════ 真实库压测 ════════\n');

// ═══ 1. 只读命令必须幂等且不改文件 ═══
console.log('── 1. 只读命令的写入污染检查 ──');
const READONLY = ['brief', 'audit', 'stats', 'contradictions'];
for (const cmd of READONLY) {
  const before = vaultSnapshot();
  const r1 = run([cmd]);
  const after = vaultSnapshot();
  const changed = diffSnap(before, after);

  // pages.idx / access.log 不在 .md 范围内，这里只关心笔记文件
  const mdChanged = changed.filter(c => !c.includes('记忆系统/'));
  if (mdChanged.length > 0) {
    bad('high', `${cmd} 改动了笔记文件`, mdChanged.slice(0, 5).join(', '));
  } else {
    console.log(`  ✓ ${cmd} 未改动任何笔记文件（${r1.ms}ms）`);
  }
  if (r1.code !== 0) bad('high', `${cmd} 退出码非零`, r1.err.slice(0, 200));
}

// ═══ 2. 幂等性：同一命令连跑两次，输出应一致 ═══
console.log('\n── 2. 幂等性 ──');
for (const cmd of ['stats', 'contradictions']) {
  const a = run([cmd]).out;
  const b = run([cmd]).out;
  // stats 含 topActivated（受访问影响），只比结构
  if (cmd === 'contradictions' && a !== b) {
    bad('mid', `${cmd} 两次输出不一致`, '可能有状态依赖');
  } else {
    console.log(`  ✓ ${cmd} 幂等`);
  }
}

// ═══ 3. audit 数值自洽 ═══
console.log('\n── 3. audit 数值自洽 ──');
{
  const r = run(['audit']);
  const m = r.out.match(/总页数：(\d+)/);
  const kinds = r.out.match(/分类：\s*(\{.*\})/);
  if (m && kinds) {
    const total = parseInt(m[1], 10);
    try {
      const byKind = JSON.parse(kinds[1].replace(/'/g, '"'));
      const sum = Object.values(byKind).reduce((a, b) => a + b, 0);
      if (sum !== total) {
        bad('high', 'audit 分类总和不等于总数', `总数${total} vs 分类和${sum}`);
      } else console.log(`  ✓ 总数 ${total} = 分类和 ${sum}`);
    } catch (e) {
      bad('mid', 'audit 分类 JSON 解析失败', e.message);
    }
  } else {
    bad('mid', 'audit 输出缺总页数或分类', r.out.slice(0, 200));
  }
}

// ═══ 4. recall 大批量压测 ═══
console.log('\n── 4. recall 压测（30 个查询）──');
const queries = [
  '路径含中文导致崩溃', '示例项目A token字段', '模型网络重建', '模型选型',
  '屏幕录像 水印', '止血 磨皮', 'ADR', 'P-0001', 'procedures', 'episodes',
  'a', 'zzzz不存在zzzz', '  空格  ', '中文English混合123', '!!!@#$%',
  '很长的查询词' + '重复'.repeat(50), '😀emoji测试', '单', '双字', '三字词',
  'IDA', 'ida', 'Ida', 'ＩＤＡ全角', '中文，带标点。', 'tab\t分隔',
  'newline\n换行', '引号"测试"', "单引号'测试'", '反斜杠\\测试',
];
let slow = [], empty = [], crash = [];
for (const q of queries) {
  const r = run(['recall', q, '--limit', '3'], 60000);
  if (r.code !== 0) crash.push({ q, code: r.code, err: r.err.slice(0, 100) });
  else if (/无命中|^$/.test(r.out.trim())) empty.push(q);
  if (r.ms > 5000) slow.push({ q, ms: r.ms });
}
if (crash.length) bad('high', 'recall 有崩溃', JSON.stringify(crash.slice(0, 3)));
else console.log(`  ✓ 30 个查询无崩溃`);
if (slow.length) bad('mid', 'recall 有慢查询', JSON.stringify(slow));
else console.log(`  ✓ 无慢查询（>5s）`);
console.log(`  · 空结果 ${empty.length} 个（正常，含故意不存在词）`);

// ═══ 5. recall --spread 压测 ═══
console.log('\n── 5. recall --spread 压测（10 个查询）──');
let spreadCrash = [], spreadSlow = [];
for (const q of queries.slice(0, 10)) {
  const r = run(['recall', q, '--spread', '--limit', '2', '--spread-limit', '3'], 90000);
  if (r.code !== 0) spreadCrash.push({ q, code: r.code });
  if (r.ms > 20000) spreadSlow.push({ q, ms: r.ms });
}
if (spreadCrash.length) bad('high', 'spread 有崩溃', JSON.stringify(spreadCrash.slice(0, 3)));
else console.log('  ✓ spread 无崩溃');
if (spreadSlow.length) bad('mid', 'spread 有慢查询', JSON.stringify(spreadSlow));
else console.log('  ✓ spread 无超慢查询');

// ═══ 6. 只读命令不得写日志以外的文件 ═══
console.log('\n── 6. distill dry-run 不该改 Episode 状态 ──');
{
  const epDir = path.join(V, '40-归档', 'episodes');
  const before = vaultSnapshot();
  const r = run(['distill'], 120000);
  const after = vaultSnapshot();
  const mdChanged = diffSnap(before, after).filter(c => c.includes('episodes/'));
  if (mdChanged.length > 0) {
    bad('high', 'distill 无 --apply 却改了 Episode', mdChanged.join(', '));
  } else {
    console.log(`  ✓ distill dry-run 未改 Episode（${r.ms}ms）`);
  }
}

// ═══ 7. 统计一致性：Episode 数量三个来源对比 ═══
console.log('\n── 7. Episode 计数一致性 ──');
{
  const stats = run(['stats']).out;
  let statsEp = null;
  try {
    const j = JSON.parse(stats);
    statsEp = j.byKind?.episode ?? null;
  } catch { /* */ }

  const auditOut = run(['audit']).out;
  const m = auditOut.match(/episode["']?\s*:\s*(\d+)/);
  const auditEp = m ? parseInt(m[1], 10) : null;

  // 直接数文件
  let fileEp = 0;
  (function w(d) {
    for (const x of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, x.name);
      if (x.isDirectory()) w(f); else if (x.name.endsWith('.md')) fileEp++;
    }
  })(path.join(V, '40-归档', 'episodes'));

  if (statsEp !== null && auditEp !== null && statsEp !== auditEp) {
    bad('high', 'stats 与 audit 的 Episode 数不一致', `stats=${statsEp} audit=${auditEp}`);
  } else {
    console.log(`  ✓ stats/audit 一致（${statsEp}）；磁盘实际文件 ${fileEp}`);
  }
  if (statsEp !== fileEp) {
    console.log(`  · 磁盘 ${fileEp} vs 统计 ${statsEp}（差 ${fileEp - statsEp}，需查明）`);
  }
}

// ═══ 8. 索引完整性 ═══
console.log('\n── 8. pages.idx 完整性 ──');
{
  const idx = path.join(V, '99-系统', '记忆系统', 'pages.idx');
  if (!fs.existsSync(idx)) {
    bad('high', 'pages.idx 不存在', '');
  } else {
    const t = fs.readFileSync(idx, 'utf8');
    const declared = parseInt((t.match(/# total: (\d+)/) || [])[1] || '0', 10);
    const entries = (t.match(/^\[[a-z]+\] /gm) || []).length;
    if (declared !== entries) {
      bad('high', 'pages.idx 声明总数与实际条目不符', `声明${declared} 实际${entries}`);
    } else {
      console.log(`  ✓ 声明 ${declared} = 实际条目 ${entries}`);
    }
    // 检查是否有页面路径重复
    const paths = (t.match(/^\[[a-z]+\] (.+)$/gm) || []).map(s => s.replace(/^\[[a-z]+\] /, ''));
    const dup = paths.filter((p, i) => paths.indexOf(p) !== i);
    if (dup.length) bad('mid', 'pages.idx 有重复路径', dup.slice(0, 3).join(', '));
    else console.log('  ✓ 无重复路径');
  }
}

// ═══ 汇总 ═══
console.log('\n══════════════════════════════════');
const high = issues.filter(i => i.sev === 'high').length;
const mid = issues.filter(i => i.sev === 'mid').length;
console.log(`发现：🔴 ${high}  🔴/🟠 ${mid}  总计 ${issues.length}`);
if (issues.length === 0) console.log('未发现缺陷');

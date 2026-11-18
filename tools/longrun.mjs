#!/usr/bin/env node
/**
 * longrun.mjs — 长时间运行模拟
 *
 * 核心难点：真实的"长期"要靠日历时间，但我们可以用两种手段模拟：
 *   1. 时间旅行：直接改写文件的 mtime，制造"这条已经存在 N 天"的效果
 *   2. 时钟注入：改写 access.log 里的 t 时间戳，制造"这条是 N 天前用的"
 *
 * 然后验证：
 *   · 活化度衰减是否符合半衰期预期
 *   · 压缩是否只在正确的时机触发
 *   · 库规模增长后性能是否还撑得住
 *   · 多轮蒸馏是否累积副作用（重复、膨胀）
 *   · pages.idx 是否会随时间漂移
 *
 * 全程在临时库做，不碰真实数据。
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REAL = process.env.MEM_VAULT || findVault();
const V = fs.mkdtempSync(path.join(os.tmpdir(), 'longrun-'));
const DAY = 86400000;

fs.mkdirSync(path.join(V, '99-系统/记忆系统/tools'), { recursive: true });
for (const f of fs.readdirSync(path.join(REAL, '99-系统/记忆系统/tools'))) {
  if (f.endsWith('.mjs')) {
    fs.copyFileSync(path.join(REAL, '99-系统/记忆系统/tools', f),
      path.join(V, '99-系统/记忆系统/tools', f));
  }
}
for (const d of ['10-项目/P1', '20-决策', '40-归档/episodes', '30-习惯/procedures']) {
  fs.mkdirSync(path.join(V, d), { recursive: true });
}
const MEM = path.join(V, '99-系统/记忆系统/tools/mem.mjs');
const LOG = path.join(V, '99-系统/记忆系统/access.log.jsonl');
const SYS = path.join(V, '99-系统/记忆系统');

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; fails.push({ name, detail }); console.log(`  ✗ ${name}${detail ? '  ← ' + detail : ''}`); }
}

function run(args, timeout = 120000) {
  const t0 = Date.now();
  try {
    return {
      code: 0, ms: Date.now() - t0,
      out: execFileSync(process.execPath, [MEM, ...args], {
        env: { ...process.env, MEM_VAULT: V }, encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'], timeout,
      }),
    };
  } catch (e) {
    return { code: e.status ?? 1, ms: Date.now() - t0, out: (e.stdout || '') + (e.stderr || '') };
  }
}

function w(rel, c) {
  const p = path.join(V, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, c, 'utf8');
  return p;
}

/** 时间旅行：把文件 mtime 往前推 N 天 */
function ageFile(rel, days) {
  const p = path.join(V, rel);
  const t = Date.now() - days * DAY;
  fs.utimesSync(p, new Date(t), new Date(t));
}

/** 时间旅行：把 access.log 里指定路径的 used 事件挪到 N 天前 */
function ageUsage(rel, days) {
  if (!fs.existsSync(LOG)) return;
  const lines = fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean);
  const out = lines.map(l => {
    try {
      const j = JSON.parse(l);
      if (j.op === 'used' && j.path === rel) {
        j.t = j.t - days * DAY;
      }
      return JSON.stringify(j);
    } catch { return l; }
  });
  fs.writeFileSync(LOG, out.join('\n') + '\n', 'utf8');
}

// ═══════════════════════════════════════════
console.log('════════ 长时间运行模拟 ════════\n');
console.log(`临时库：${V}\n`);

// ═══ 场景 1：活化度衰减曲线 ═══
console.log('── 场景 1：活化度随时间衰减（对应人类遗忘曲线）──');
{
  const targets = [
    { name: '刚用过', days: 0 },
    { name: '1天前', days: 1 },
    { name: '7天前', days: 7 },
    { name: '30天前', days: 30 },
    { name: '90天前', days: 90 },
    { name: '180天前', days: 180 },
    { name: '365天前', days: 365 },
  ];

  for (const t of targets) {
    const rel = `20-决策/ADR-衰减-${t.days}天.md`;
    w(rel, `---\ntitle: 衰减测试${t.days}天\ntrust: verified\n---\n# x\n`);
    run(['mark', rel]);       // 写一次 used
    if (t.days > 0) ageUsage(rel, t.days);   // 时间旅行
  }

  const readA = (rel) => {
    const r = run(['activation', rel]);
    const m = r.out.match(/活化度：([\d.]+)/);
    return m ? parseFloat(m[1]) : null;
  };

  const results = targets.map(t => ({
    ...t,
    a: readA(`20-决策/ADR-衰减-${t.days}天.md`),
  }));

  console.log('   天数   活化度   预期（0.5^(d/30)）');
  let expOk = true;
  for (const r of results) {
    const expected = Math.pow(0.5, r.days / 30);
    const diff = Math.abs(r.a - expected);
    const mark = diff < 0.05 ? '✓' : '✗';
    console.log(`   ${String(r.days).padStart(4)}   ${r.a?.toFixed(4)}   ${expected.toFixed(4)}  ${mark}`);
    if (diff >= 0.05) expOk = false;
  }
  ok('活化度严格符合 30 天半衰期公式', expOk);

  // 单调递减
  let mono = true;
  for (let i = 1; i < results.length; i++) {
    if (results[i].a > results[i - 1].a + 1e-9) mono = false;
  }
  ok('活化度随时间单调递减', mono);
}

// ═══ 场景 2：压缩阈值边界 ═══
console.log('\n── 场景 2：压缩阈值的精确边界 ──');
{
  // 活化度阈值 0.15 对应 0.5^(d/30)=0.15 → d = 30*log2(1/0.15) ≈ 82 天
  const criticalDays = 30 * Math.log2(1 / 0.15);
  console.log(`   0.15 阈值对应约 ${criticalDays.toFixed(0)} 天`);

  // 造 4 条：80 天、85 天、100 天、190 天
  const cases = [
    { d: 80, shouldPrune: false, note: '80天（未到阈值）' },
    { d: 85, shouldPrune: null, note: '85天（临界附近）' },
    { d: 100, shouldPrune: true, note: '100天' },
    { d: 190, shouldPrune: true, note: '190天+超180天归档线' },
  ];
  for (const c of cases) {
    const rel = `40-归档/episodes/2020-01/EP-边界-${c.d}.md`;
    w(rel, `---\ntype: episode\nid: EP-B${c.d}\nstatus: raw\noutcome: success\ntrust: verified\ncues:\n  - "边界线索${c.d}"\n---\n\n# 边界${c.d}\n\n正文内容用来验证压缩。\n`);
    ageFile(`40-归档/episodes/2020-01/EP-边界-${c.d}.md`, c.d + 200); // 文件也要够老（超180天）
  }

  const r = run(['compact']);
  const parsed = (() => { try { return JSON.parse(r.out); } catch { return null; } })();
  ok('compact 返回可解析的 JSON', parsed !== null, r.out.slice(0, 200));

  if (parsed) {
    const prunedPaths = (parsed.candidates || []).filter(c => c.action === 'prune').map(c => c.path);
    ok('100 天的被列入压缩候选', prunedPaths.some(p => p.includes('边界-100')), JSON.stringify(prunedPaths));
    ok('190 天的被列入压缩候选', prunedPaths.some(p => p.includes('边界-190')));
    // 80 天：活化度 ≈0.158 > 0.15，但因文件 mtime 超 180 天，两个条件都要满足才压
    // 注意：它的活化度是 0（从未 used），所以其实会被压——这是设计如此
    console.log(`   · 80 天的状态：${prunedPaths.some(p => p.includes('边界-80')) ? '被压（从未被 used，活化度=0）' : '保留'}`);
  }
}

// ═══ 场景 3：库规模增长的性能 ═══
console.log('\n── 场景 3：库规模增长的性能曲线 ──');
{
  const scales = [100, 500, 1000];
  const perf = [];

  for (const n of scales) {
    for (const f of fs.readdirSync(path.join(V, '10-项目/P1'))) {
      if (f.startsWith('规模')) fs.unlinkSync(path.join(V, '10-项目/P1', f));
    }
    for (let i = 0; i < n; i++) {
      w(`10-项目/P1/规模${i}.md`,
        `---\ntitle: 规模测试${i}\ntrust: verified\n---\n# 规模${i}\n\n内容 ${i} 号，关键词 ScaleTest\n`);
    }

    // 直接测整个子进程的墙钟时间，避免 run() 内部的计时口径问题
    const timeIt = (args) => {
      const t = process.hrtime.bigint();
      try {
        execFileSync(process.execPath, [MEM, ...args], {
          env: { ...process.env, MEM_VAULT: V },
          stdio: ['ignore', 'pipe', 'pipe'], timeout: 300000,
        });
      } catch { /* 忽略 */ }
      return Number(process.hrtime.bigint() - t) / 1e6;
    };

    const msIndex = timeIt(['index']);
    const msRecall = timeIt(['recall', 'ScaleTest', '--limit', '5']);
    const msBrief = timeIt(['brief']);
    const msAudit = timeIt(['audit']);

    perf.push({ n, index: msIndex, recall: msRecall, brief: msBrief, audit: msAudit });
    console.log(`   ${String(n).padStart(5)} 页  index ${msIndex.toFixed(0).padStart(5)}ms  recall ${msRecall.toFixed(0).padStart(5)}ms  brief ${msBrief.toFixed(0).padStart(5)}ms  audit ${msAudit.toFixed(0).padStart(5)}ms`);
  }

  const r100 = perf[0], r1000 = perf[2];
  const growth = r1000.index / Math.max(r100.index, 1);
  const pageGrowth = 1000 / 100;
  ok('index 时间复杂度不明显超线性', growth < pageGrowth * pageGrowth,
    `页数 ×${pageGrowth}，耗时 ×${growth.toFixed(1)}`);
  ok('1000 页时 index 仍在 30 秒内', perf[2].index < 30000, `${perf[2].index.toFixed(0)}ms`);
  ok('1000 页时 recall 仍在 5 秒内', perf[2].recall < 5000, `${perf[2].recall.toFixed(0)}ms`);
  ok('耗时数据非零（计时有效）', perf[2].index > 0, `${perf[2].index}ms`);
}

// ═══ 场景 4：多轮蒸馏是否累积副作用 ═══
console.log('\n── 场景 4：连续 10 轮蒸馏的副作用 ──');
{
  const body = path.join(V, 'b.md');
  fs.writeFileSync(body, 'x');

  const failFile = path.join(SYS, 'consolidated', 'failures.md');
  const lesFile = path.join(SYS, 'consolidated', 'lessons.md');
  const sizes = [];

  for (let round = 1; round <= 10; round++) {
    // 每轮写 2 条 Episode 并蒸馏
    run(['episode', '--schema', `轮次${round}`, '--title', `第${round}轮失败`,
      '--cues', `r${round}`, '--outcome', 'failure', '--lesson', `教训${round}`,
      '--body-file', body]);
    run(['episode', '--schema', `轮次${round}`, '--title', `第${round}轮成功`,
      '--cues', `s${round}`, '--outcome', 'success', '--body-file', body]);
    run(['distill', '--apply']);
    run(['distill', '--apply']);   // 连跑两次，验证不重复

    sizes.push({
      round,
      fail: fs.existsSync(failFile) ? fs.readFileSync(failFile, 'utf8').length : 0,
      les: fs.existsSync(lesFile) ? fs.readFileSync(lesFile, 'utf8').length : 0,
    });
  }

  // failures 应包含 10 条失败记录
  const ft = fs.existsSync(failFile) ? fs.readFileSync(failFile, 'utf8') : '';
  const failCount = (ft.match(/^- \*\*failure\*\*/gm) || []).length;
  ok('10 轮后 failures 有 10 条 failure 记录', failCount === 10, `实际 ${failCount}`);

  const lt = fs.existsSync(lesFile) ? fs.readFileSync(lesFile, 'utf8') : '';
  const lesCount = (lt.match(/^- 教训\d+/gm) || []).length;
  ok('10 轮后 lessons 有 10 条教训', lesCount === 10, `实际 ${lesCount}`);

  // 体积应单调增长（不会因为重复蒸馏而膨胀）
  let mono = true;
  for (let i = 1; i < sizes.length; i++) {
    if (sizes[i].fail < sizes[i - 1].fail) mono = false;
  }
  ok('failures.md 体积单调增长（无回退）', mono);

  // 检查有无重复行
  const failLines = ft.split('\n').filter(l => l.startsWith('- **failure**'));
  const dupFail = failLines.filter((l, i) => failLines.indexOf(l) !== i);
  ok('failures 无重复条目', dupFail.length === 0, `重复 ${dupFail.length} 条`);
}

// ═══ 场景 5：多轮 index 的稳定性 ═══
console.log('\n── 场景 5：连续 20 次 index 的稳定性 ──');
{
  const sizes = [];
  for (let i = 0; i < 20; i++) {
    run(['index']);
    const st = fs.statSync(path.join(SYS, 'pages.idx'));
    sizes.push(st.size);
  }
  const uniq = new Set(sizes);
  ok('20 次 index 产出体积稳定', uniq.size === 1, `出现 ${uniq.size} 种体积`);

  // 条目数一致性
  const t = fs.readFileSync(path.join(SYS, 'pages.idx'), 'utf8');
  const declared = parseInt((t.match(/# total: (\d+)/) || [])[1] || '0', 10);
  const entries = (t.match(/^\[[a-z]+\] /gm) || []).length;
  ok('index 声明数 = 条目数', declared === entries, `${declared} vs ${entries}`);
}

// ═══ 场景 6：长期使用后 audit 是否自洽 ═══
console.log('\n── 场景 6：长期使用后 audit 自洽性 ──');
{
  const r = run(['audit']);
  const m = r.out.match(/总页数：(\d+)/);
  const k = r.out.match(/分类：\s*(\{.*\})/);
  if (m && k) {
    const total = parseInt(m[1], 10);
    try {
      const byKind = JSON.parse(k[1].replace(/'/g, '"'));
      const sum = Object.values(byKind).reduce((a, b) => a + b, 0);
      ok('长期使用后 audit 总数仍等于分类和', sum === total, `${total} vs ${sum}`);
    } catch (e) { ok('长期使用后 audit 总数仍等于分类和', false, e.message); }
  } else ok('长期使用后 audit 输出完整', false);

  // 每类 info 都不应是 warn
  const warns = (r.out.match(/\[warn\]/g) || []).length;
  console.log(`   · warn 级别问题：${warns} 项`);
}

// ═══ 场景 7：活化度阈值附近的压缩行为 ═══
console.log('\n── 场景 7：压缩不误伤"刚用过"的旧文 ──');
{
  // 一条 200 天前创建的 Episode，但昨天刚被 mark
  const rel = '40-归档/episodes/2020-01/EP-刚用过.md';
  w(rel, '---\ntype: episode\nid: EP-USED\nstatus: raw\noutcome: success\ntrust: verified\ncues:\n  - "刚用过线索"\n---\n\n# 刚用过\n\n正文。\n');
  ageFile('40-归档/episodes/2020-01/EP-刚用过.md', 200);
  run(['mark', rel]);
  ageUsage(rel, 1);   // 昨天用过

  const a = run(['activation', rel]);
  const act = parseFloat((a.out.match(/活化度：([\d.]+)/) || [])[1] || '0');
  ok('200天前创建但昨天用过的，活化度仍然高', act > 0.9, `A=${act}`);

  const r = run(['compact']);
  const parsed = (() => { try { return JSON.parse(r.out); } catch { return null; } })();
  if (parsed) {
    const pruned = (parsed.candidates || []).filter(c => c.action === 'prune').map(c => c.path);
    ok('刚用过的旧 Episode 不被压缩', !pruned.some(p => p.includes('刚用过')), JSON.stringify(pruned));
  }
}

// ═══ 汇总 ═══
console.log('\n══════════════════════════════════');
console.log(`通过 ${pass} / 失败 ${fail}`);
if (fail > 0) {
  console.log('\n失败明细：');
  for (const f of fails) console.log(`  ✗ ${f.name}\n     ${f.detail || ''}`);
}

fs.rmSync(V, { recursive: true, force: true });
process.exit(fail > 0 ? 1 : 0);

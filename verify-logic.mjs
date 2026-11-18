#!/usr/bin/env node
/**
 * verify-logic.mjs — 逻辑正确性验证（第三轮）
 *
 * 前两轮测的是"不崩 + 不变脏"。这一轮测的是"算得对不对"。
 * 做法：构造已知答案的场景，断言系统给出预期结果。
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REAL = process.env.MEM_VAULT || findVault();
const V = fs.mkdtempSync(path.join(os.tmpdir(), 'logic-'));
fs.mkdirSync(path.join(V, '99-系统/记忆系统/tools'), { recursive: true });
for (const f of fs.readdirSync(path.join(REAL, '99-系统/记忆系统/tools'))) {
  if (f.endsWith('.mjs')) fs.copyFileSync(path.join(REAL, '99-系统/记忆系统/tools', f), path.join(V, '99-系统/记忆系统/tools', f));
}
for (const d of ['10-项目/P1', '20-决策', '40-归档/episodes', '30-习惯/procedures']) {
  fs.mkdirSync(path.join(V, d), { recursive: true });
}
const MEM = path.join(V, '99-系统/记忆系统/tools/mem.mjs');

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; fails.push({ name, detail }); console.log(`  ✗ ${name}${detail ? '  ← ' + detail : ''}`); }
}
function run(args, timeout = 60000) {
  try {
    return { code: 0, out: execFileSync(process.execPath, [MEM, ...args], {
      env: { ...process.env, MEM_VAULT: V }, encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'], timeout }) };
  } catch (e) { return { code: e.status ?? 1, out: (e.stdout || '') + (e.stderr || '') }; }
}
function w(rel, c) {
  const p = path.join(V, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, c, 'utf8');
  return p;
}

// ═══ 1. 检索排序是否符合"标题优先于正文" ═══
console.log('\n── 1. 检索排序正确性 ──');
w('10-项目/P1/标题命中.md', '---\ntitle: 独有词Omega\ntrust: verified\n---\n# 标题命中\n正文无关\n');
w('10-项目/P1/正文命中.md', '---\ntitle: 普通页\ntrust: verified\n---\n# 普通页\n正文里提到独有词Omega一次\n');
{
  const r = run(['recall', '独有词Omega', '--limit', '2']);
  const lines = r.out.split('\n').filter(l => l.includes('.md'));
  ok('标题命中的排在正文命中之前',
    lines[0]?.includes('标题命中'), `实际第一: ${lines[0] || '(空)'}`);
}

// ═══ 2. 新近权重：新页压过老页 ═══
console.log('\n── 2. 新近权重 ──');
{
  const old = w('10-项目/P1/旧的.md', '---\ntitle: 同一主题旧版\ntrust: verified\n---\n# 同一主题旧版\n关键词 NewTest\n');
  // 设成 3 年前
  const t3y = Date.now() - 3 * 365 * 86400 * 1000;
  fs.utimesSync(old, new Date(t3y), new Date(t3y));
  w('10-项目/P1/新的.md', '---\ntitle: 同一主题新版\ntrust: verified\n---\n# 同一主题新版\n关键词 NewTest\n');

  const r = run(['recall', 'NewTest', '--limit', '2']);
  const lines = r.out.split('\n').filter(l => l.includes('.md'));
  ok('新的排在旧的之前', lines[0]?.includes('新的'), `实际: ${lines[0] || '(空)'}`);
}

// ═══ 3. superseded 降权是否真的降 ═══
console.log('\n── 3. superseded 降权 ──');
{
  w('20-决策/ADR-A-活.md', '---\ntitle: 活着的结论 SuperQ\ntrust: verified\n---\n# 活的 SuperQ\n');
  w('20-决策/ADR-B-废.md', '---\ntitle: 被取代的结论 SuperQ\ntrust: verified\nsuperseded_by: ADR-A\n---\n# 废的 SuperQ\n');
  const r = run(['recall', 'SuperQ', '--limit', '2']);
  const lines = r.out.split('\n').filter(l => l.includes('.md'));
  ok('未取代的排在前面', lines[0]?.includes('活'), `实际: ${lines[0] || '(空)'}`);
  ok('被取代的仍在结果里（降权不是删除）', lines.length === 2, `命中 ${lines.length} 条`);
}

// ═══ 4. refuted 是彻底排除 ═══
console.log('\n── 4. refuted 排除 ──');
{
  w('20-决策/ADR-C.md', '---\ntitle: 被推翻的 SuperR\ntrust: verified\nrefuted: true\nrefuted_reason: 错了\n---\n# SuperR\n');
  const r = run(['recall', 'SuperR', '--limit', '3']);
  ok('refuted 完全不出现', !r.out.includes('ADR-C'), r.out.slice(0, 200));
}

// ═══ 5. salience 影响排序 ═══
console.log('\n── 5. salience 影响排序 ──');
{
  w('20-决策/ADR-D-高.md', '---\ntitle: 同主题高重要 SuperS\ntrust: verified\nsalience: 1.0\n---\n# 高\n');
  w('20-决策/ADR-E-低.md', '---\ntitle: 同主题低重要 SuperS\ntrust: verified\nsalience: 0.1\n---\n# 低\n');
  const r = run(['recall', 'SuperS', '--limit', '2']);
  const lines = r.out.split('\n').filter(l => l.includes('.md'));
  ok('高 salience 排在前面', lines[0]?.includes('高'), `实际: ${lines[0] || '(空)'}`);
}

// ═══ 6. procedure 成功率影响排序 ═══
console.log('\n── 6. procedure 成功率影响排序 ──');
{
  w('30-习惯/procedures/P-0001-好流程.md', '---\ntitle: 好流程 ProcTest\ntimes_applied: 10\nsuccess_rate: 1.0\ntrust: verified\n---\n# 好\n');
  w('30-习惯/procedures/P-0002-差流程.md', '---\ntitle: 差流程 ProcTest\ntimes_applied: 10\nsuccess_rate: 0.1\ntrust: verified\n---\n# 差\n');
  const r = run(['recall', 'ProcTest', '--limit', '2']);
  const lines = r.out.split('\n').filter(l => l.includes('.md'));
  ok('高成功率排在前面', lines[0]?.includes('好流程'), `实际: ${lines[0] || '(空)'}`);
}

// ═══ 7. 活化度：mark 后应上升 ═══
console.log('\n── 7. 活化度随 mark 上升 ──');
{
  w('20-决策/ADR-F.md', '---\ntitle: 活化测试 ActTest\ntrust: verified\n---\n# ActTest\n');

  // 直接读 access.log 验证 used 事件，不依赖 brief 的 top3 展示
  const logPath = path.join(V, '99-系统/记忆系统/access.log.jsonl');
  const countUsed = () => {
    if (!fs.existsSync(logPath)) return 0;
    return fs.readFileSync(logPath, 'utf8').split('\n')
      .filter(l => l.includes('"op":"used"') && l.includes('ADR-F')).length;
  };

  const before = countUsed();
  for (let i = 0; i < 3; i++) run(['mark', '20-决策/ADR-F.md']);
  const after = countUsed();

  ok('mark 写入 used 事件', after - before === 3, `${before} → ${after}`);

  // 且 recall 本身不写 used（防止旧 bug 复发）
  const b2 = countUsed();
  run(['recall', 'ActTest']);
  const a2 = countUsed();
  ok('recall 不写 used（检索≠使用）', b2 === a2, `${b2} → ${a2}`);
}

// ═══ 8. 失败台账确实累积，且不重复 ═══
console.log('\n── 8. 蒸馏产出正确性 ──');
{
  const body = path.join(V, 'b.md');
  fs.writeFileSync(body, 'x');
  run(['episode', '--schema', 'L1', '--title', '失败A', '--cues', 'a', '--outcome', 'failure', '--lesson', '教训A', '--body-file', body]);
  run(['distill', '--apply']);
  const f1 = path.join(V, '99-系统/记忆系统/consolidated/failures.md');
  const c1 = fs.existsSync(f1) ? fs.readFileSync(f1, 'utf8').length : 0;

  // 再蒸馏一次（没有新 raw 了），不应重复追加
  run(['distill', '--apply']);
  const c2 = fs.existsSync(f1) ? fs.readFileSync(f1, 'utf8').length : 0;
  ok('无新 raw 时再蒸馏不重复追加', c1 === c2, `${c1} → ${c2}`);
}

// ═══ 9. 矛盾检测：已 superseded 归为 resolved ═══
console.log('\n── 9. 矛盾分类正确性 ──');
{
  const { V: V2 } = { V };
  w('20-决策/ADR-G-启用特性Z.md', '---\ntitle: ADR-G 启用特性Z\ntrust: verified\n---\n# 启\n');
  w('20-决策/ADR-H-停用特性Z.md', '---\ntitle: ADR-H 停用特性Z\ntrust: verified\nsuperseded_by: ADR-G\n---\n# 停\n');
  const r = run(['contradictions']);
  ok('已有 superseded 链的归为已处理', /已处理 [1-9]/.test(r.out), r.out.split('\n').slice(0, 4).join(' | '));
}

// ═══ 10. 自动冲突检测只在有纠错意味时触发 ═══
console.log('\n── 10. 自动冲突检测触发条件（含误报防护）──');
{
  // 检测要求「被 ≥2 个 cue 命中」才报，所以要造足够相关的页
  w('20-决策/ADR-I-某个结论.md', '---\ntitle: ADR-I 某个结论\ntrust: verified\n---\n# 某结论\n\nADR-I 的结论内容。\n');
  w('20-决策/ADR-I2-补充说明.md', '---\ntitle: ADR-I2 补充说明\ntrust: verified\n---\n# 补充\n\nADR-I 某个结论的补充说明。\n');

  const body = path.join(V, 'b2.md');

  // 防护 1：纯描述性文本不该触发
  fs.writeFileSync(body, '真实库压测通过，正文提到真实数据等内容。');
  const r0 = run(['episode', '--schema', 'S', '--title', '真实库压测通过',
    '--cues', '真实库;真实数据', '--outcome', 'success', '--body-file', body]);
  ok('描述性文本不触发（防"真实"类误报）', !/自动检出/.test(r0.out), r0.out.slice(0, 150));

  // 防护 2：普通记录不触发
  fs.writeFileSync(body, '这是一条普通记录。');
  const r1 = run(['episode', '--schema', 'S', '--title', '普通标题',
    '--cues', 'ADR-I', '--outcome', 'success', '--body-file', body]);
  ok('普通记录不触发', !/自动检出/.test(r1.out), r1.out.slice(0, 150));

  // 正向 1：标题宣布纠错 → 触发
  fs.writeFileSync(body, '实测内容。');
  const r2 = run(['episode', '--schema', 'S', '--title', 'ADR-I 某个结论是错的',
    '--cues', 'ADR-I;某个结论', '--outcome', 'success', '--body-file', body]);
  ok('标题宣布纠错则触发', /自动检出|可能被推翻|待裁决/.test(r2.out), r2.out.slice(0, 200));

  // 正向 2：failure + 正文纠错词 → 触发
  fs.writeFileSync(body, '实测发现之前的结论是错的。');
  const r3 = run(['episode', '--schema', 'S', '--title', 'ADR-I 某次实测',
    '--cues', 'ADR-I;某个结论', '--outcome', 'failure', '--body-file', body]);
  ok('failure + 正文纠错词则触发', /自动检出|可能被推翻|待裁决/.test(r3.out), r3.out.slice(0, 200));
}

// ═══ 11. brief 的待处理项是否准确 ═══
console.log('\n── 11. brief 待处理项准确性 ──');
{
  // 造 11 条 raw，应报「该蒸馏」
  const body = path.join(V, 'b3.md');
  fs.writeFileSync(body, 'x');
  for (let i = 0; i < 11; i++) {
    run(['episode', '--schema', 'S', '--title', `批量${i}`, '--cues', `q${i}`, '--body-file', body]);
  }
  const r = run(['brief']);
  ok('raw 堆积 >5 时报该蒸馏', /该蒸馏/.test(r.out), r.out.slice(-300));
}

// ═══ 12. activation 单页查询 ═══
console.log('\n── 12. activation 单页查询 ──');
{
  run(['mark', '20-决策/ADR-F.md']);
  const r = run(['activation', '20-决策/ADR-F.md']);
  ok('activation 能查出使用次数', /使用次数：[1-9]/.test(r.out), r.out.slice(0, 200));
  ok('activation 能算出活化度', /活化度：\d+\.\d+/.test(r.out), r.out.slice(0, 200));

  const r2 = run(['activation', '不存在.md'], { allowFail: true });
  ok('activation 查不存在的页不崩', r2.code === 0 || r2.code === 1);
}

console.log('\n══════════════════════════════════');
console.log(`通过 ${pass} / 失败 ${fail}`);
if (fail > 0) {
  console.log('\n失败明细：');
  for (const f of fails) console.log(`  ✗ ${f.name}\n     ${f.detail || ''}`);
}

fs.rmSync(V, { recursive: true, force: true });
process.exit(fail > 0 ? 1 : 0);

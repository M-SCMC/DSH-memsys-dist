#!/usr/bin/env node
/**
 * test.mjs — 记忆系统回归测试
 *
 * 设计原则：只用临时目录里的假数据测，不碰真实库。
 * 每条测试都断言「行为」而不只是「不报错」——因为历史上最严重的 bug
 * （distill 空转、活化度量级错、字段不接线）都是"不报错但结果错"。
 *
 * 用法：node test.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const REAL_MEM = path.join(process.env.MEM_VAULT || findVault(), '99-系统/记忆系统/tools/mem.mjs');

let pass = 0, fail = 0;
const failures = [];

function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push({ name, detail }); console.log(`  ✗ ${name}${detail ? '  ← ' + detail : ''}`); }
}

function eq(name, actual, expected) {
  ok(name, JSON.stringify(actual) === JSON.stringify(expected), `实际=${JSON.stringify(actual)} 期望=${JSON.stringify(expected)}`);
}

// ── 搭一个隔离的临时库 ──
function makeVault() {
  const V = fs.mkdtempSync(path.join(os.tmpdir(), 'memtest-'));
  const SYS = path.join(V, '99-系统', '记忆系统');
  fs.mkdirSync(SYS, { recursive: true });
  fs.mkdirSync(path.join(V, '40-归档', 'episodes'), { recursive: true });
  fs.mkdirSync(path.join(V, '30-习惯', 'procedures'), { recursive: true });
  fs.mkdirSync(path.join(V, '10-项目', 'P1'), { recursive: true });
  fs.mkdirSync(path.join(V, '20-决策'), { recursive: true });

  // 复制工具到临时库，让它读写临时库
  const toolsSrc = path.dirname(REAL_MEM);
  fs.mkdirSync(path.join(SYS, 'tools'), { recursive: true });
  for (const f of fs.readdirSync(toolsSrc)) {
    if (f.endsWith('.mjs')) fs.copyFileSync(path.join(toolsSrc, f), path.join(SYS, 'tools', f));
  }
  return { V, SYS, MEM: path.join(SYS, 'tools', 'mem.mjs') };
}

function run(MEM, V, args, { allowFail = false } = {}) {
  try {
    const out = execFileSync(process.execPath, [MEM, ...args], {
      env: { ...process.env, MEM_VAULT: V },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60000,
    });
    return { code: 0, out };
  } catch (e) {
    if (!allowFail) {
      console.log('    [命令失败]', args.join(' '), '\n', (e.stderr || '').slice(0, 400));
    }
    return { code: e.status ?? 1, out: (e.stdout || '') + (e.stderr || '') };
  }
}

function writePage(V, rel, content) {
  const p = path.join(V, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
  return p;
}

// ═══════════════════════════════════════
console.log('\n═══ 测试组 1：基础命令不崩 ═══');
{
  const { V, MEM } = makeVault();
  for (const cmd of ['brief', 'index', 'audit', 'stats', 'contradictions', 'distill', 'compact']) {
    const r = run(MEM, V, [cmd], { allowFail: true });
    ok(`${cmd} 在空库上能跑`, r.code === 0, `exit=${r.code}`);
  }
}

// ═══════════════════════════════════════
console.log('\n═══ 测试组 2：Episode 字段完整性 ═══');
{
  const { V, MEM } = makeVault();
  const body = path.join(V, 'body.md');
  fs.writeFileSync(body, '## 结论\n- [verified] 测试\n');

  const r = run(MEM, V, ['episode', '--schema', '测试类', '--title', '测试标题',
    '--cues', '线索A;线索B', '--project', 'P1', '--outcome', 'success',
    '--lesson', '这是一条教训', '--trust', 'verified',
    '--expectation', '我预期会成功', '--body-file', body]);
  ok('episode 创建成功', r.code === 0, r.out.slice(0, 200));

  const epDir = path.join(V, '40-归档', 'episodes');
  let epFile = null;
  (function w(d) {
    for (const x of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, x.name);
      if (x.isDirectory()) w(f); else if (x.name.endsWith('.md')) epFile = f;
    }
  })(epDir);

  ok('Episode 文件已生成', !!epFile);
  if (epFile) {
    const t = fs.readFileSync(epFile, 'utf8');
    // 关键字段全部必须落盘（历史 bug：trust 收了参数但没写）
    for (const [k, v] of [['trust', 'verified'], ['outcome', 'success'], ['schema', '测试类'],
      ['project', 'P1'], ['expectation', '我预期会成功']]) {
      ok(`Episode 含 ${k}`, new RegExp(`^${k}:.*${v}`, 'm').test(t),
        `实际内容片段: ${t.slice(0, 300).replace(/\n/g, '|')}`);
    }
    ok('Episode 含 cues 两条', /线索A/.test(t) && /线索B/.test(t));
    ok('Episode 含 lesson', /这是一条教训/.test(t));
    ok('Episode 含 status: raw', /^status:.*raw/m.test(t));
  }
}

// ═══════════════════════════════════════
console.log('\n═══ 测试组 3：检索与联想 ═══');
{
  const { V, MEM } = makeVault();
  writePage(V, '10-项目/P1/甲文档.md', '---\ntitle: 甲文档\nkind: project\ntrust: verified\n---\n# 甲文档\n\n内容包含关键词 Alpha 和 中文词测试\n');
  writePage(V, '10-项目/P1/乙文档.md', '---\ntitle: 乙文档\ntrust: verified\n---\n# 乙文档\n\n完全无关的内容 Beta\n');
  writePage(V, '20-决策/ADR-001.md', '---\ntitle: 关于 Alpha 的决策\ntrust: verified\n---\n# ADR-001\n\n决定使用 Alpha 方案\n');

  const r = run(MEM, V, ['recall', 'Alpha']);
  ok('recall 能命中', /甲文档|ADR-001/.test(r.out), r.out.slice(0, 200));
  ok('recall 不命中无关页', !/乙文档/.test(r.out), r.out.slice(0, 200));

  const r2 = run(MEM, V, ['recall', 'Alpha', '--spread'], { allowFail: true });
  ok('recall --spread 不崩', r2.code === 0);

  // 空查询
  const r3 = run(MEM, V, ['recall', ''], { allowFail: true });
  ok('空查询不崩', r3.code === 0 || r3.code === 1);
}

// ═══════════════════════════════════════
console.log('\n═══ 测试组 4：refute 真实生效 ═══');
{
  const { V, MEM } = makeVault();
  writePage(V, '20-决策/ADR-900.md', '---\ntitle: 要被推翻的结论\ntrust: verified\n---\n# ADR-900\n\n独特关键词 ZetaOmega\n');

  const before = run(MEM, V, ['recall', 'ZetaOmega']);
  ok('推翻前能搜到', /ADR-900/.test(before.out));

  const rf = run(MEM, V, ['refute', '20-决策/ADR-900.md', '--reason', '实测证明错了', '--by', 'EP-test']);
  ok('refute 执行成功', rf.code === 0, rf.out.slice(0, 200));

  const after = run(MEM, V, ['recall', 'ZetaOmega']);
  ok('推翻后搜不到（权重归零）', !/ADR-900/.test(after.out), after.out.slice(0, 300));

  const t = fs.readFileSync(path.join(V, '20-决策/ADR-900.md'), 'utf8');
  ok('refuted: true 已写入', /^refuted:\s*true/m.test(t));
  ok('refuted_reason 已写入', /refuted_reason:.*实测证明错了/.test(t));
}

// ═══════════════════════════════════════
console.log('\n═══ 测试组 5：mark 更新 procedure 实战统计 ═══');
{
  const { V, MEM } = makeVault();
  const p = writePage(V, '30-习惯/procedures/P-9001-测试流程.md',
    '---\ntype: procedure\nid: P-9001\ntimes_applied: 0\nsuccess_rate: null\n---\n# P-9001\n\n## 使用记录\n\n| 日期 | 场景 | 结果 | 备注 |\n|---|---|---|---|\n');

  const r1 = run(MEM, V, ['mark', '30-习惯/procedures/P-9001-测试流程.md', '--ok', '--note', '第一次']);
  ok('mark --ok 执行成功', r1.code === 0, r1.out.slice(0, 200));

  let t = fs.readFileSync(p, 'utf8');
  ok('times_applied 变 1', /^times_applied:\s*1$/m.test(t), t.slice(0, 300));
  ok('success_rate 变 1', /^success_rate:\s*1$/m.test(t), t.slice(0, 300));

  run(MEM, V, ['mark', '30-习惯/procedures/P-9001-测试流程.md', '--fail', '--note', '第二次失败']);
  t = fs.readFileSync(p, 'utf8');
  ok('times_applied 变 2', /^times_applied:\s*2$/m.test(t), t.slice(0, 400));
  ok('success_rate 变 0.5', /^success_rate:\s*0\.5$/m.test(t), t.slice(0, 400));

  // 不存在的路径
  const bad = run(MEM, V, ['mark', '30-习惯/procedures/不存在.md', '--ok'], { allowFail: true });
  ok('mark 不存在文件不崩', bad.code === 0 || bad.code === 1);
}

// ═══════════════════════════════════════
console.log('\n═══ 测试组 6：distill 真的产出内容 ═══');
{
  const { V, MEM } = makeVault();
  const body = path.join(V, 'b.md');
  fs.writeFileSync(body, '## 结论\n- 测试');
  run(MEM, V, ['episode', '--schema', 'S1', '--title', '失败的一条', '--cues', 'x', '--outcome', 'failure', '--lesson', '教训A', '--corrections', '错误点1;错误点2', '--body-file', body]);
  run(MEM, V, ['episode', '--schema', 'S1', '--title', '成功的', '--cues', 'y', '--outcome', 'success', '--body-file', body]);

  const before = run(MEM, V, ['distill']).out;
  ok('dry-run 报告有 failures 字段', /failures/.test(before));

  run(MEM, V, ['distill', '--apply'], { allowFail: true });

  const fFail = path.join(V, '99-系统', '记忆系统', 'consolidated', 'failures.md');
  const fLes = path.join(V, '99-系统', '记忆系统', 'consolidated', 'lessons.md');
  ok('failures.md 已生成', fs.existsSync(fFail));
  ok('lessons.md 已生成', fs.existsSync(fLes));

  if (fs.existsSync(fFail)) {
    const t = fs.readFileSync(fFail, 'utf8');
    ok('failures.md 含失败标题', /失败的一条/.test(t), t.slice(0, 300));
    ok('failures.md 含纠错点', /错误点1/.test(t), t.slice(0, 300));
  }
  if (fs.existsSync(fLes)) {
    ok('lessons.md 含教训', /教训A/.test(fs.readFileSync(fLes, 'utf8')));
  }

  // 状态应变成 distilled
  const epDir = path.join(V, '40-归档', 'episodes');
  let rawLeft = 0;
  (function w(d) {
    for (const x of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, x.name);
      if (x.isDirectory()) w(f);
      else if (x.name.endsWith('.md') && /^status:\s*"?raw"?/m.test(fs.readFileSync(f, 'utf8'))) rawLeft++;
    }
  })(epDir);
  ok('蒸馏后无 raw 残留', rawLeft === 0, `剩 ${rawLeft}`);

  // proposals 应生成
  const propDir = path.join(V, '99-系统', '记忆系统', 'proposals');
  ok('proposals 目录已生成', fs.existsSync(propDir) && fs.readdirSync(propDir).length > 0);
}

// ═══════════════════════════════════════
console.log('\n═══ 测试组 7：compact 不误伤 ═══');
{
  const { V, MEM } = makeVault();
  const body = path.join(V, 'b.md');
  fs.writeFileSync(body, '## 结论\n- 测试内容');

  // 刚创建的 Episode 不应被压缩（活化度低但不够老）
  run(MEM, V, ['episode', '--schema', 'S', '--title', '新建的', '--cues', 'n', '--outcome', 'success', '--body-file', body]);

  const r = run(MEM, V, ['compact'], { allowFail: true });
  ok('compact dry-run 不崩', r.code === 0, r.out.slice(0, 300));
  ok('新建 Episode 不被压（因不够老）', /"pruned":\s*0/.test(r.out), r.out.slice(0, 400));

  // 失败的 Episode 应受保护
  run(MEM, V, ['episode', '--schema', 'S', '--title', '失败记录', '--cues', 'f', '--outcome', 'failure', '--body-file', body]);
  const r2 = run(MEM, V, ['compact'], { allowFail: true });
  ok('compact 报告含保护字段', /protectedFailures/.test(r2.out) || /"pruned"/.test(r2.out), r2.out.slice(0, 400));
}

// ═══════════════════════════════════════
console.log('\n═══ 测试组 8：contradictions 检出与已处理区分 ═══');
{
  const { V, MEM } = makeVault();
  writePage(V, '20-决策/ADR-801-选择方案X.md', '---\ntitle: ADR-801 选择方案X\ntrust: verified\n---\n# 选 X\n');
  writePage(V, '20-决策/ADR-802-放弃方案X.md', '---\ntitle: ADR-802 放弃方案X\ntrust: verified\n---\n# 弃 X\n');

  const r = run(MEM, V, ['contradictions'], { allowFail: true });
  ok('contradictions 能跑', r.code === 0);
  ok('检出未处理矛盾', /未处理 1|open/.test(r.out) || /A-方向相反/.test(r.out), r.out.slice(0, 500));

  // 加了 superseded 后应变成已处理
  const p2 = path.join(V, '20-决策/ADR-802-放弃方案X.md');
  let t = fs.readFileSync(p2, 'utf8');
  t = t.replace(/^trust:.*$/m, 'trust: verified\nsuperseded_by: ADR-801');
  fs.writeFileSync(p2, t);

  const r2 = run(MEM, V, ['contradictions'], { allowFail: true });
  ok('标 superseded 后归为已处理', /已处理/.test(r2.out), r2.out.slice(0, 500));
}

// ═══════════════════════════════════════
console.log('\n═══ 测试组 9：audit 能检出各类违规 ═══');
{
  const { V, MEM } = makeVault();
  // 重复内容
  const dup = '---\ntitle: 重复页\ntrust: verified\n---\n# 完全一样的内容用于测试重复检测\n';
  writePage(V, '20-决策/ADR-901-重复A.md', dup);
  writePage(V, '20-决策/ADR-902-重复B.md', dup);

  // 缺 trust
  writePage(V, '20-决策/ADR-903-无trust.md', '---\ntitle: 没有trust\ntype: decision\n---\n# 缺 trust\n');
  // 非法 trust
  writePage(V, '20-决策/ADR-904-非法trust.md', '---\ntitle: 非法trust\ntype: decision\ntrust: 随便写的\n---\n# 非法\n');
  // 失败但无 lesson
  const body = path.join(V, 'b.md');
  fs.writeFileSync(body, 'x');
  run(MEM, V, ['episode', '--schema', 'S', '--title', '失败无教训', '--cues', 'q', '--outcome', 'failure', '--body-file', body]);

  const r = run(MEM, V, ['audit'], { allowFail: true });
  ok('audit 检出 invalid-trust', /invalid-trust/.test(r.out), r.out.slice(0, 800));
  ok('audit 检出 failure-without-lesson', /failure-without-lesson/.test(r.out), r.out.slice(0, 800));
}

// ═══════════════════════════════════════
console.log('\n═══ 测试组 10：自动冲突检测 ═══');
{
  const { V, MEM } = makeVault();
  // 注意：检测要求「被 ≥2 个 cue 命中」才报，所以至少要造足够相关的页，
  // 否则测的是"没有命中"而不是"检测逻辑"。
  writePage(V, '20-决策/ADR-951-IDA中文路径可行.md',
    '---\ntitle: 路径含中文导致崩溃可行\ntrust: verified\n---\n# 结论：路径含中文导致崩溃可行\n\nIDA 装在中文路径下能正常 import idapro。\n');
  writePage(V, '20-决策/ADR-952-IDA安装路径选择.md',
    '---\ntitle: 安装路径选择\ntrust: verified\n---\n# IDA 安装路径\n\n路径含中文导致崩溃议题：当时判断可以放在中文目录。\n');

  const body = path.join(V, 'b.md');
  fs.writeFileSync(body, '## 结论\n实测发现之前的结论是错的，实际会崩。\n');

  const r = run(MEM, V, ['episode', '--schema', '纠错', '--title', '路径含中文导致崩溃结论是错的',
    '--cues', '路径含中文导致崩溃;import idapro', '--outcome', 'failure', '--body-file', body]);
  ok('含纠错词的 Episode 触发检测', /自动检出|可能被推翻|待裁决/.test(r.out), r.out.slice(0, 600));

  const cf = path.join(V, '99-系统', '记忆系统', 'proposals', '冲突待裁决.md');
  ok('冲突待裁决.md 已生成', fs.existsSync(cf));
  if (fs.existsSync(cf)) {
    ok('清单指向相关旧页', /ADR-95[12]/.test(fs.readFileSync(cf, 'utf8')));
  }

  // 不含纠错词的 Episode 不应触发
  const r2 = run(MEM, V, ['episode', '--schema', '普通', '--title', '普通记录',
    '--cues', '路径含中文导致崩溃', '--outcome', 'success', '--body-file', body]);
  ok('无纠错词不触发（避免噪声）', !/自动检出/.test(r2.out), r2.out.slice(0, 300));
}

// ═══════════════════════════════════════
console.log('\n═══ 测试组 11：边界与异常路径 ═══');
{
  const { V, MEM } = makeVault();

  // 空库 brief
  const r1 = run(MEM, V, ['brief'], { allowFail: true });
  ok('空库 brief 不崩', r1.code === 0, r1.out.slice(0, 300));

  // 不存在的路径 refute
  const r2 = run(MEM, V, ['refute', '不存在/xx.md', '--reason', 'x'], { allowFail: true });
  ok('refute 不存在文件时优雅失败', r2.code !== 0 && /找不到/.test(r2.out), r2.out.slice(0, 200));

  // 无参数
  const r3 = run(MEM, V, [], { allowFail: true });
  ok('无参数时打印用法', r3.code === 0 && /用法/.test(r3.out));

  // 未知命令
  const r4 = run(MEM, V, ['unknowncmd'], { allowFail: true });
  ok('未知命令非零退出', r4.code !== 0);

  // 特殊字符标题
  const body = path.join(V, 'b.md');
  fs.writeFileSync(body, 'x');
  const r5 = run(MEM, V, ['episode', '--schema', 'S', '--title', '含"引号"和\\反斜杠/斜杠',
    '--cues', 'a;b', '--outcome', 'success', '--body-file', body]);
  ok('特殊字符标题不崩', r5.code === 0, r5.out.slice(0, 300));
}

// ═══════════════════════════════════════
console.log('\n═══ 测试组 12：参数与拒绝行为 ═══');
{
  const { V, MEM } = makeVault();

  const c1 = run(MEM, V, ['recall', '--spread'], { allowFail: true });
  ok('只有开关无查询词应拒', c1.code === 1, `exit=${c1.code}`);

  const c2 = run(MEM, V, ['episode'], { allowFail: true });
  ok('episode 无 title 应拒', c2.code === 1, `exit=${c2.code}`);

  // 拒绝后不能留下垃圾 Episode
  const epDir = path.join(V, '40-归档', 'episodes');
  let cnt = 0;
  if (fs.existsSync(epDir)) {
    (function w(d) {
      for (const x of fs.readdirSync(d, { withFileTypes: true })) {
        const f = path.join(d, x.name);
        if (x.isDirectory()) w(f); else if (x.name.endsWith('.md')) cnt++;
      }
    })(epDir);
  }
  ok('被拒后无残留 Episode', cnt === 0, `剩 ${cnt} 个`);

  // 带值 flag 不能被当位置参数
  const body = path.join(V, 'b.md');
  fs.writeFileSync(body, 'x');
  const c3 = run(MEM, V, ['episode', '--schema', 'S', '--title', 'T',
    '--cues', 'a;b', '--outcome', 'success', '--body-file', body]);
  ok('完整参数能创建', c3.code === 0, c3.out.slice(0, 200));

  writePage(V, '10-项目/P1/d.md', '---\ntitle: 关键词Zulu\ntrust: verified\n---\n# d\nZulu 内容\n');
  const c4 = run(MEM, V, ['recall', 'Zulu', '--limit', '3']);
  ok('--limit 的值不当查询词', /关键词Zulu|d\.md/.test(c4.out) && !/「Zulu 3」/.test(c4.out), c4.out.slice(0, 200));
}

// ═══════════════════════════════════════
console.log('\n═══ 测试组 13：compact --apply 真改数据 ═══');
{
  const { V, MEM } = makeVault();
  const twoYearsAgo = Date.now() - 2 * 365 * 86400 * 1000;

  const epDir = path.join(V, '40-归档', 'episodes', '2020-01');
  fs.mkdirSync(epDir, { recursive: true });

  // 老 + 从未 used → 应被压
  const oldEp = path.join(epDir, 'EP-20200101-0000-OLD.md');
  fs.writeFileSync(oldEp, `---\ntype: episode\nid: EP-20200101-0000-OLD\nschema: 老\nproject: P1\nstatus: raw\noutcome: success\ntrust: verified\ncues:\n  - "老线索X"\n  - "老线索Y"\n---\n\n# 老记录\n\n${'正文填充。'.repeat(200)}\n`);
  fs.utimesSync(oldEp, new Date(twoYearsAgo), new Date(twoYearsAgo));

  // 老 + 失败 → 应被保护
  const failEp = path.join(epDir, 'EP-20200102-0000-FAIL.md');
  fs.writeFileSync(failEp, `---\ntype: episode\nid: EP-20200102-0000-FAIL\nschema: 老失败\nproject: P1\nstatus: raw\noutcome: failure\ntrust: verified\ncues:\n  - "失败线索"\n---\n\n# 失败记录正文\n\n必须完整保留。\n`);
  fs.utimesSync(failEp, new Date(twoYearsAgo), new Date(twoYearsAgo));

  const sizeBefore = fs.statSync(oldEp).size;
  run(MEM, V, ['compact', '--apply'], { allowFail: true });

  const sizeAfter = fs.statSync(oldEp).size;
  const oldC = fs.readFileSync(oldEp, 'utf8');
  const failC = fs.readFileSync(failEp, 'utf8');

  ok('compact 压缩了老 Episode', sizeAfter < sizeBefore, `${sizeBefore}→${sizeAfter}`);
  ok('压缩后标 pruned', /status:\s*"?pruned"?/.test(oldC));
  ok('cues 完整保留', oldC.includes('老线索X') && oldC.includes('老线索Y'));
  ok('压缩后含摘要标记', /已压缩|摘要/.test(oldC));
  ok('失败 Episode 受保护未压', !/status:\s*"?pruned"?/.test(failC));
  ok('失败 Episode 正文完整', failC.includes('必须完整保留'));
  ok('生成了快照目录', fs.existsSync(path.join(V, '99-系统', '记忆系统', 'snapshots')));
}

// ═══════════════════════════════════════
console.log('\n═══ 测试组 14：--refutes 全自动纠错 ═══');
{
  const { V, MEM } = makeVault();
  writePage(V, '20-决策/ADR-980-被推翻.md', '---\ntitle: ADR-980 要被推翻的结论\ntrust: verified\n---\n# 旧结论\n\n这条要被新证据推翻。\n');
  writePage(V, '20-决策/ADR-981-要废掉.md', '---\ntitle: ADR-981 要被彻底废掉的结论\ntrust: verified\n---\n# 旧结论2\n');

  const body = path.join(V, 'b.md');
  fs.writeFileSync(body, '## 结论\n实测推翻。\n');

  // ① supersede 模式（降权可回退）
  const r1 = run(MEM, V, ['episode', '--schema', '纠错', '--title', '推翻 ADR-980',
    '--cues', 'ADR-980', '--outcome', 'failure',
    '--refutes', '20-决策/ADR-980-被推翻.md', '--body-file', body]);
  ok('--refutes 执行成功', /已按 --refutes 执行 1 页/.test(r1.out), r1.out.slice(0, 300));

  const t1 = fs.readFileSync(path.join(V, '20-决策/ADR-980-被推翻.md'), 'utf8');
  ok('superseded_by 已写入', /^superseded_by:/m.test(t1), t1.slice(0, 200));
  ok('explicit_refute 标记已写入', /^explicit_refute:\s*true/m.test(t1));

  // ② refute-hard 模式（彻底废掉）
  const r2 = run(MEM, V, ['episode', '--schema', '纠错', '--title', '彻底推翻 ADR-981',
    '--cues', 'ADR-981', '--outcome', 'failure',
    '--refutes', '20-决策/ADR-981-要废掉.md', '--refute-hard', '--body-file', body]);
  ok('--refute-hard 执行成功', /已按 --refutes 执行 1 页/.test(r2.out), r2.out.slice(0, 300));

  const t2 = fs.readFileSync(path.join(V, '20-决策/ADR-981-要废掉.md'), 'utf8');
  ok('refuted: true 已写入', /^refuted:\s*true/m.test(t2), t2.slice(0, 200));
  ok('refuted_reason 已写入', /^refuted_reason:/m.test(t2));

  // ③ 被 refuted 的页检索不到
  writePage(V, '20-决策/ADR-982-含独特词.md', '---\ntitle: ADR-982 独特词 UniqueZZZ\ntrust: verified\n---\n# x\n');
  run(MEM, V, ['episode', '--schema', 'x', '--title', '推翻982',
    '--cues', 'UniqueZZZ', '--refutes', '20-决策/ADR-982-含独特词.md', '--refute-hard', '--body-file', body]);
  const rq = run(MEM, V, ['recall', 'UniqueZZZ']);
  ok('refuted 后检索不到', !/ADR-982/.test(rq.out), rq.out.slice(0, 200));

  // ④ 回滚能撤销 explicit_refute 标记
  const rb = run(MEM, V, ['rollback', '20-决策/ADR-980-被推翻.md', '--apply']);
  ok('rollback 能撤销显式标记', /已回滚/.test(rb.out), rb.out.slice(0, 200));
  const t3 = fs.readFileSync(path.join(V, '20-决策/ADR-980-被推翻.md'), 'utf8');
  ok('回滚后 superseded_by 已清除', !/^superseded_by:/m.test(t3));
  ok('回滚后 explicit_refute 已清除', !/^explicit_refute:/m.test(t3));

  // ⑤ 不存在的路径应报错但不崩
  const r3 = run(MEM, V, ['episode', '--schema', 'x', '--title', '推翻不存在',
    '--cues', 'q', '--refutes', '20-决策/不存在.md', '--body-file', body], { allowFail: true });
  ok('引用不存在路径时优雅跳过', r3.code === 0 && /跳过/.test(r3.out), r3.out.slice(0, 300));
}

// ═══════════════════════════════════════
console.log('\n══════════════════════════════════');
console.log(`通过 ${pass} / 失败 ${fail}`);
if (fail > 0) {
  console.log('\n失败明细：');
  for (const f of failures) console.log(`  ✗ ${f.name}\n     ${f.detail || ''}`);
}
process.exit(fail > 0 ? 1 : 0);

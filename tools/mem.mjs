#!/usr/bin/env node
/**
 * mem.mjs — DSH 记忆系统核心工具
 *
 * 基于认知科学设计的六层记忆：
 *   L1 工作记忆  → pages.idx（本工具生成）
 *   L2 情景记忆  → 40-归档/episodes/YYYY-MM/EP-*.md  (append-only)
 *   L3 语义记忆  → 10-项目/ 20-决策/  (source 标记 + superseded)
 *   L3' 程序记忆 → 30-习惯/procedures/P-*.md
 *   L3'' 前瞻记忆→ 不入库，走 schedule
 *   L4 遗忘      → compact（活化度衰减 + 按比例压缩）
 *
 * 用法：
 *   node mem.mjs index                     重建 pages.idx
 *   node mem.mjs recall "关键词A 关键词B"        按线索召回
 *   node mem.mjs episode --schema X --title Y --cues "a;b" --body-file F
 *   node mem.mjs distill [--apply]         夜间蒸馏
 *   node mem.mjs compact [--apply]         季度压缩
 *   node mem.mjs audit                     健康检查
 *   node mem.mjs stats                     统计
 *
 * 依赖：Node >= 18，零外部包。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// ─────────────────────────────────────────────────────────────
// 配置
// ─────────────────────────────────────────────────────────────

// 记忆库路径改为延迟解析（2026-11-18）
//
// 原因：init 命令要在"库还不存在"的目录里运行，
// 如果模块加载时就调 findVault()，init 会被它的报错 exit 挡住。
// 所以所有路径都改成 lazy getter，第一次真正用到时才解析。
let _vaultCache = null;
function getVault() {
  if (!_vaultCache) _vaultCache = process.env.MEM_VAULT || findVault();
  return _vaultCache;
}
function getSYS() { return path.join(getVault(), '99-系统', '记忆系统'); }
function getIDX() { return path.join(getSYS(), 'pages.idx'); }
function getLOG() { return path.join(getSYS(), 'access.log.jsonl'); }
function getDistillLogDir() { return path.join(getSYS(), 'distill-logs'); }
function getSnapshotDir() { return path.join(getSYS(), 'snapshots'); }
function getEpisodeDir() { return path.join(getVault(), '40-归档', 'episodes'); }
function getProcedureDir() { return path.join(getVault(), '30-习惯', 'procedures'); }




// 扫描时跳过的目录
const SKIP_DIRS = new Set(['.obsidian', '.git', '.trash', 'node_modules', '.mem']);

// 各类页面的权重（用于排序）
const KIND_WEIGHT = {
  procedure: 1.5,
  decision: 1.2,
  fact: 1.2,
  project: 1.0,
  habit: 1.1,
  episode: 0.8,
  index: 0.3,
  record: 0.6,
};

// ─────────────────────────────────────────────────────────────
// CLI 参数解析（集中在一处，避免每加一个 flag 就漏一次）
//
// 历史教训（2026-11-18 犯了 2 次）：
//   · `--spread-limit 8` → 8 被当成查询词
//   · `--note "文字"` → 文字被当成文件路径
// 根因都是各命令自己维护 flag 白名单，新增 flag 时忘了同步。
// 现在改成全局注册：所有 flag 必须在下表登记，否则解析时会报警。
// ─────────────────────────────────────────────────────────────

// 带值的 flag
const FLAG_WITH_VALUE = new Set([
  'limit', 'min-score', 'spread-limit', 'spread-min-ratio',
  'schema', 'title', 'cues', 'project', 'salience', 'body-file', 'body',
  'outcome', 'lesson', 'corrections', 'expectation', 'trust',
  'reason', 'by', 'note', 'days',
]);

// 纯开关
const FLAG_BOOL = new Set(['spread', 'graph', 'apply', 'ok', 'success', 'fail', 'failed']);

/**
 * 解析从第 startIdx 位开始的位置参数，正确跳过所有 flag 及其值。
 * 返回 { positional, flags }
 */
/**
 * 定位记忆库根目录。
 *
 * 优先级（2026-11-18 调整，适配 npx 场景）：
 *   1. 环境变量 MEM_VAULT   —— 显式指定，最高优先级
 *   2. 当前目录本身         —— npx 场景：cd 到自己的库再跑
 *   3. 向上查找             —— 在子目录里跑也能找到根
 *   4. 副作用的兜底          —— 都没有就自动初始化当前目录（首次使用体验）
 */
function findVault() {
  if (process.env.MEM_VAULT) return process.env.MEM_VAULT;

  const cwd = process.cwd();

  // 当前目录本身就是库（有 99-系统/记忆系统 或有 .md 文件）
  if (fs.existsSync(path.join(cwd, '99-系统', '记忆系统'))) return cwd;

  // 向上找
  let dir = cwd;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, '99-系统', '记忆系统'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // 当前目录里已经有 .md 文件 → 当成库，让它自动初始化
  try {
    const hasMd = fs.readdirSync(cwd).some(f => f.endsWith('.md'));
    const hasDirs = ['10-项目', '20-决策', '99-系统']
      .some(d => fs.existsSync(path.join(cwd, d)));
    if (hasMd || hasDirs) return cwd;
  } catch { /* 读不了就算了 */ }

  // 什么都没有 → 首次使用，把当前目录初始化为库
  console.error('');
  console.error('未检测到记忆库。');
  console.error('');
  console.error(`当前目录：${cwd}`);
  console.error('里面没有 .md 文件，也没有记忆系统目录。');
  console.error('');
  console.error('三个选择：');
  console.error('');
  console.error('  ① 在当前目录新建一个库（推荐新手）：');
  console.error(`       node "${process.argv[1]}" init`);
  console.error('');
  console.error('  ② 指向你已有的 Obsidian / Markdown 库：');
  console.error(`       set MEM_VAULT=D:\\path\\to\\your\\vault     (Windows CMD)`);
  console.error(`       $env:MEM_VAULT="D:\\path\\to\\your\\vault"  (PowerShell)`);
  console.error(`       export MEM_VAULT=/path/to/your/vault       (Linux/macOS)`);
  console.error('');
  console.error('  ③ 用安装脚本装到指定目录：');
  console.error(`       node "${path.join(path.dirname(process.argv[1]), 'setup.mjs')}" D:\\path\\to\\new\\vault`);
  console.error('');
  process.exit(1);
}

function parseArgs(startIdx) {
  const positional = [];
  const flags = {};
  for (let i = startIdx; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (!a.startsWith('--')) { positional.push(a); continue; }

    const raw = a.slice(2);
    const eq = raw.indexOf('=');
    const name = eq === -1 ? raw : raw.slice(0, eq);

    if (eq !== -1) {
      // --key=value 形式
      flags[name] = raw.slice(eq + 1);
      continue;
    }
    if (FLAG_BOOL.has(name)) { flags[name] = true; continue; }
    if (FLAG_WITH_VALUE.has(name)) {
      const nxt = process.argv[i + 1];
      if (nxt !== undefined && !nxt.startsWith('--')) {
        flags[name] = nxt; i++;
      } else {
        flags[name] = true;
      }
      continue;
    }
    // 未注册的 flag：保留原行为（当开关），但记录以便排查
    flags[name] = true;
    flags.__unregistered = flags.__unregistered || [];
    flags.__unregistered.push(name);
  }
  return { positional, flags };
}

// ─────────────────────────────────────────────────────────────
// Frontmatter 解析（无依赖，支持 YAML 子集）
// ─────────────────────────────────────────────────────────────

function stripBOM(s) {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

function parseScalar(raw) {
  const v = raw.trim();
  if (v === '' || v === '~' || v === 'null') return null;
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+$/.test(v)) return parseInt(v, 10);
  if (/^-?\d+\.\d+$/.test(v)) return parseFloat(v);
  // 去引号
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  return v;
}

function parseFrontmatter(text) {
  text = stripBOM(text);
  if (!text.startsWith('---')) return { data: {}, body: text, hasFM: false };

  const end = text.indexOf('\n---', 3);
  if (end === -1) return { data: {}, body: text, hasFM: false };

  const fmRaw = text.slice(3, end).trim();
  const body = text.slice(end + 4).replace(/^\r?\n/, '');

  const data = {};
  let currentKey = null;
  let currentArr = null;

  for (const line of fmRaw.split(/\r?\n/)) {
    if (!line.trim()) continue;

    // 数组项 "  - value"
    const arrMatch = line.match(/^(\s+)-\s+(.*)$/);
    if (arrMatch && currentArr !== null) {
      currentArr.push(parseScalar(arrMatch[2]));
      continue;
    }

    const kvMatch = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (kvMatch) {
      const [, key, valRaw] = kvMatch;
      const val = valRaw.trim();
      if (val === '') {
        // 可能是数组或嵌套对象开始
        currentKey = key;
        currentArr = [];
        data[key] = currentArr;
      } else if (val.startsWith('[') && val.endsWith(']')) {
        // 行内数组 [a, b, c]
        const inner = val.slice(1, -1).trim();
        data[key] = inner ? inner.split(',').map(s => parseScalar(s)) : [];
        currentKey = null;
        currentArr = null;
      } else {
        data[key] = parseScalar(val);
        currentKey = null;
        currentArr = null;
      }
    }
  }

  return { data, body, hasFM: true };
}

function serializeFrontmatter(data) {
  const lines = ['---'];
  for (const [k, v] of Object.entries(data)) {
    if (v === null || v === undefined) {
      lines.push(`${k}: null`);
    } else if (Array.isArray(v)) {
      if (v.length === 0) {
        lines.push(`${k}: []`);
      } else {
        lines.push(`${k}:`);
        for (const item of v) lines.push(`  - ${JSON.stringify(String(item))}`);
      }
    } else if (typeof v === 'number' || typeof v === 'boolean') {
      lines.push(`${k}: ${v}`);
    } else {
      lines.push(`${k}: ${JSON.stringify(String(v))}`);
    }
  }
  lines.push('---');
  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────
// 扫描与索引
// ─────────────────────────────────────────────────────────────

function* walk(dir, depth = 0) {
  if (depth > 8) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith('.') && SKIP_DIRS.has(e.name)) continue;
    if (SKIP_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      yield* walk(full, depth + 1);
    } else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) {
      yield full;
    }
  }
}

function rel(p) {
  return path.relative(getVault(), p).replace(/\\/g, '/');
}

// 语义类型的归一化映射：把库里 35 种自由 type 归到 7 个标准类
const TYPE_ALIASES = {
  decision: ['decision', 'adr', '决策'],
  fact: ['fact', '事实'],
  procedure: ['procedure', '流程', '步骤'],
  episode: ['episode', '情景'],
  project: ['project', '项目', 'project-note', 'project-detail'],
  habit: ['habit', '习惯', '偏好'],
  index: ['index', '索引', '目录', '总览'],
  // 其余全部归为 record（记录类，比如会话档案、证据、日志）
  record: [
    'memory', 'session', '技术文档', '汇总', '环境记录', 'checklist',
    '诊断', '目标重审', 'guide', '排雷清单', '运维记录', '权威状态页',
    '交接', '交付', '台账', '修复', '总结', '项目总结', '收束', '更新日志',
    '总账', '决定性数据', '决定性成果', '纠正', '结构性成果', '进展',
    'subpage', '其它',
  ],
};

const ALIAS_LOOKUP = (() => {
  const m = new Map();
  for (const [canonical, aliases] of Object.entries(TYPE_ALIASES)) {
    for (const a of aliases) m.set(a.toLowerCase(), canonical);
  }
  return m;
})();

function inferKind(data, relPath) {
  // 路径优先级最高：Episode 和 procedure 有严格目录约定
  if (relPath.includes('/episodes/')) return 'episode';
  if (relPath.includes('/procedures/')) return 'procedure';

  // 其次看 ADR 文件名
  if (/\/ADR-[^/]+\.md$/.test(relPath)) return 'decision';
  if (relPath.includes('/决策/')) return 'decision';

  // 再看 type 字段（归一化）
  if (data.type) {
    const raw = String(data.type).toLowerCase().trim();
    const mapped = ALIAS_LOOKUP.get(raw);
    if (mapped) return mapped;
  }

  // 最后看路径
  if (relPath.startsWith('20-决策/')) return 'decision';
  if (relPath.startsWith('10-项目/')) return 'project';
  if (relPath.startsWith('30-习惯/')) return 'habit';
  if (relPath.startsWith('99-系统/')) return 'record';
  if (relPath.includes('索引')) return 'index';
  return 'record';
}

function extractTitle(data, body, relPath) {
  if (data.title) return String(data.title);
  const h1 = body.match(/^#\s+(.+)$/m);
  if (h1) return h1[1].trim();
  return path.basename(relPath, '.md');
}

function extractCues(data) {
  const out = [];
  if (Array.isArray(data.cues)) {
    for (const c of data.cues) if (c) out.push(String(c));
  }
  if (data.cue) out.push(String(data.cue));
  if (Array.isArray(data.keys)) {
    for (const k of data.keys) if (k) out.push(String(k));
  }
  return out;
}

function scanVault() {
  const pages = [];
  for (const file of walk(getVault())) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const relPath = rel(file);

    // 跳过模板文件：它们是空壳，不是真实记忆
    if (relPath.includes('/模板/') || relPath.includes('/记忆系统/模板')) continue;
    const base = path.basename(relPath);
    if (/模板|template/i.test(base)) continue;

    const { data, body } = parseFrontmatter(text);
    const kind = inferKind(data, relPath);
    const title = extractTitle(data, body, relPath);
    const cues = extractCues(data);

    // 正文前 400 字作为摘要
    const plain = body
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/[#*`>\[\]()]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    const words = Array.from(plain).length;
    const mtime = fs.statSync(file).mtimeMs;

    pages.push({
      path: relPath,
      kind,
      title,
      cues,
      project: data.project || null,
      schema: data.schema || null,
      source: data.source || null,

      // ── 可信度（2026-11-18 从 source 拆出）──
      //
      // 为什么改名：库里原有的 `source` 意思是「出处」（"会话 2026-10-22（...）"），
      // 82 页在用；我今天加的 `source` 意思是「可信度」（verified/...），26 页在用。
      // 同名不同义会导致规则和执行对不上。所以可信度改用 trust，
      // 原 source 一字不动——零破坏。
      trust: data.trust || null,
      trust_auto: data.trust_auto === true,
      trust_manual: data.trust_manual === true,
      status: data.status || null,
      // ── 自我纠错（2026-11-18 新增）──
      superseded_by: data.superseded_by || null,
      refuted: data.refuted === true || data.refuted === 'true',
      refuted_by: data.refuted_by || null,
      refuted_reason: data.refuted_reason || null,

      // ── 重要性权重（2026-11-18 修复：之前建了但从不参与打分）──
      salience: typeof data.salience === 'number' ? data.salience : (parseFloat(data.salience) || null),

      // ── 程序记忆的实战统计 ──
      times_applied: parseInt(data.times_applied, 10) || 0,
      success_rate: data.success_rate === null || data.success_rate === undefined
        ? null : parseFloat(data.success_rate),
      size: words,
      mtime: Math.round(mtime / 1000),
      digest: crypto.createHash('sha1').update(plain.slice(0, 800)).digest('hex').slice(0, 12),
      preview: plain.slice(0, 160),
    });
  }
  return pages;
}

function buildIndex(pages) {
  const sorted = pages.slice().sort((a, b) => {
    const wa = KIND_WEIGHT[a.kind] ?? 0.5;
    const wb = KIND_WEIGHT[b.kind] ?? 0.5;
    if (wb !== wa) return wb - wa;
    return b.mtime - a.mtime;
  });

  const lines = [];
  lines.push('# pages.idx — L1 工作记忆目录');
  lines.push('# 由 mem.mjs index 生成，请勿手工编辑');
  lines.push(`# generated: ${new Date().toISOString()}`);
  lines.push(`# total: ${sorted.length}`);
  lines.push('');

  for (const p of sorted) {
    const cueStr = p.cues.length ? p.cues.slice(0, 6).join(' | ') : '-';
    lines.push(`[${p.kind}] ${p.path}`);
    lines.push(`  title: ${p.title}`);
    lines.push(`  cues: ${cueStr}`);
    if (p.source) lines.push(`  source: ${p.source}`);
    if (p.superseded_by) lines.push(`  superseded_by: ${p.superseded_by}`);
    lines.push(`  size: ${p.size} chars`);
  }
  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────
// 访问日志与活化度（Anderson & Schooler 1991）
// ─────────────────────────────────────────────────────────────

function appendLog(entry) {
  fs.mkdirSync(getSYS(), { recursive: true });
  fs.appendFileSync(getLOG(), JSON.stringify({ t: Date.now(), ...entry }) + '\n', 'utf8');
}

function readLog() {
  if (!fs.existsSync(getLOG())) return [];
  const out = [];
  for (const line of fs.readFileSync(getLOG(), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip bad line */ }
  }
  return out;
}

/**
 * 活化度：Anderson & Schooler (1991) 的 power-law 需求概率
 *
 * 原式 A = ln(1 + Σt^-0.5)，t 以「秒」为单位。
 * 致命缺陷（2026-11-18 实测发现）：
 *   1 小时前访问一次 → t=3600 → t^-0.5 = 0.0167 → A = 0.0165
 *   这远低于压缩阈值 0.15，等于「几乎所有东西都该被压缩」。
 * 根因：秒级时间尺度让衰减快得离谱，人类遗忘是「天」级的，不是秒级。
 *
 * 修正：以「天」为时间单位，并用半衰期形式重写。
 *   A = Σ 0.5^(Δt / halfLife)
 *   halfLife 默认 30 天（Anderson & Schooler 报告人类记忆的 power-law 指数
 *   约 -0.5，对应"30 天损失约一半"的量级）
 *
 * 性质：
 *   - 刚访问一次 → A ≈ 1.0
 *   - 30 天前访问一次 → A ≈ 0.5
 *   - 90 天前 → A ≈ 0.125
 *   - 反复访问会叠加（人类的高频记忆确实更强）
 */
function activation(accessTimes, now = Date.now(), halfLifeDays = 30) {
  const DAY = 86400 * 1000;
  const halfLife = halfLifeDays * DAY;
  let sum = 0;
  for (const t of accessTimes) {
    const dt = now - t;
    if (dt < 0) continue;
    sum += Math.pow(0.5, dt / halfLife);
  }
  return sum;
}

function activationMap() {
  const log = readLog();
  const byPath = new Map();
  for (const e of log) {
    // 只认 used（真正被引用），不认 recall（只是被列出）
    if (e.op !== 'used') continue;
    if (!e.path) continue;
    if (!byPath.has(e.path)) byPath.set(e.path, []);
    byPath.get(e.path).push(e.t);
  }
  const out = new Map();
  for (const [p, times] of byPath) out.set(p, activation(times));
  return out;

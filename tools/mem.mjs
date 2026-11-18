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

}

// ─────────────────────────────────────────────────────────────
// 检索（编码特异性 + 三因子打分）
// ─────────────────────────────────────────────────────────────

// 中文高频虚词：不作为检索 token，否则淹没所有结果
const CJK_STOP = new Set(
  '的 了 是 在 我 有 和 就 不 人 都 一 一个 上 也 很 到 说 要 去 你 会 着 没有 看 好 自己 这 那 什么 怎么 为什么 因为 所以 但 但是 如果 可以 需要 进行 通过 以及 或者 还有 这个 那个 我们 他们 它 与 及 等 中 下 后 前 时 用 被 把 给 对 从 向 里 外 上 内 个 那些 这些 之 而 其 于 以 为 于 即 则 所 由 并'.split(/\s+/)
);

function isCjk(s) {
  return /[\u4e00-\u9fa5]/.test(s);
}

function tokenize(q) {
  const s = q.toLowerCase().trim();
  const tokens = new Set();
  if (!s) return { phrase: '', tokens: [] };

  // 英文/数字词（>=2 字符）
  for (const m of s.matchAll(/[a-z0-9_+#.]{2,}/g)) {
    const w = m[0];
    if (!CJK_STOP.has(w)) tokens.add(w);
  }

  // 中文：只取 2-gram 和 3-gram，不取单字（单字噪声太大）
  const cjk = s.replace(/[^\u4e00-\u9fa5]/g, '');
  for (let n = 2; n <= 3; n++) {
    for (let i = 0; i + n <= cjk.length; i++) {
      const g = cjk.slice(i, i + n);
      if (!CJK_STOP.has(g)) tokens.add(g);
    }
  }

  return { phrase: s, tokens: [...tokens] };
}

/**
 * 打分：覆盖率主导 + IDF 加权质量
 *
 * 核心修正（2026-11-18）：
 * 之前用加法聚合 token 命中，导致"崩溃"这种高频词能靠单点命中拉满分数。
 * 现在改为：覆盖率（命中 token 数 / 查询 token 数）作为幂次乘数，
 * 命中 1/4 的文档与命中 4/4 的文档差距 ≥ 16 倍。
 *
 * 依据：编码特异性（Tulving & Thomson 1973）——
 * 线索必须与编码时匹配，匹配得越完整越可信。
 */
function scorePage(p, q, df, totalDocs) {
  const { phrase, tokens } = q;
  const titleL = p.title.toLowerCase();
  const pathL = p.path.toLowerCase();
  const previewL = p.preview.toLowerCase();
  const cuesL = p.cues.map(c => c.toLowerCase());

  // ① 线索精确匹配（最强信号，直接加分不参与覆盖率计算）
  let cueBonus = 0;
  for (const cl of cuesL) {
    if (phrase && cl === phrase) cueBonus += 40;
    else if (phrase && phrase.length >= 2 && (cl.includes(phrase) || phrase.includes(cl))) cueBonus += 15;
  }

  // ② 短语整体命中标题 / 路径
  let phraseBonus = 0;
  if (phrase && phrase.length >= 2) {
    if (titleL.includes(phrase)) phraseBonus += 30;
    if (pathL.includes(phrase)) phraseBonus += 18;
  }

  // ③ 逐 token 计算命中质量
  let matched = 0;
  let qualitySum = 0;

  for (const t of tokens) {
    const dfv = df.get(t) || 1;
    const idf = Math.log(1 + totalDocs / dfv);

    let quality = 0;
    if (titleL.includes(t)) quality = 30 + 10 * idf;
    else if (pathL.includes(t)) quality = 20 + 7 * idf;
    else if (cuesL.some(c => c.includes(t))) quality = 15 + 6 * idf;
    else if (previewL.includes(t)) quality = 2 * idf;

    if (quality > 0) {
      matched += 1;
      const isProper = /^[a-z0-9_+#.]{2,}$/.test(t) || /\d/.test(t);
      qualitySum += quality * (isProper ? 1.6 : 1.0);
    }
  }

  if (matched === 0 && cueBonus === 0 && phraseBonus === 0) return 0;

  const coverage = tokens.length > 0 ? matched / tokens.length : (phrase ? 1 : 0);
  const coverageWeight = Math.min(tokens.length / 3, 1);
  const coverageScore = Math.pow(coverage, 2) * 100 * coverageWeight;

  let segmentBonus = 0;
  for (const seg of p.path.split('/').slice(0, -1)) {
    const segL = seg.toLowerCase();
    if (phrase && phrase.length >= 2 && segL.includes(phrase)) {
      segmentBonus = Math.max(segmentBonus, 25);
    }
  }

  let score = qualitySum + coverageScore + cueBonus + phraseBonus + segmentBonus;

  // ⑤ 类型权重
  const kw = KIND_WEIGHT[p.kind] ?? 0.5;
  score *= kw;

  // ⑥ 新近权重（recency）：新观点优先于老观点
  //
  // 依据：Murdock (1962) 近因效应 + Anderson & Schooler (1991) 需求概率里
  //       新近度是三大因子之一。人的记忆里，刚学到的东西比多年前的更可信。
  //
  // 语义页（decision/fact/project）用半衰期 1 年：
  //   · 1 天内  → ×1.00
  //   · 3 个月  → ×0.84
  //   · 1 年    → ×0.50
  //   · 3 年    → ×0.13
  // 太老的结论即使文本匹配度一样，也应排在新结论之后。
  //
  // 但不压到 0：老的金科玉律（如 路径含中文导致崩溃）依然要能被搜到，
  // 只是同分时让位给新的。所以下限设 0.15，不归零。
  const RECENCY_HALFLIFE_DAYS = 365;
  const ageDays = (Date.now() - p.mtime * 1000) / 86400000;
  let recency = Math.pow(0.5, Math.max(0, ageDays) / RECENCY_HALFLIFE_DAYS);
  recency = Math.max(recency, 0.15);   // 下限：老知识不消失
  score *= recency;

  // ⑥' 重要性权重（salience）
  //
  // 修复（2026-11-18）：salience 字段建了很久，但打分里从来没用过——
  // 又一个"建了不接线"的死字段。用户手标的「这条很重要」等于白标。
  //
  // 映射：salience 0.5 为中性（×1.0），1.0 为最高（×1.5），0 为最低（×0.5）
  if (typeof p.salience === 'number' && p.salience !== null) {
    const s = Math.max(0, Math.min(1, p.salience));
    score *= (0.5 + s);   // 0→0.5, 0.5→1.0, 1.0→1.5
  }

  // ⑥'' 程序记忆的实证表现
  //
  // 修复（2026-11-18）：times_applied / success_rate 建了但从不更新、也从不接线。
  // 现在至少让"成功率"参与排序——屡次失败的老流程不该排在前面。
  if (p.kind === 'procedure' && p.success_rate !== null && p.times_applied > 0) {
    // 成功率 0.5 以下开始明显降权，1.0 保持原值
    const sr = Math.max(0, Math.min(1, p.success_rate));
    score *= (0.4 + 0.6 * sr);   // 0→0.4, 0.5→0.7, 1.0→1.0
  }

  // ⑦ superseded 降权（提取诱发遗忘：被取代的旧结论主动压制）
  // ⑧ refuted 直接排除（错的信念彻底弃用，不是降权）
  //
  // 区分（2026-11-18）：
  //   superseded → 0.2 倍，还能被搜到（"当时是这么想的"）
  //   refuted    → 0 倍，完全不出现（"这条是错的，不要再用"）
  // 对应人类：过时的知识偶尔还能想起来，但错的信念会被彻底弃用。
  if (p.refuted) return 0;
  if (p.superseded_by) score *= 0.2;

  // ⑨ 已归档降权（Episode 例外）
  if (p.path.startsWith('40-归档/') && !p.path.includes('/episodes/')) score *= 0.7;

  return score;
}

/** 计算文档频率（用于 IDF） */
function buildDF(pages, tokens) {
  const df = new Map();
  for (const t of tokens) {
    let n = 0;
    for (const p of pages) {
      if (
        p.title.toLowerCase().includes(t) ||
        p.path.toLowerCase().includes(t) ||
        p.preview.toLowerCase().includes(t)
      ) n++;
    }
    df.set(t, Math.max(n, 1));
  }
  return df;
}

function recall(query, pages, opts = {}) {
  const limit = opts.limit ?? 12;
  const minScore = opts.minScore ?? 2;
  const q = tokenize(query);
  if (q.tokens.length === 0 && !q.phrase) return [];

  const df = buildDF(pages, q.tokens);
  const actMap = activationMap();

  const scored = [];
  for (const p of pages) {
    let s = scorePage(p, q, df, pages.length);
    if (s <= 0) continue;
    const act = actMap.get(p.path) ?? 0;
    s *= 1 + Math.min(act, 5) * 0.12;
    if (s >= minScore) scored.push({ ...p, score: s });
  }

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, limit);

  // 注意：这里不再写 recall 日志。
  //
  // 原因（2026-11-18 修）：原来「检索到」就算「用过」，导致
  //   - 召回 12 条、我实际只用 1 条，12 条全部被强化
  //   - 反复召回同一批页面会把它们的活化度刷到虚高
  //   - 活化度本应反映"这个知识真的被需要过"，不是"被列表出来过"
  //
  // 改为：只有调用方显式确认使用了某页时，才记 `used` 事件。
  // 见 markUsed()。人类记忆也是这样——想起 10 个候选，只有真正用上的那个被巩固。
  return top;
}

/** 显式标记"这一页真的被用上了"，这才是强化记忆的正确信号 */
function markUsed(paths, query = '') {
  for (const p of paths) {
    appendLog({ op: 'used', path: p, q: query });
  }
}

/**
 * 记录一次 procedure 的实战结果（2026-11-18 新增）
 *
 * 解决的问题：times_applied / success_rate 建了很久，
 * 但全代码库没有任何写入点——procedure 的实战统计永远是初始值，
 * 导致「屡次失败的老流程」和「刚写的新流程」在打分上没区别，
 * 失效流程永远淘汰不掉。
 *
 * 人类对应：程序性记忆靠反复使用被强化，靠反复失败被废弃。
 * 不记成败，就学不会「这条路走不通」。
 *
 * @param notes 叶节点路径（30-习惯/procedures/P-xxxx.md）
 * @param ok    true = 成功，false = 失败
 */
function recordProcedureUse(notePath, ok, { note = '' } = {}) {
  const full = path.join(getVault(), notePath);
  if (!fs.existsSync(full)) return { ok: false, reason: '文件不存在' };

  let text = fs.readFileSync(full, 'utf8');
  const i = text.indexOf('\n---', 3);
  if (i === -1) return { ok: false, reason: '无 frontmatter' };

  let fm = text.slice(3, i);
  const body = text.slice(i);

  const getNum = (key) => {
    const m = fm.match(new RegExp(`^${key}:\\s*([\\d.]+)`, 'm'));
    return m ? parseFloat(m[1]) : null;
  };

  const prevTimes = Math.floor(getNum('times_applied') ?? 0);
  const prevRate = getNum('success_rate');

  const newTimes = prevTimes + 1;
  // 增量式成功率：既考虑历史，也考虑这一次
  const prevSucc = prevRate === null ? null : prevRate * prevTimes;
  const newRate = prevSucc === null
    ? (ok ? 1 : 0)
    : (prevSucc + (ok ? 1 : 0)) / newTimes;

  const setField = (key, val) => {
    const re = new RegExp(`^${key}:.*$`, 'm');
    if (re.test(fm)) fm = fm.replace(re, `${key}: ${val}`);
    else fm = fm.replace(/\s*$/, '') + `\n${key}: ${val}`;
  };

  setField('times_applied', newTimes);
  setField('success_rate', Math.round(newRate * 100) / 100);
  setField('last_applied', JSON.stringify(new Date().toISOString().slice(0, 10)));

  if (note) {
    // 追加到「使用记录」表末尾
    const stamp = new Date().toISOString().slice(0, 10);
    const row = `| ${stamp} | ${note} | ${ok ? '成功' : '失败'} | |`;
    if (/## 使用记录/.test(body)) {
      text = '---' + fm + body.replace(/(\|[^\n]*\n)(\s*$)/, `$1${row}\n$2`);
    } else {
      text = '---' + fm + body + `\n\n## 使用记录\n\n| 日期 | 场景 | 结果 | 备注 |\n|---|---|---|---|\n${row}\n`;
    }
  } else {
    text = '---' + fm + body;
  }

  fs.writeFileSync(full, text, 'utf8');
  appendLog({ op: 'procedure_use', path: notePath, ok });

  return {
    ok: true,
    times: newTimes,
    rate: Math.round(newRate * 100) / 100,
    prevTimes,
    prevRate,
  };
}

// ─────────────────────────────────────────────────────────────
// 情景记忆：写 Episode
// ─────────────────────────────────────────────────────────────

function pad2(n) { return String(n).padStart(2, '0'); }

function nowParts() {
  const d = new Date();
  return {
    y: d.getFullYear(),
    m: pad2(d.getMonth() + 1),
    d: pad2(d.getDate()),
    hh: pad2(d.getHours()),
    mm: pad2(d.getMinutes()),
    ss: pad2(d.getSeconds()),
    iso: d.toISOString(),
  };
}

function createEpisode({ schema, title, cues, body, project, salience, outcome, corrections, lesson, expectation, trust }) {
  const t = nowParts();
  const dir = path.join(getEpisodeDir(), `${t.y}-${t.m}`);
  fs.mkdirSync(dir, { recursive: true });

  const rand = crypto.randomBytes(2).toString('hex').toUpperCase();
  const id = `EP-${t.y}${t.m}${t.d}-${t.hh}${t.mm}-${rand}`;
  const file = path.join(dir, `${id}.md`);

  const fm = {
    type: 'episode',
    id,
    when: `${t.y}-${t.m}-${t.d}T${t.hh}:${t.mm}:${t.ss}+08:00`,
    schema: schema || '未分类',
    project: project || '未归属',
    salience: salience ?? 0.5,
    status: 'raw',

    // 可信度（2026-11-18 补接线）
    // 之前 CLI 收了 --trust 参数但 createEpisode 没写进 frontmatter，
    // 导致 11 条 Episode 全部缺 trust —— 又一次「建了不接线」。
    trust: trust || 'verified',   // Episode 是亲历记录，默认 verified

    // ── 自我进化字段（2026-11-18 新增）──
    // 人类记忆不只存"发生了什么"，还存"这事成没成、错在哪、学到什么"。
    // 没有这三个字段，系统就记不住自己犯过的错，必然重复犯错。
    outcome: outcome || 'unknown',      // success | partial | failure | unknown

    // ── 预期校验（2026-11-18 新增）──
    //
    // 解决的问题：contradictions 只能抓"形式矛盾"（A 说要 X，B 说不要 X），
    // 抓不出"这条结论本身算错了"——比如活化度公式量级错 100 倍，
    // 库里只有一份公式，没有矛盾，它只是错的。
    //
    // 人类靠什么发现这种错？靠"用起来不对"：以为会保留，结果被压了。
    // 所以让系统显式写下"我以为会发生什么"，事后对照，不符即信号。
    expectation: expectation || null,   // "以为会发生什么"
    expectation_held: null,             // true | false | null（未校验）

    corrections: corrections || [],    // 用户或自己纠错过的点
    lesson: lesson || null,            // 一句话经验（可蒸馏成 procedure）

    cues: cues || [],

    // derived_from：这条 Episode 读了哪些旧页
    //
    // ⚠ 2026-11-18 明确决定「暂不接线」：
    //   蒸馏只产出提案、不自动改语义页，所以没有可信的回填来源。
    //   硬填等于伪造溯源，比空着更糟。
    //   等蒸馏真能自动合并内容时再启用。
    //   检查工具 check-wiring.mjs 会把这条报为「只写不读」，属预期状态。
    derived_from: [],
    superseded_by: null,
  };

  const content = [
    serializeFrontmatter(fm),
    '',
    `# ${title || id}`,
    '',
    body || '（待补充）',
    '',
  ].join('\n');

  fs.writeFileSync(file, content, 'utf8');
  appendLog({ op: 'episode', path: rel(file), id, outcome: fm.outcome });

  // ── 自动冲突检测（2026-11-18，用户要求「让系统自动去做」）──
  //
  // 解决的问题：原来的链路是「人发现旧结论错了 → 人跑 refute → 系统执行」。
  // 第一步依赖人，系统自己不会发现。现在改成：
  //   新 Episode 一落盘，立刻拿它的 cues 反查库里的相关页，
  //   把「可能被这条新结论影响」的旧页列出来，写进冲突待裁决清单。
  //
  // 系统自己发现，人只做最后裁决。
  let conflicts = [];
  try {
    conflicts = detectConflictsForEpisode({ id, relPath: rel(file), cues, title, body, outcome: fm.outcome });
  } catch (e) {
    // 检测失败不影响 Episode 落盘本身
    conflicts = [{ error: e.message }];
  }

  return { id, file, relPath: rel(file), conflicts };
}

/**
 * 为一个新 Episode 检测它可能推翻/影响哪些旧结论。
 *
 * 判据（不依赖 LLM，纯规则）：
 *   1. cues/title 反查 → 命中旧页
 *   2. 新 Episode 正文里出现「错/过时/不对/推翻/相反/实际是」这类词
 *      → 说明这是一条纠错性记录，命中的旧页高度可疑
 *   3. 命中的旧页不是 Episode 本身、不是索引、不是 record
 *
 * 输出：写进 proposals/冲突待裁决.md，并返回列表
 */
function detectConflictsForEpisode({ id, relPath, cues, title, body, outcome }) {
  // 纠错词表（2026-11-18 收紧两次）
  //
  // 第一次收：去掉「实测发现」「实际是」这类中性描述词。
  //   原表太宽，正文「真实库压测」+ cue 含「真实」→ 误命中 8 条无关页。
  //
  // 第二次收（当前）：只认「明确宣布某结论是错的」的表述。
  const NEGATION_WORDS = [
    '是错的', '结论错', '判断错', '之前错', '原先错',
    '推翻', '不成立', '作废', '失效',
    '误判', '算错', '搞错', '不对',
  ];

  const titleText = String(title || '');
  const bodyText = String(body || '');

  const titleHasNeg = NEGATION_WORDS.some(w => titleText.includes(w));
  const bodyHasNeg = NEGATION_WORDS.some(w => bodyText.includes(w));

  // 触发条件收紧（2026-11-18）：
  //   原条件：正文含纠错词就触发 → 误报太多（描述性文本里也有这些词）
  //   新条件：必须 **标题宣布纠错** 或 **outcome=failure 且正文有纠错词**
  //   理由：标题是"这条记录的主题声明"，正文可能只是顺带提到。
  const isCorrectionRecord =
    titleHasNeg ||
    (outcome === 'failure' && bodyHasNeg);

  if (!isCorrectionRecord) return [];

  const pages = scanVault();

  // ── 逐 cue 独立检索，取交集（2026-11-18 第四版）──
  //
  // 前三版都失败，根因是同一个：把多个 cue 拼成一个 query 后，
  // 某个高频词（"路径"、"失败"）会把无关页顶到高分，
  // 而真正该抓的 ADR-0037 因为标题不匹配而分数偏低。
  //
  // 第四版换思路：**每个 cue 单独搜，统计候选页被几个 cue 命中**。
  // 被 ≥2 个不同 cue 命中的页才算嫌疑——这才符合"多个线索指向同一处"的直觉。
  const cueList = [...(cues || []), title].filter(Boolean).map(String);
  if (cueList.length === 0) return [];

  const hitMap = new Map();   // path → { page, cues: Set, maxScore }

  for (const cue of cueList) {
    const res = recall(cue, pages, { limit: 10, minScore: 3 });
    for (const r of res) {
      if (r.path === relPath) continue;
      if (['index', 'record', 'episode'].includes(r.kind)) continue;
      if (r.refuted) continue;

      if (!hitMap.has(r.path)) hitMap.set(r.path, { page: r, cues: new Set(), maxScore: 0 });
      const e = hitMap.get(r.path);
      e.cues.add(cue);
      e.maxScore = Math.max(e.maxScore, r.score);
    }
  }

  // 被 ≥2 个不同 cue 命中 → 强嫌疑
  const suspects = [...hitMap.values()]
    .filter(e => e.cues.size >= 2)
    .map(e => ({ ...e.page, score: e.maxScore, hitBy: e.cues.size }))
    .sort((a, b) => b.hitBy - a.hitBy || b.score - a.score)
    .slice(0, 8);

  if (suspects.length === 0) return [];

  // 写待裁决清单
  const dir = path.join(getSYS(), 'proposals');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, '冲突待裁决.md');

  // 写清单前先检查：这个（新结论 + 旧页集合）是不是已经记过
  // 2026-11-18 修：重复跑同一主题会累积重复条目，清单会越滚越长
  const existTxt = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';

  const sig = suspects.map(s => s.path).sort().join('|');
  const claimSig = String(title || '').trim();
  const isDuplicate = existTxt.includes(`**新结论**：${claimSig}`) &&
    suspects.every(s => existTxt.includes(s.path));

  if (isDuplicate) {
    appendLog({ op: 'conflict_detected', path: relPath, suspects: suspects.length, duplicate: true });
    return suspects.map(s => ({ path: s.path, title: s.title, score: Math.round(s.score * 10) / 10 }));

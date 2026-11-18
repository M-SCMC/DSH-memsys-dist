#!/usr/bin/env node
/**
 * setup.mjs — 一条命令把记忆系统装进你的 Obsidian 库
 *
 * 用法：
 *   node setup.mjs /path/to/your/vault
 *
 * 做的事：
 *   1. 检查目标目录是否像 Obsidian 库
 *   2. 创建六层结构必需的目录
 *   3. 复制工具到 99-系统/记忆系统/tools/
 *   4. 建立初始索引
 *   5. 打印下一步该干什么
 *
 * 幂等：重复运行不会覆盖已有文件（除非 --force）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const force = args.includes('--force');
const target = args.find(a => !a.startsWith('--'));

if (!target) {
  console.error('用法：node setup.mjs <你的Obsidian库路径> [--force]');
  console.error('例如：node setup.mjs ~/Documents/MyVault');
  process.exit(1);
}

const VAULT = path.resolve(target);

// ── 1. 校验目标 ──
if (!fs.existsSync(VAULT)) {
  console.error(`目录不存在：${VAULT}`);
  console.error('请先创建，或用 Obsidian 打开一次以初始化。');
  process.exit(1);
}

const looksLikeVault =
  fs.existsSync(path.join(VAULT, '.obsidian')) ||
  fs.existsSync(path.join(VAULT, '99-系统'));

if (!looksLikeVault) {
  console.warn(`⚠ ${VAULT} 看起来不像 Obsidian 库（没有 .obsidian 目录）`);
  console.warn('  仍然继续安装。如果你指错了路径，现在按 Ctrl+C 退出。');
  console.warn('');
}

// ── 2. 建目录 ──
const DIRS = [
  '99-系统/记忆系统/tools',
  '99-系统/记忆系统/模板',
  '99-系统/记忆系统/proposals',
  '99-系统/记忆系统/consolidated',
  '99-系统/记忆系统/backups',
  '10-项目',
  '20-决策',
  '30-习惯/procedures',
  '40-归档/episodes',
];

console.log('创建目录结构：');
for (const d of DIRS) {
  const p = path.join(VAULT, d);
  if (!fs.existsSync(p)) {
    fs.mkdirSync(p, { recursive: true });
    console.log(`  + ${d}`);
  } else {
    console.log(`  · ${d}（已存在）`);
  }
}

// ── 3. 复制工具 ──
const here = import.meta.dirname;
const srcTools = here;
const dstTools = path.join(VAULT, '99-系统/记忆系统/tools');

console.log('\n复制工具：');
let copied = 0, skipped = 0;
for (const f of fs.readdirSync(srcTools)) {
  if (!f.endsWith('.mjs')) continue;
  const dst = path.join(dstTools, f);
  if (fs.existsSync(dst) && !force) {
    console.log(`  · ${f}（已存在，跳过）`);
    skipped++;
    continue;
  }
  fs.copyFileSync(path.join(srcTools, f), dst);
  console.log(`  + ${f}`);
  copied++;
}

// ── 4. 建索引 ──
console.log('\n建立初始索引：');
const mem = path.join(dstTools, 'mem.mjs');
try {
  const out = execFileSync(process.execPath, [mem, 'index'], {
    env: { ...process.env, MEM_VAULT: VAULT },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  console.log(out.trim().split('\n').map(l => '  ' + l).join('\n'));
} catch (e) {
  console.error('  索引建立失败：', (e.stderr || e.message).slice(0, 300));
}

// ── 5. 下一步 ──
console.log(`
────────────────────────────────────────────────
安装完成。

下一步：

1) 设置环境变量（每次开新终端都要，或写进 shell 配置）

   Linux / macOS:
     export MEM_VAULT="${VAULT}"

   Windows PowerShell:
     $env:MEM_VAULT="${VAULT}"

   Windows CMD:
     set MEM_VAULT=${VAULT}

2) 试一下：

   node "${mem}" brief

3) 想自动跑蒸馏和压缩？把你的 Obsidian 库加到定时任务里即可。
   （不同系统方式不同，可参考 README 的「周期维护」一节。）

设计文档与完整说明见 README.md
────────────────────────────────────────────────
`);

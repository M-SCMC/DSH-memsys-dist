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

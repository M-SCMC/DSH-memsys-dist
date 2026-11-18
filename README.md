<div align="center">

# 🧠 DSH-memsys

### 六层记忆系统

**按人类大脑机制设计的 AI 记忆架构**

会衰减 · 会联想 · 会记错 · 会认错

<br>

[![Node](https://img.shields.io/badge/node-%E2%89%A518-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org)
[![Zero Deps](https://img.shields.io/badge/dependencies-0-brightgreen?style=flat-square)](.)
[![Tests](https://img.shields.io/badge/tests-80%20passed-success?style=flat-square)](.)
[![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)

<br>

不是更大的上下文窗口，不是更快的向量检索。

[快速开始](#-快速开始) · [核心机制](#-核心机制) · [命令速查](#-命令速查) · [设计依据](#-设计依据) · [边界](#-它做不到什么)

</div>

---

## 💡 它解决什么

今天所有 AI 记忆方案都缺了四件事：

<table>
<tr>
<td width="25%" align="center">🗑<br><b>不会忘</b></td>
<td width="75%">库里只增不减。三个月后，十年前的经验和昨天的占同样权重，检索淹没在噪声里。</td>
</tr>
<tr>
<td align="center">🕸<br><b>不会联想</b></td>
<td>只做关键词匹配。问 A 只答 A。人脑是想 A 时 B 自己浮上来。</td>
</tr>
<tr>
<td align="center">⚠<br><b>记不住"我错了"</b></td>
<td>推翻的结论和新结论并存。下次照用不误，同样的错犯第二遍。</td>
</tr>
<tr>
<td align="center">🔒<br><b>分不清来源</b></td>
<td>"我实测的"和"我听说的"混在一起。推理建立在道听途说上，就是幻觉起点。</td>
</tr>
</table>

---

## 📦 依赖：一个装着 Markdown 的目录

**不需要 Obsidian。** 实测验证过。

核心只做三件事：

```
1. 扫 .md 文件
2. 读 YAML frontmatter（--- 包起来那段）
3. 解析链接建图
```

全部是通用格式，任何编辑器写的都认。

### 各环境兼容度

| 环境 | 能跑吗 | 说明 |
|---|---|---|
| **Obsidian** | ✅ 最佳 | `[[双链]]` 现成，联想最强 |
| **纯 Markdown + VS Code** | ✅ 能 | 用 `[文字](路径)`，联想略弱 |
| **Logseq** | ✅ 能 | 也用 `[[双链]]`，几乎无差异 |
| **Joplin / Typora / 任意编辑器** | ✅ 能 | 只要产出 `.md` + frontmatter |
| **Notion / 语雀导出** | ⚠️ 需转换 | 导入后跑一次 `index` 即可重建 |

### 唯一的差异：链接写法

| 写法 | 识别为 | 联想强度 |
|---|---|---|
| `[[20-决策/ADR-001]]` | **显式链接** `·链` | 强（权重 1~2） |
| `[文字](20-决策/ADR-001.md)` | **语义关联** `·义` | 中（权重 0.4~1.0） |

**两种都能建边**，不装 Obsidian 只是联想弱一档，其他功能完全一致。

<details>
<summary><b>为什么和 Obsidian 特别配？</b>（点开）</summary>

不是技术依赖，是三个刚好对上：

1. **文件就是数据库** —— 没有隐式状态，git 能直接管
2. **`[[双链]]` 就是现成的关联图** —— 不用再造一套链接语法
3. **frontmatter 就是结构化字段** —— YAML 天然能塞元数据

换言之：**选 Obsidian 是因为它合适，不是因为必须。**

</details>

---

## 🏗 六层结构

```
┌─────────────────────────────────────────────────────────┐
│  L1 工作记忆   pages.idx                                │
│     只放目录，450 token / 0.3 秒                        │
└────────────────────┬────────────────────────────────────┘
                     │ 需要时取
┌────────────────────▼────────────────────────────────────┐
│  L2 情景记忆   episodes/                                │
│     带时间地点的原始经历，只追加，永不覆盖              │
└────────────────────┬────────────────────────────────────┘
                     │ 夜间蒸馏
┌────────────────────▼────────────────────────────────────┐
│  L3 语义记忆   projects/ + decisions/                   │
│     提炼后的结论，只能由蒸馏改写                        │
├─────────────────────────────────────────────────────────┤
│  L3' 程序记忆  procedures/                              │
│     可复用的动作流程，用一次成功就强化                  │
└────────────────────┬────────────────────────────────────┘
                     │ 每季压缩
┌────────────────────▼────────────────────────────────────┐
│  L4 遗忘       distill + compact                        │
│     按比例下调，不是删除                                │
└─────────────────────────────────────────────────────────┘
```

> **每层只有一个写入者。**
> 这条纪律一次性消灭三个通病：**漏写、覆盖、分叉**。

---

## ⚙️ 核心机制

### ① 遗忘：半衰期衰减

```
A = Σ 0.5^(Δt / 30天)
```

| 天数 | 0 | 7 | 30 | 90 | 180 | 365 |
|---|---|---|---|---|---|---|
| 活化度 | `1.000` | `0.851` | `0.500` | `0.125` | `0.016` | `0.000` |

> **关键：只有"真正用上"才算数。**
> 检索本身不强化记忆。实测比例：`recall 350 次` vs `used 3 次`。

<sub>依据：Anderson & Schooler (1991) 人类记忆幂律</sub>

### ② 联想：双链 + 语义 + 图扩散

| 联想类型 | 人怎么体验 | 系统怎么实现 |
|---|---|---|
| **由链接联想** | 你记得自己把两者联系起来过 | 遍历 Markdown 双链图 |
| **由语义联想** | 内涵很近，哪怕从没被连过 | 共享罕见词建立隐式边 |
| **扩散** | 想 A 时相关区域一起点亮 | Personalized PageRank |

**实测例子**：输入「蛋糕」

```
直接命中：像素蛋糕项目主页
联想出：  PS 插件（它的下游项目）
          祛斑复刻（同源已搁浅的线）
```

你没提 PS 插件，但系统知道"蛋糕的逆向结论被移植进了 PS 插件"。
这是关键词检索永远做不到的。

<sub>依据：HippoRAG (Gutiérrez et al. 2024) — 海马体索引 ≈ PPR</sub>

### ③ 自我纠错：三种推翻

| 标记 | 含义 | 检索效果 |
|---|---|---|
| `superseded_by` | 有更新说法，旧的曾经对 | 降权 **0.2 倍** |
| `refuted: true` | 这条本身是错的 | **权重归零**，不出现 |
| 无标记 | 仍有效 | 正常 |

**全自动靠显式声明**：

```bash
memsys episode --title "推翻 XXX" --outcome failure \
  --refutes "20-决策/ADR-00XX-xxx.md" --body-file body.md
```

零猜测、零误判。**标错了随时回滚**：

```bash
memsys rollback --all --apply
```

### ④ 来源监控：四档 trust

| 标记 | 含义 | 能当依据改别的结论吗 |
|---|---|---|
| `verified` | 实测 / 看见原文 / 跑通了 | ✅ 可以 |
| `reported` | 用户说的 / 文档写的 | ⚠️ 可以，但标出处 |
| `inferred` | 从证据推的（可能错） | ❌ 不行 |
| `recalled` | 我记得以前是这样（最不可靠） | ❌ 不行 |

> **硬约束**：`inferred` 和 `recalled` 不能作为依据去改动其他结论。
> 要拿它推理，必须先升格成 `verified`。
> 这一条挡住了绝大多数"用推测当事实继续往下推"的雪崩。

<sub>依据：Johnson, Hashtroudi & Lindsay (1993) 来源监控理论</sub>

### ⑤ 新近效应

新观点压过老观点：1 天 vs 3 年 = **6.7 倍**。
但老知识保留 **0.15 下限**——金科玉律仍搜得到，同分时让位。

---

## 🚀 快速开始

### 方式一：npx（最省事）

```bash
npx dsh-memsys init
```

在当前目录建好全部结构，之后直接就能用：

```bash
memsys index
memsys brief
memsys recall "关键词" --spread
```

### 方式二：git clone

```bash
git clone https://github.com/M-SCMC/DSH-memsys-dist.git
cd DSH-memsys-dist

# 装到你已有的库
node tools/setup.mjs /path/to/your/vault

# 或者在当前目录新建一个
node tools/mem.mjs init
```

### 方式三：Download ZIP

网页右上角 **Code → Download ZIP**，解压后：

```bash
cd DSH-memsys-dist
node tools/mem.mjs init
```

### 🎯 不用环境变量

**v1.0 起，`MEM_VAULT` 是可选的。**

系统按这个顺序自动找库：

```
1. 环境变量 MEM_VAULT      ← 显式指定
2. 当前目录本身就是库        ← npx 场景
3. 向上查找                ← 在子目录里跑
4. 当前目录有 .md 文件      ← 懒人模式
```

所以你 `cd` 到自己的库里，直接跑命令就行：

```bash
cd ~/my-vault
node ~/DSH-memsys-dist/tools/mem.mjs brief
```

**只有这一种情况需要设环境变量**：想在任意目录调用，指向固定库。

```bash
export MEM_VAULT=~/my-vault          # Linux/macOS
$env:MEM_VAULT="D:\my-vault"         # PowerShell
set MEM_VAULT=D:\my-vault            # CMD
```

### 🧪 试试示例库

```bash
cp -r examples/demo-vault /tmp/my-vault
cd /tmp/my-vault
node /path/to/DSH-memsys-dist/tools/mem.mjs brief
```

---

## ⌨️ 命令速查

| 命令 | 作用 |
|---|---|
| **`init`** | **在当前目录初始化新库** |
| `brief` | 开场简报（每轮必跑，450 token / 0.3 秒） |
| `index` | 重建目录 |
| `recall "词" --spread` | 检索 + 联想 |
| `activation <path>` | 查单页活化度 |
| `episode` | 写一条经历 |
| `mark <path>` | 标记"用上了"（强化记忆） |
| `mark <P-xxxx> --ok/--fail` | 记录流程实战成败 |
| `refute <path>` | 标为错误结论（权重归零） |
| `supersede <path> --by X` | 标为被取代（降权） |
| `review` | 看待裁决清单 |
| `contradictions` | 扫形式矛盾 |
| `rollback --list` | 看改过哪些 |
| `rollback --all --apply` | 一键撤销 |
| `distill [--apply]` | 蒸馏（夜间） |
| `compact [--apply]` | 压缩（每季） |
| `audit` | 健康检查 |
| `stats` | 统计 |

### 典型工作流

```bash
# ① 开工
memsys brief

# ② 干活中查东西（必须带 --spread，否则只是关键词匹配）
memsys recall "关键词" --spread

# ③ 用了某页，标记它（这会让它未来更容易被想起）
memsys mark "20-决策/ADR-0037-xxx.md"

# ④ 收尾：写一条经历
memsys episode \
  --schema "逆向-ONNX网络重建" \
  --title "掩码网重建对不上" \
  --cues "r值差很多;id120是什么" \
  --outcome partial \
  --lesson "先探针再读图" \
  --trust verified \
  --body-file body.md

# ⑤ 夜间蒸馏（可放定时任务）
memsys distill --apply
```

---

## 🧪 测过什么

| 套件 | 内容 | 结果 |
|---|---|---|
| `test.mjs` | 回归 **80 条断言** | ✅ 全过 |
| `check-wiring.mjs` | 20 字段读写接线 | ✅ 0 断线 |
| `stress.mjs` | 真库压测（只读不污染/幂等/30 查询） | ✅ 0 缺陷 |
| `stress2.mjs` | 脏数据（非法 frontmatter/循环双链/二进制/并发） | ✅ 0 崩溃 |
| `verify-logic.mjs` | 逻辑正确性 19 条（排序/权重/排除） | ✅ 全过 |
| `longrun.mjs` | 长时间模拟 18 条（衰减曲线/阈值边界） | ✅ 全过 |

```bash
# 自己跑一遍
node tools/test.mjs
```

### 规模实测（次线性）

| 页数 | index | recall | spread |
|---|---|---|---|
| 1,000 | 213ms | 207ms | — |
| 2,000 | 340ms | 327ms | 524ms |
| 5,000 | 677ms | 621ms | 1141ms |
| **10,000** | **1154ms** | **1136ms** | **2140ms** |

页数 ×2，耗时 ×1.7~1.9（约 90ms 是 Node 启动固定开销）。
**一万页时联想扩散只要 2.1 秒。**

### 衰减曲线精度

实测与理论公式误差 **0.0000**（1/7/30/90/180/365 天全对）。

---

## ❓ 常见问题

<details>
<summary><b>Windows 下报「0 页」，怎么办？</b></summary>

**这是路径格式问题，不是依赖缺失。**

如果用 Git Bash / MSYS 环境，`/tmp/xxx` 这类路径 Node 在 Windows 下认不出来：

```bash
# ❌ 这样会扫出 0 页
export MEM_VAULT="/tmp/my-vault"

# ✅ 用 Windows 原生路径
export MEM_VAULT="D:/my-vault"
```

同理，库本身也建议放纯英文路径，不要用 `D:/我的文档/库`。

</details>

<details>
<summary><b>一定要用 Obsidian 吗？</b></summary>

不用。只要目录里有 `.md` 文件 + YAML frontmatter 就能跑。
Obsidian 只是让 `[[双链]]` 生效，联想更强。详见[依赖](#-依赖一个装着-markdown-的目录)一节。

</details>

<details>
<summary><b>会动我的笔记正文吗？</b></summary>

不会。系统只在 frontmatter 里加字段：

```yaml
superseded_by: "EP-xxx"
refuted: true
explicit_refute: true
```

正文一个字都不改。所有自动改动都有备份，可用 `rollback` 撤销。

</details>

<details>
<summary><b>数据存在哪？</b></summary>

全部在你的本地目录里。没有数据库、没有云同步、没有外部服务。

只有一个辅助文件：`99-系统/记忆系统/access.log.jsonl`（访问日志，用于计算活化度）。

</details>

<details>
<summary><b>能多人共用吗？</b></summary>

可以，但注意：`access.log.jsonl` 是追加写的，多人并发可能冲突。
建议每人一个库，或用 git 分支隔离。

</details>

---

## 📚 设计依据

<table>
<tr><td width="20%"><b>生物 / 神经</b></td><td>

- 互补学习系统（CLS）— McClelland, McNaughton & O'Reilly (1995)
- Kumaran, Hassabis & McClelland (2016) — 结构化信息可快写皮层
- 灾难性遗忘 — French (1999)，靠交错复现缓解
- 睡眠突触稳态 — Tononi & Cirelli，按比例下调
- 来源监控 — Johnson, Hashtroudi & Lindsay (1993)

</td></tr>
<tr><td><b>认知心理</b></td><td>

- 需求概率 — Anderson & Schooler (1991)
- 编码特异性 — Tulving & Thomson (1973)
- 提取诱发遗忘 — Anderson, Bjork & Bjork (1994)
- 测试效应 — Roediger & Karpicke (2006)

</td></tr>
<tr><td><b>工程</b></td><td>

- MemGPT — Packer et al. (2023)
- The Missing Memory Hierarchy — Mason (2026)
- HippoRAG — Gutiérrez et al. (2024)

</td></tr>
</table>

---

## 🚧 它做不到什么

诚实边界，全部来自实测：

| 能力 | 边界 |
|---|---|
| **自动发现矛盾** | 只能抓形式矛盾（A 说要 X、B 说不要 X），概念层错误抓不到 |
| **自动执行纠错** | 必须靠显式声明。让系统猜哪页该废，用 61 条真实数据实测**误报率 100%** |
| **语义联想** | 靠 token 共现，不是真理解。"卡顿"和"性能差"联不上 |
| **发现语义层错误** | 依赖事先写下 `expectation`。想不起来写就抓不到 |
| **自主成长** | 仍需触发，它不会自己决定"这条值得记" |

---

## 📂 目录结构

```
.
├── tools/
│   ├── mem.mjs                核心引擎（16 个命令）
│   ├── setup.mjs              一键安装到指定目录
│   ├── test.mjs               回归测试（80 条）
│   ├── check-wiring.mjs       字段接线检查
│   ├── stress.mjs             真库压测
│   ├── stress2.mjs            脏数据压测
│   ├── verify-logic.mjs       逻辑正确性
│   ├── longrun.mjs            长时间模拟
│   ├── scale.mjs              极限规模
│   └── （迁移工具若干）
├── examples/
│   └── demo-vault/            最小可用示例
├── README.md
├── package.json
└── LICENSE
```

---

## 🤝 贡献

测试先行。改任何逻辑前，先跑：

```bash
node tools/test.mjs
node tools/verify-logic.mjs
```

两个都绿了再提 PR。

---

<div align="center">

**记忆不是存储更多，是在正确的时候想起正确的事——并且知道哪些该忘。**

<sub>MIT License · 零外部依赖 · Node ≥ 18</sub>

</div>

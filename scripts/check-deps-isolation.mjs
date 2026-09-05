#!/usr/bin/env node
/**
 * 跨仓依赖污染检测（BR-009，自包含、零依赖、只读）。
 *
 * 背景：邻仓（本次是 vibee）把本仓的包 glob 进自己的 pnpm workspace 并用
 * overrides 钉旧版本，在邻仓跑一次 `pnpm install` 就会把本仓
 * `packages/  * /node_modules/@deepseek-ai/*` 改链到邻仓的 store。症状是 tsc 报
 * `Property '[BRAND]' is missing in type 'SessionId' but required in type 'SessionId'`
 * ——两套物理副本的品牌类型互不认账。靠 typecheck 撞品牌错来发现，反馈链太长。
 *
 * 判定口径（关键）：**realpath 是否越出本仓根目录**，不是仓名黑名单。
 * ASM-005 当初只防 `dsh-grok-bot` 这一个名字，vibee 从旁边绕了过去；下一个邻仓
 * 换个名字照样会漏。所以这里只问一句：解析完之后，这个包还在本仓里吗？
 *
 * 检查两件事：
 *   1. 越界：条目 realpath 落到本仓根之外 = 污染（致命）。
 *   2. 版本漂移：解析到的 `@deepseek-ai/dsh*` 版本不是期望版本 = 致命。
 *      `cordis` / `cosmokit` / `schemastery` 等非 dsh 包不纳入版本判定。
 *
 * 两个扫描域的物理结构不同，不要想当然：
 *   - `packages/  * /node_modules/@deepseek-ai/*` 是 pnpm 软链，指向本仓 `.pnpm`。
 *   - `env/profiles/st` 用 `nodeLinker: hoisted`，条目是**真实目录**不是软链。
 *   所以不能用「必须指向 .pnpm」当判据，只能用仓根边界。
 *
 * 用法：node scripts/check-deps-isolation.mjs [--expect <version>] [--verbose]
 * 退出码：0 = 干净；1 = 检出污染 / 版本漂移 / 核心依赖未安装。
 */

import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url))
/** 本仓根目录，先 realpath 一次——否则 /tmp 之类的软链会让边界判断误判。 */
const REPO_ROOT = realpathSync(resolve(SCRIPTS_DIR, '..'))

/** 期望的宿主版本（BR-001）。可用 --expect 或 DSH_EXPECT_VERSION 覆盖，便于以后升版。 */
const DEFAULT_EXPECT = '0.1.2-rc.1'

/** 只对 `@deepseek-ai/dsh*` 判版本；cordis / cosmokit / schemastery 等不判。 */
const VERSION_SCOPE_RE = /^dsh(-|$)/

const argv = process.argv.slice(2)
const verbose = argv.includes('--verbose')
const expectIdx = argv.indexOf('--expect')
const EXPECT = expectIdx >= 0 && argv[expectIdx + 1]
  ? argv[expectIdx + 1]
  : (process.env.DSH_EXPECT_VERSION || DEFAULT_EXPECT)

/**
 * 扫描域。`required` 的域为空 = 依赖没装，判失败（避免「没装 = 干净」的假通过）；
 * 非 required 的域缺失只提示（st profile 要跑 `sh env/setup.sh` 才有）。
 */
const SCOPES = [
  { label: 'packages/*/node_modules/@deepseek-ai', dirs: () => packageScopeDirs(), required: true },
  { label: 'env/profiles/st/node_modules/@deepseek-ai', dirs: () => [join(REPO_ROOT, 'env/profiles/st/node_modules/@deepseek-ai')], required: false },
]

/** @returns {string[]} 每个 workspace 包下的 `@deepseek-ai` 目录。 */
function packageScopeDirs() {
  const packagesDir = join(REPO_ROOT, 'packages')
  if (!existsSync(packagesDir)) return []
  return readdirSync(packagesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => join(packagesDir, e.name, 'node_modules/@deepseek-ai'))
}

/**
 * 求条目的规范路径。普通情况就是 realpath；**悬空软链**（target 已被删）realpath 会
 * ENOENT，此时退化为「最近的存在祖先 realpath + 剩余段」，这样悬空链指向仓外时
 * 依然能被判成越界，而不是因为读不到就漏过去。
 * @param {string} entry
 * @returns {{path: string, dangling: boolean}}
 */
function canonicalize(entry) {
  try {
    return { path: realpathSync(entry), dangling: false }
  } catch {
    // 悬空或不可达：先算出逻辑目标，再尽力规范化其存在的前缀。
    let logical = entry
    try {
      const target = readlinkSync(entry)
      logical = isAbsolute(target) ? target : resolve(dirname(entry), target)
    } catch {
      logical = resolve(entry)
    }
    const rest = []
    let cur = logical
    for (;;) {
      if (existsSync(cur)) {
        try {
          return { path: join(realpathSync(cur), ...rest), dangling: true }
        } catch {
          break
        }
      }
      const parent = dirname(cur)
      if (parent === cur) break
      rest.unshift(cur.slice(parent.length + 1))
      cur = parent
    }
    return { path: logical, dangling: true }
  }
}

/**
 * 路径是否在本仓根之内。空 relative = 就是仓根本身，也算在内。
 * @param {string} p
 */
function insideRepo(p) {
  const rel = relative(REPO_ROOT, p)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** @param {string} title */
function section(title) {
  console.log(`\n── ${title}`)
}

function main() {
  console.log(`跨仓依赖污染检测（BR-009）`)
  console.log(`本仓根：${REPO_ROOT}`)
  console.log(`期望版本：@deepseek-ai/dsh* = ${EXPECT}`)

  /** @type {{entry: string, real: string, version: string, reason: string}[]} */
  const polluted = []
  /** @type {{entry: string, real: string, version: string}[]} */
  const drifted = []
  /** @type {string[]} */
  const warnings = []
  let checked = 0
  let failed = false

  for (const scope of SCOPES) {
    section(scope.label)
    const dirs = scope.dirs().filter((d) => existsSync(d))
    if (dirs.length === 0) {
      if (scope.required) {
        failed = true
        console.log(`✗ 该扫描域为空：依赖尚未安装。先跑 \`pnpm install\` 再检测（空树不算干净）。`)
      } else {
        console.log(`△ 未安装，跳过（需要时跑 \`sh env/setup.sh\`）`)
      }
      continue
    }

    let scopeCount = 0
    for (const dir of dirs) {
      for (const name of readdirSync(dir).sort()) {
        const entry = join(dir, name)
        // 只看包目录/软链本身，忽略 .DS_Store 之类。
        let isDirLike
        try {
          isDirLike = lstatSync(entry).isDirectory() || lstatSync(entry).isSymbolicLink()
        } catch {
          continue
        }
        if (!isDirLike) continue

        scopeCount += 1
        checked += 1
        const { path: real, dangling } = canonicalize(entry)
        const rel = relative(REPO_ROOT, entry)

        // ① 边界判定：越出本仓根 = 污染。这是本脚本的核心口径。
        if (!insideRepo(real)) {
          let version = '未知'
          try {
            version = JSON.parse(readFileSync(join(real, 'package.json'), 'utf8')).version ?? '未知'
          } catch { /* 读不到就保持未知，不影响判定 */ }
          polluted.push({ entry: rel, real, version, reason: dangling ? '越界（且目标已失效）' : '越界' })
          continue
        }

        // ② 仓内但读不到 package.json：多半是历史遗留的悬空软链。不是跨仓污染，
        //    不该让干净树挂掉；但也不能咽掉，提示出来。
        const pkgJson = join(real, 'package.json')
        if (!existsSync(pkgJson)) {
          warnings.push(`${rel} → ${real}（仓内${dangling ? '悬空软链' : '目录'}，无 package.json）`)
          continue
        }

        // ③ 版本漂移：只判 @deepseek-ai/dsh*。
        if (VERSION_SCOPE_RE.test(name)) {
          let version
          try {
            version = JSON.parse(readFileSync(pkgJson, 'utf8')).version
          } catch (e) {
            warnings.push(`${rel}：package.json 解析失败（${e.message}）`)
            continue
          }
          if (version !== EXPECT) {
            drifted.push({ entry: rel, real, version: version ?? '未知' })
            continue
          }
        }

        if (verbose) console.log(`✓ ${rel} → ${real}`)
      }
    }
    console.log(`  扫描 ${scopeCount} 项`)
  }

  if (polluted.length > 0) {
    failed = true
    section(`越界软链（跨仓污染）：${polluted.length} 项`)
    for (const p of polluted) {
      console.log(`✗ ${p.entry}`)
      console.log(`    realpath → ${p.real}`)
      console.log(`    版本 → ${p.version}（${p.reason}）`)
    }
  }

  if (drifted.length > 0) {
    failed = true
    section(`版本漂移：${drifted.length} 项`)
    for (const d of drifted) {
      console.log(`✗ ${d.entry}`)
      console.log(`    realpath → ${d.real}`)
      console.log(`    版本 → ${d.version}（期望 ${EXPECT}）`)
    }
  }

  if (warnings.length > 0) {
    section(`提示（不致命）：${warnings.length} 项`)
    for (const w of warnings) console.log(`△ ${w}`)
  }

  console.log('')
  if (failed) {
    console.log(`结论：检出污染 —— 越界 ${polluted.length} 项、版本漂移 ${drifted.length} 项（共扫描 ${checked} 项）`)
    if (polluted.length > 0 || drifted.length > 0) {
      console.log('')
      console.log('复原命令：')
      console.log('  rm -rf packages/*/node_modules && pnpm install')
      console.log('')
      console.log('成因提示：邻仓若把本仓的包 glob 进自己的 pnpm workspace 并 overrides 钉版本，')
      console.log('在邻仓跑 `pnpm install` 就会改写本仓的 node_modules（ASM-006）。本仓只能检测 + 复原。')
    }
    process.exit(1)
  }

  console.log(`结论：全部通过 —— ${checked} 项 @deepseek-ai/* 全部解析在本仓根内${warnings.length > 0 ? `（另有 ${warnings.length} 条提示）` : ''}`)
  process.exit(0)
}

main()
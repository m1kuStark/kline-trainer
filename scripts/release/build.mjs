#!/usr/bin/env node
// REL-PACK: reproducible Windows portable package builder.
// Contract: docs/engineering/release-m3-contract.md, docs/engineering/release-build.md
//
// Usage (from the repo root):
//   node --import tsx scripts/release/build.mjs --node-archive PATH --node-checksums PATH --out DIR
//
// Builds a production run in an isolated .runs/run-<uuid> directory (createRun/buildRun
// from scripts/runtime/run.ts) so the worktree's web/dist and server/dist are never
// touched, then assembles an allowlisted staging tree, hashes it into
// release-manifest.json, and zips it as kline-trainer-v<version>-windows-x64.zip.

import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { access, copyFile, link, lstat, mkdir, open, readdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const exec = promisify(execFile)

const APP_ID = 'a-share-kline-trainer'
const NODE_MAJOR_REQUIRED = 24
const NODE_ARCHIVE_PATTERN = /^node-v(\d+)\.(\d+)\.(\d+)-win-x64\.zip$/

// Files the package root must contain. Launcher files, trainer.ico, the user docs
// surface (docs/user, CONTRIBUTING.md, SECURITY.md, third-party/) are owned by other
// REL workers/root and are expected to exist at package time; the preflight reports
// every missing input at once instead of failing mid-copy.
const REQUIRED_INPUTS = [
  'package.json',
  'package-lock.json',
  'server/src/index.ts',
  'web/index.html',
  'LICENSE',
  'THIRD-PARTY-NOTICES.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'third-party',
  'README.md',
  'assets/trainer.ico',
  'scripts/release/launcher.cjs',
  'scripts/release/Start.cmd',
  'scripts/release/Stop.cmd',
  'scripts/release/Create Shortcut.cmd',
  'scripts/release/create-shortcut.ps1',
  'scripts/release/trainer.config.example.json',
  'docs/user',
]

// Exact-name staging entries; anything else must fall under a directory allowlist.
// CONTRIBUTING.md/SECURITY.md are staged because the package README links them at
// package-root level, matching the repository layout.
const ROOT_FILES = ['LICENSE', 'THIRD-PARTY-NOTICES.md', 'CONTRIBUTING.md', 'SECURITY.md', 'README.md', 'package.json']
const LAUNCHER_FILES = ['launcher.cjs', 'Start.cmd', 'Stop.cmd', 'Create Shortcut.cmd', 'create-shortcut.ps1', 'trainer.config.example.json']

// Journey test hooks are stripped by the production vite build; this marker is the
// runtime object only the `--mode journey` branch assigns on window.
const JOURNEY_MARKER = '__trainerChart'

export const HELP_TEXT = `Build the Windows x64 portable release package.

Usage:
  node --import tsx scripts/release/build.mjs --node-archive PATH --node-checksums PATH --out DIR

Required:
  --node-archive PATH   Official Node.js archive (node-v24.x.y-win-x64.zip), pre-downloaded.
  --node-checksums PATH Matching official SHASUMS256.txt.
  --out DIR             Output directory for the .zip and SHA256SUMS (may be outside the repo).

Behavior:
  - Verifies the archive SHA256 against SHASUMS256.txt by exact filename before anything else.
  - Requires a clean worktree at a valid git commit, and revalidates the same HEAD +
    clean status after staging, before anything is compressed or published; builds
    server/web in an isolated .runs/run-<uuid> directory, never writing the worktree's
    dist/ or any user database.
  - Installs production node_modules in isolation (npm ci --omit=dev --ignore-scripts).
  - Reserves the output name with an exclusive, non-waiting lock file in --out; publishes
    the .zip and SHA256SUMS by exclusive creation (no-clobber). Existing outputs are never
    overwritten or deleted and nothing under --out is ever removed recursively; a failed
    run leaves its uniquely named .partial files behind as evidence.
  - Writes <out>/kline-trainer-v<version>-windows-x64.zip plus SHA256SUMS.
  - release-manifest.json (per-file SHA256) ships inside the package.`

/** Parse CLI arguments; returns { help } or { nodeArchive, nodeChecksums, out }. */
export function parseArgs(argv) {
  const values = new Map()
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (flag === '--help' || flag === '-h') return { help: true }
    if (!flag.startsWith('--')) throw new Error(`Unexpected argument: ${flag}`)
    if (values.has(flag)) throw new Error(`Duplicate flag: ${flag}`)
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for ${flag}`)
    values.set(flag, value)
    i++
  }
  for (const flag of ['--node-archive', '--node-checksums', '--out']) {
    if (!values.has(flag)) throw new Error(`Missing required flag: ${flag}\n\n${HELP_TEXT}`)
  }
  return { nodeArchive: resolve(values.get('--node-archive')), nodeChecksums: resolve(values.get('--node-checksums')), out: resolve(values.get('--out')) }
}

/** Extract the version from an official archive filename; only Node 24 win-x64 is allowed. */
export function parseNodeArchiveName(fileName) {
  const match = NODE_ARCHIVE_PATTERN.exec(fileName)
  if (!match) {
    throw new Error(`Expected an official Node ${NODE_MAJOR_REQUIRED} win-x64 archive named node-v${NODE_MAJOR_REQUIRED}.x.y-win-x64.zip, got: ${fileName}`)
  }
  const major = Number(match[1])
  if (major !== NODE_MAJOR_REQUIRED) {
    throw new Error(`Release is pinned to Node ${NODE_MAJOR_REQUIRED}.x; archive declares v${match[1]}.${match[2]}.${match[3]}: ${fileName}`)
  }
  return { version: `${match[1]}.${match[2]}.${match[3]}`, major }
}

/** SHA256 of a file, streamed so multi-hundred-MB artifacts stay cheap. */
export async function sha256File(path) {
  const { createReadStream } = await import('node:fs')
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

/**
 * Verify the archive against SHASUMS256.txt content by exact filename.
 * Performs verification only — it never extracts — so a tampered archive is
 * rejected before any extraction can run.
 */
export async function verifyNodeArchive(archivePath, checksumsText) {
  const fileName = basename(archivePath)
  const expected = expectedChecksumLine(checksumsText, fileName)
  const actual = await sha256File(archivePath)
  if (actual !== expected) {
    throw new Error(`Node archive checksum mismatch for ${fileName}: expected ${expected}, got ${actual}. The archive is not used.`)
  }
  return expected
}

/** Look up the SHA256 for exactly this filename in SHASUMS256.txt content. */
export function expectedChecksumLine(checksumsText, fileName) {
  const found = new Map()
  for (const line of checksumsText.split(/\r?\n/)) {
    const match = /^([0-9a-fA-F]{64})[ \t]+\*?(.+)$/.exec(line.trim())
    if (match && match[2] === fileName) found.set(match[1].toLowerCase(), match[2])
  }
  if (found.size === 0) {
    throw new Error(`Checksum file does not list ${fileName}; refusing to use an unverifiable archive`)
  }
  if (found.size > 1) throw new Error(`Checksum file lists ${fileName} more than once with different digests`)
  return [...found.keys()][0]
}

/** Reject a dirty worktree or an unusable HEAD commit sha. */
export function assertCleanWorktree(statusText, headSha) {
  if (!/^[0-9a-f]{40,64}$/.test(headSha ?? '')) throw new Error(`HEAD is not a valid git commit sha: ${headSha}`)
  const dirty = statusText.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  if (dirty.length) {
    throw new Error(`Worktree must be clean to build a release; ${dirty.length} changed/untracked entr${dirty.length === 1 ? 'y' : 'ies'}:\n${dirty.slice(0, 10).join('\n')}`)
  }
}

/**
 * Revalidate, after staging and before compression/publication, that the source tree
 * is still the exact clean commit the build started from. A checkout, reset or edit
 * while the build runs must abort instead of publishing artifacts mixing two sources.
 */
export function assertUnchangedSource(startHeadSha, currentHeadSha, statusText) {
  if (startHeadSha !== currentHeadSha) {
    throw new Error(`HEAD moved during the build: started at ${startHeadSha}, now at ${currentHeadSha}. Refusing to publish artifacts from a changed source.`)
  }
  try {
    assertCleanWorktree(statusText, currentHeadSha)
  } catch (error) {
    throw new Error(`Worktree changed while the build was running; refusing to publish.\n${error instanceof Error ? error.message : error}`)
  }
}

/** Refuse to overwrite existing release outputs; callers must never delete under out. */
export async function assertFreshOutputs(outDir, artifactName) {
  const clashes = []
  for (const name of [`${artifactName}.zip`, 'SHA256SUMS']) {
    const path = join(outDir, name)
    try { await access(path); clashes.push(path) } catch (error) {
      if ((error ?? {}).code !== 'ENOENT') throw error
    }
  }
  if (clashes.length) {
    throw new Error(`Release outputs already exist (existing releases are never overwritten or deleted):\n${clashes.join('\n')}`)
  }
}

/**
 * Exclusive, bounded reservation of one artifact name inside outDir: creates the lock
 * file with flag 'wx', so a second build fails immediately instead of waiting or
 * stealing. The lock payload records the owner so a stale lock is diagnosable.
 */
export async function reserveOutputs(outDir, artifactName, ownerId = randomUUID()) {
  const lockPath = join(outDir, `.${artifactName}.build.lock`)
  const payload = JSON.stringify({ artifactName, ownerId, pid: process.pid, createdAt: new Date().toISOString() }) + '\n'
  let handle
  try {
    handle = await open(lockPath, 'wx')
  } catch (error) {
    if ((error ?? {}).code === 'EEXIST') {
      let holder = 'unreadable'
      try { holder = (await readFile(lockPath, 'utf8')).trim() } catch { /* keep fallback */ }
      throw new Error(`Another build already reserved ${outDir} for ${artifactName}; refusing to wait or to steal the lock.\nlock: ${lockPath}\nheld by: ${holder}`)
    }
    throw error
  }
  try { await handle.writeFile(payload) } finally { await handle.close() }
  return { lockPath, ownerId }
}

/**
 * Release exactly the reservation this build created. If the lock file no longer holds
 * our ownerId it was replaced by someone else; it is left untouched, never stolen.
 */
export async function releaseOutputs(reservation) {
  let content
  try { content = await readFile(reservation.lockPath, 'utf8') } catch { return }
  let parsed
  try { parsed = JSON.parse(content) } catch { parsed = null }
  if ((parsed ?? {}).ownerId !== reservation.ownerId) {
    console.error(`Lock ${reservation.lockPath} no longer holds this build's reservation; leaving it untouched.`)
    return
  }
  await unlink(reservation.lockPath)
}

/**
 * Publish one file into the release output directory without any possibility of
 * clobbering: the content lands in a uniquely named .partial sibling, then a hard
 * link() creates the final name exclusively (fails with EEXIST if it exists). The
 * preexisting target is never replaced or deleted; on refusal or failure the .partial
 * file of this attempt stays behind as diagnosable evidence.
 */
export async function publishFileExclusive(sourcePath, destPath) {
  const tempPath = `${destPath}.${randomUUID()}.partial`
  await copyFile(sourcePath, tempPath)
  try {
    await link(tempPath, destPath)
  } catch (error) {
    if ((error ?? {}).code === 'EEXIST') {
      throw new Error(`Refusing to overwrite existing release output: ${destPath} (existing releases are never overwritten or deleted; this attempt's partial file remains: ${tempPath})`)
    }
    throw error
  }
  await unlink(tempPath)
  return destPath
}

/**
 * Normalize a zip entry name to a safe relative path.
 * Rejects traversal, absolute paths, drive letters and backslash separators.
 */
export function safeArchiveEntryName(entryName) {
  if (entryName.includes('\\')) throw new Error(`Unsafe archive entry (backslash separator): ${entryName}`)
  if (isAbsolute(entryName) || /^[a-zA-Z]:/.test(entryName)) throw new Error(`Unsafe archive entry (absolute path): ${entryName}`)
  const segments = entryName.split('/')
  if (segments.some(segment => segment === '..' || segment === '')) {
    throw new Error(`Unsafe archive entry (traversal or empty segment): ${entryName}`)
  }
  return segments.join('/')
}

/**
 * Allowlist classifier for staged package paths (forward slashes, relative to the
 * package root). Returns the allowlist bucket, null when the path must be excluded,
 * and throws on private/sensitive names that must never reach a public ZIP.
 */
export function classifyStagedPath(relPath) {
  const normalized = relPath.split(sep).join('/').replace(/\/+$/, '')
  if (!normalized) throw new Error('Cannot classify an empty package path')
  const segments = normalized.split('/')
  const denied = segments.some(segment => segment === '.git' || segment === '.runs' || /^\.env(\.|$)/.test(segment))
    || segments.includes('trainer.config.json')
    || segments.some(segment => segment === 'trainer.sqlite' || segment.startsWith('trainer.sqlite-'))
  if (denied) throw new Error(`Refusing to package a private/sensitive path: ${normalized}`)
  if (segments[0] === 'node_modules') return 'node_modules'
  if (segments[0] === 'docs') return 'docs'
  if (segments[0] === 'third-party') return 'third-party'
  if (segments[0] === 'web' && segments[1] === 'dist') return 'web'
  if (segments[0] === 'server' && segments[1] === 'dist') {
    const file = segments[segments.length - 1]
    return segments.length > 2 && file.endsWith('.js') ? 'server' : null
  }
  if (normalized === 'runtime/node.exe' || normalized === 'runtime/LICENSE') return 'runtime'
  if (normalized === 'assets/trainer.ico') return 'assets'
  if (ROOT_FILES.includes(normalized) || LAUNCHER_FILES.includes(normalized) || normalized === 'release.json' || normalized === 'release-manifest.json') return 'root'
  return null
}

/** Marker scan proving production assets carry no journey test hooks. */
export function containsJourneyMarkers(text) {
  return text.includes(JOURNEY_MARKER)
}

/** List required release inputs missing from the worktree (all of them, at once). */
export async function missingReleaseInputs(root) {
  const missing = []
  for (const input of REQUIRED_INPUTS) {
    try { await access(join(root, input)) } catch { missing.push(input) }
  }
  return missing
}

/** Files below `directory`, depth-first in deterministic order; symlinks are refused. */
async function walkFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  entries.sort((a, b) => a.name.localeCompare(b.name))
  const files = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isSymbolicLink()) throw new Error(`Unexpected symlink in packaged tree: ${path}`)
    if (entry.isDirectory()) files.push(...await walkFiles(path))
    else if (entry.isFile()) files.push(path)
  }
  return files
}

async function stageFile(stagingRoot, absoluteSource, relDest) {
  const normalized = relDest.split(sep).join('/')
  const bucket = classifyStagedPath(normalized)
  if (!bucket) throw new Error(`Internal error: staging operation produced a non-allowlisted path: ${normalized}`)
  const target = join(stagingRoot, ...normalized.split('/'))
  await mkdir(dirname(target), { recursive: true })
  await copyFile(absoluteSource, target)
}

/** Copy a directory tree into staging under `relPrefix`, applying an include filter. */
async function stageTree(stagingRoot, sourceRoot, relPrefix, include) {
  for (const source of await walkFiles(sourceRoot)) {
    const rel = relative(sourceRoot, source).split(sep).join('/')
    if (include && !include(rel)) continue
    await stageFile(stagingRoot, source, `${relPrefix}/${rel}`)
  }
}

/**
 * Stage the package's user-facing documentation and license surface, keeping the
 * repository's exact relative layout so the shipped markdown links resolve:
 * - docs/user/** stays at docs/user/** (package README links docs/user/..., and
 *   docs/user/install.md links ../../CONTRIBUTING.md); flattening it to docs/ breaks both.
 * - CONTRIBUTING.md and SECURITY.md land at the package root, where the README links them.
 * - third-party/** (complete notices/inventory, linked from THIRD-PARTY-NOTICES.md)
 *   is staged in full.
 */
export async function stageUserDocsAndNotices(stagingRoot, repoRoot) {
  await stageTree(stagingRoot, join(repoRoot, 'docs/user'), 'docs/user')
  await stageTree(stagingRoot, join(repoRoot, 'third-party'), 'third-party')
  for (const name of ['CONTRIBUTING.md', 'SECURITY.md']) {
    await stageFile(stagingRoot, join(repoRoot, name), name)
  }
}

// Inline markdown links only; reference-style definitions, anchors and external URLs
// are not resolvable inside the package and are skipped.
const MD_INLINE_LINK = /\[[^\]]*\]\(([^)\s]+)\)/g

/** Resolve one markdown link target against the file that contains it. */
function resolveMarkdownLink(baseAbsPath, target) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#')) return null
  const pathPart = target.split('#')[0]
  if (!pathPart) return null
  let decoded = pathPart
  try { decoded = decodeURIComponent(pathPart) } catch { /* keep raw */ }
  return resolve(dirname(baseAbsPath), decoded)
}

/**
 * Return the relative markdown links in `mdFiles` whose target does not exist inside
 * the staged package. This is the build-time gate that keeps the docs/user hierarchy,
 * root CONTRIBUTING/SECURITY and the third-party notices tree internally consistent;
 * it checks links between staged files only (no network, no anchors) and treats a
 * target that resolves outside the staging root as broken — the package must be
 * self-contained.
 */
export async function findBrokenPackageLinks(stagingRoot, mdFiles) {
  const broken = []
  for (const file of mdFiles) {
    const rel = relative(stagingRoot, file).split(sep).join('/')
    const text = await readFile(file, 'utf8')
    for (const match of text.matchAll(MD_INLINE_LINK)) {
      const resolved = resolveMarkdownLink(file, match[1])
      if (!resolved) continue
      const relToRoot = relative(stagingRoot, resolved)
      if (!relToRoot || relToRoot.startsWith('..') || isAbsolute(relToRoot)) {
        broken.push(`${rel} -> ${match[1]} (outside the package)`)
        continue
      }
      try { await access(resolved) } catch {
        broken.push(`${rel} -> ${match[1]}`)
      }
    }
  }
  return broken
}

// Compress-Archive/Expand-Archive are driven through a structured-argv PowerShell
// invocation (no shell string) — no extra ZIP dependency is added for this.
// -LiteralPath (not -Path) so wildcard characters in staging/out paths are never
// interpreted as globs, and $ErrorActionPreference='Stop' so a failed cmdlet is a
// terminating error instead of a silent exit 0 with no archive written.
export const PACKAGE_PS1 = [
  'param([string]$Mode, [string]$Source, [string]$Destination)',
  "$ErrorActionPreference = 'Stop'",
  "if ($Mode -eq 'extract') { Expand-Archive -LiteralPath $Source -DestinationPath $Destination }",
  "elseif ($Mode -eq 'compress') { Compress-Archive -LiteralPath $Source -DestinationPath $Destination -CompressionLevel Optimal }",
  'else { throw "Unknown mode: $Mode" }',
].join('\r\n')

export async function runPowerShellScript(scriptPath, args) {
  await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...args], { windowsHide: true, maxBuffer: 32 * 1024 * 1024 })
}

async function resolveNpmCli() {
  const candidate = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  try { await access(candidate) } catch {
    throw new Error(`npm CLI not found next to the running Node (${candidate}). Run the build with an official Node ${NODE_MAJOR_REQUIRED}+ install.`)
  }
  return candidate
}

async function git(root, args) {
  const { stdout } = await exec('git', args, { cwd: root, windowsHide: true, maxBuffer: 16 * 1024 * 1024 })
  return stdout
}

export async function main(argv = process.argv.slice(2)) {
  const parsed = parseArgs(argv)
  if (parsed.help) { console.log(HELP_TEXT); return }
  // scripts/release/build.mjs -> repo root
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
  return runBuild(parsed, repoRoot)
}

async function runBuild(parsed, repoRoot) {
  const { nodeArchive, nodeChecksums, out } = parsed
  const pkg = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'))
  const version = pkg.version
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`package.json has no usable version: ${version}`)
  const artifactName = `kline-trainer-v${version}-windows-x64`

  const [statusText, headSha] = await Promise.all([
    git(repoRoot, ['status', '--porcelain']),
    git(repoRoot, ['rev-parse', 'HEAD']).then(text => text.trim()),
  ])
  assertCleanWorktree(statusText, headSha)

  await access(nodeArchive).catch(() => { throw new Error(`Node archive not found: ${nodeArchive}`) })
  await access(nodeChecksums).catch(() => { throw new Error(`Node checksums file not found: ${nodeChecksums}`) })
  const { version: nodeVersion } = parseNodeArchiveName(basename(nodeArchive))
  await verifyNodeArchive(nodeArchive, await readFile(nodeChecksums, 'utf8'))
  console.log(`Node archive verified against SHASUMS256.txt: ${basename(nodeArchive)} (v${nodeVersion})`)

  const missing = await missingReleaseInputs(repoRoot)
  if (missing.length) {
    throw new Error(`Missing release inputs (owned by REL-LAUNCH/REL-DOC/root; expected at package time):\n${missing.join('\n')}`)
  }

  await assertFreshOutputs(out, artifactName)
  await mkdir(out, { recursive: true })
  const reservation = await reserveOutputs(out, artifactName)
  try {
    return await buildAndPublish(repoRoot, { nodeArchive, nodeChecksums, artifactName, version, headSha, nodeVersion, out, pkg })
  } finally {
    await releaseOutputs(reservation)
  }
}

async function buildAndPublish(repoRoot, { nodeArchive, nodeChecksums, artifactName, version, headSha, nodeVersion, out, pkg }) {

  // Isolated production build run: server/web land under .runs/run-<uuid>, so the
  // worktree's web/dist, server/dist and any user database are never touched.
  const { createRun, buildRun } = await import('../runtime/run.ts').catch(error => {
    throw new Error(`Loading scripts/runtime/run.ts requires the tsx loader; run: node --import tsx scripts/release/build.mjs ... (${error instanceof Error ? error.message : error})`)
  })
  const run = await createRun(repoRoot, 'verify')
  console.log(`Build run (isolated): ${run.runDir}`)
  try {
    await buildRun(run, 'production')

    // Production node_modules in isolation: copied lock/package, no scripts, no audit.
    const prodDir = join(run.runDir, 'prod-deps')
    await mkdir(prodDir, { recursive: true })
    await copyFile(join(repoRoot, 'package.json'), join(prodDir, 'package.json'))
    await copyFile(join(repoRoot, 'package-lock.json'), join(prodDir, 'package-lock.json'))
    const npmCli = await resolveNpmCli()
    console.log('Installing production node_modules (npm ci --omit=dev --ignore-scripts)...')
    try {
      await exec(process.execPath, [npmCli, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'],
        { cwd: prodDir, windowsHide: true, maxBuffer: 64 * 1024 * 1024 })
    } catch (error) {
      const tail = String(error.stderr ?? error.message ?? '').split(/\r?\n/).slice(-30).join('\n')
      throw new Error(`npm ci for production modules failed:\n${tail}`)
    }

    // Extract the verified archive with Expand-Archive, then copy only the two
    // allowlisted runtime files. safeArchiveEntryName validates only these two fixed
    // path strings we build ourselves — it is not a per-entry ZIP parser, and the
    // actual trust boundary is the SHA256 verification of the official archive that
    // already happened before any extraction.
    const archiveExtractDir = join(run.runDir, 'node-archive')
    const ps1Path = join(run.runDir, 'package-tools.ps1')
    await writeFile(ps1Path, PACKAGE_PS1, 'utf8')
    console.log('Extracting verified Node runtime archive...')
    await runPowerShellScript(ps1Path, ['-Mode', 'extract', '-Source', nodeArchive, '-Destination', archiveExtractDir])
    const archivePrefix = basename(nodeArchive).replace(/\.zip$/, '')
    const runtimeNode = join(archiveExtractDir, safeArchiveEntryName(`${archivePrefix}/node.exe`))
    const runtimeLicense = join(archiveExtractDir, safeArchiveEntryName(`${archivePrefix}/LICENSE`))
    for (const path of [runtimeNode, runtimeLicense]) {
      await access(path).catch(() => { throw new Error(`Verified archive is missing expected layout entry: ${path}`) })
    }

    const stagingRoot = join(run.runDir, 'package')
    const staging = join(stagingRoot, artifactName)
    await mkdir(staging, { recursive: true })

    await stageFile(staging, runtimeNode, 'runtime/node.exe')
    await stageFile(staging, runtimeLicense, 'runtime/LICENSE')
    await stageFile(staging, join(repoRoot, 'assets/trainer.ico'), 'assets/trainer.ico')
    for (const name of ROOT_FILES) await stageFile(staging, join(repoRoot, name), name)
    for (const name of LAUNCHER_FILES) await stageFile(staging, join(repoRoot, 'scripts/release', name), name)
    // Compiled server JS only: the tsconfig emits declarations/maps the package does not need.
    await stageTree(staging, run.serverDir, 'server/dist', rel => rel.endsWith('.js'))
    await stageTree(staging, run.webDir, 'web/dist')
    await stageTree(staging, join(prodDir, 'node_modules'), 'node_modules')
    // Exact docs/user hierarchy + root CONTRIBUTING/SECURITY + third-party notices tree,
    // so the packaged markdown's relative links resolve inside the package.
    await stageUserDocsAndNotices(staging, repoRoot)

    // Trimmed root manifest: type/module resolution and version metadata only.
    await writeFile(join(staging, 'package.json'), JSON.stringify({
      name: pkg.name, version: pkg.version, private: true, type: pkg.type,
      engines: pkg.engines, dependencies: pkg.dependencies, license: pkg.license,
    }, null, 2) + '\n')

    const releaseJson = {
      appId: APP_ID, version, gitCommit: headSha, nodeVersion,
      platform: 'win32', arch: 'x64',
      publicURL: String(pkg.repository?.url ?? '').replace(/\.git$/, '') || undefined,
    }
    await writeFile(join(staging, 'release.json'), JSON.stringify(releaseJson, null, 2) + '\n')

    // Production-assets gate: journey hooks must not survive into the shipped web build.
    for (const file of await walkFiles(join(staging, 'web/dist'))) {
      if (containsJourneyMarkers(await readFile(file, 'utf8'))) {
        throw new Error(`Journey test hook found in production web assets: ${file}. Build is not releasable.`)
      }
    }

    // Link gate: every relative markdown link on the packaged doc surface (README,
    // CONTRIBUTING, SECURITY, THIRD-PARTY-NOTICES, docs/user/**) must resolve to a
    // staged file. Catches a flattened docs/user tree or a missing license sibling
    // before the archive is written.
    const docFiles = []
    for (const name of ['README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'THIRD-PARTY-NOTICES.md']) docFiles.push(join(staging, name))
    for (const file of await walkFiles(join(staging, 'docs'))) {
      if (file.endsWith('.md')) docFiles.push(file)
    }
    const brokenLinks = await findBrokenPackageLinks(staging, docFiles)
    if (brokenLinks.length) {
      throw new Error(`Packaged documentation has broken relative links (docs/user hierarchy, CONTRIBUTING/SECURITY and third-party must be staged complete):\n${brokenLinks.join('\n')}`)
    }

    // Source revalidation: the staging above was assembled from the worktree, so before
    // anything is compressed or published, require the exact same clean HEAD as at start.
    const [endStatus, endSha] = await Promise.all([
      git(repoRoot, ['status', '--porcelain']),
      git(repoRoot, ['rev-parse', 'HEAD']).then(text => text.trim()),
    ])
    assertUnchangedSource(headSha, endSha, endStatus)

    // Final gate over the actual ZIP payload: every staged file must classify under
    // the allowlist; private paths throw before the archive is written.
    const files = []
    for (const file of await walkFiles(staging)) {
      const rel = relative(staging, file).split(sep).join('/')
      const bucket = classifyStagedPath(rel)
      if (!bucket) throw new Error(`Internal error: non-allowlisted file reached staging: ${rel}`)
      files.push({ path: rel, sha256: await sha256File(file), bytes: (await lstat(file)).size })
    }
    files.sort((a, b) => a.path.localeCompare(b.path))
    const manifest = {
      schemaVersion: 1, appId: APP_ID, version, gitCommit: headSha, nodeVersion,
      platform: 'win32', arch: 'x64', createdAt: new Date().toISOString(),
      files,
    }
    await writeFile(join(staging, 'release-manifest.json'), JSON.stringify(manifest, null, 2) + '\n')

    const stagingZip = join(stagingRoot, `${artifactName}.zip`)
    console.log('Compressing package (Compress-Archive)...')
    await runPowerShellScript(ps1Path, ['-Mode', 'compress', '-Source', staging, '-Destination', stagingZip])
    const zipSha = await sha256File(stagingZip)

    // Exclusive, no-clobber publication: both artifacts are created by exclusive
    // hard link from unique .partial siblings, so a parallel build or a preexisting
    // release can never be replaced; failures leave this run's .partial files behind.
    const zipDest = join(out, `${artifactName}.zip`)
    const sumsStaging = join(stagingRoot, 'SHA256SUMS')
    await writeFile(sumsStaging, `${zipSha}  ${artifactName}.zip\n`)
    await publishFileExclusive(stagingZip, zipDest)
    await publishFileExclusive(sumsStaging, join(out, 'SHA256SUMS'))

    console.log(`Release package built:
  zip:        ${zipDest}
  sha256:     ${zipSha}
  checksums:  ${join(out, 'SHA256SUMS')}
  manifest:   release-manifest.json (inside the zip)
  node:       v${nodeVersion}
  commit:     ${headSha}
  run evidence (retain for verification): ${run.runDir}`)
    return { zip: zipDest, zipSha, runDir: run.runDir, artifactName }
  } catch (error) {
    console.error(`Build failed; isolated run evidence retained: ${run.runDir}`)
    throw error
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}

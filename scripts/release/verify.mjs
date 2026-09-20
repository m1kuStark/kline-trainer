// Read-only inspector for an extracted portable release package.
// It proves the package is internally consistent with its own manifest; it does
// not prove the publisher's identity or replace real Windows startup checks.

import { createHash } from 'node:crypto'
import { createReadStream, existsSync, realpathSync } from 'node:fs'
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const APP_ID = 'a-share-kline-trainer'
const NODE_MAJOR = 24
const METADATA_FILE = 'release.json'
const MANIFEST_FILE = 'release-manifest.json'

const REQUIRED_FILES = [
  'package.json',
  'runtime/node.exe', 'runtime/LICENSE',
  'server/dist/index.js', 'web/dist/index.html',
  'launcher.cjs', 'Start.cmd', 'Stop.cmd', 'Create Shortcut.cmd', 'create-shortcut.ps1',
  'trainer.config.example.json', 'assets/trainer.ico',
  'LICENSE', 'THIRD-PARTY-NOTICES.md', 'README.md', 'CONTRIBUTING.md', 'SECURITY.md',
  'third-party/dependencies.json',
  'docs/user/README.md', 'docs/user/install.md', 'docs/user/recording.md', 'docs/user/troubleshooting.md',
]

const PRIVATE_NAMES = new Set(['.git', '.runs', '.env', 'trainer.config.json'])
const PRIVATE_FILE = /^\.env(\..+)?$|\.db(?:-wal|-shm)?$|\.sqlite(?:-wal|-shm)?$/i

const VERSION_SHAPE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/
const COMMIT_SHAPE = /^[0-9a-f]{40}$/i
const SHA256_SHAPE = /^[0-9a-f]{64}$/i

function describe(err, root) {
  const text = err instanceof Error ? err.message : String(err)
  const windowsRoot = root.split(sep).join('\\') === root ? root : root.split('/').join('\\')
  return text.split(root).join('<package>').split(windowsRoot).join('<package>')
}

function formatError(error) {
  return error.path ? `[${error.code}] ${error.path} — ${error.message}` : `[${error.code}] ${error.message}`
}

async function walkPackage(root) {
  const files = new Map()
  const dirs = new Set()
  const rejected = new Set()
  const errors = []
  async function visit(prefix) {
    let entries
    try {
      entries = await readdir(prefix ? join(root, prefix) : root, { withFileTypes: true })
    } catch (err) {
      errors.push({ code: 'unreadable', path: prefix || '.', message: describe(err, root) })
      return
    }
    for (const entry of entries) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name
      // Never descend through links: a reparse point could swap package content
      // for anything on the machine without the manifest noticing.
      if (entry.isSymbolicLink()) {
        errors.push({ code: 'symlink', path, message: 'Symlinks and reparse points are not allowed in the package' })
        rejected.add(path)
        continue
      }
      if (entry.isDirectory()) {
        dirs.add(path)
        await visit(path)
        continue
      }
      if (entry.isFile()) {
        files.set(path, true)
        continue
      }
      errors.push({ code: 'unknown-entry', path, message: 'Entry is neither a regular file nor a directory' })
      rejected.add(path)
    }
  }
  await visit('')
  return { files, dirs, rejected, errors }
}

function hashFile(absolutePath) {
  return new Promise((resolvePromise, rejectPromise) => {
    const hash = createHash('sha256')
    let bytes = 0
    const stream = createReadStream(absolutePath)
    stream.on('data', chunk => { hash.update(chunk); bytes += chunk.length })
    stream.on('error', rejectPromise)
    stream.on('end', () => resolvePromise({ sha256: hash.digest('hex'), bytes }))
  })
}

async function readJson(root, name, code, errors) {
  let text
  try {
    text = await readFile(join(root, ...name.split('/')), 'utf8')
  } catch (err) {
    errors.push({ code, path: name, message: `Cannot read file: ${describe(err, root)}` })
    return null
  }
  try {
    return JSON.parse(text)
  } catch (err) {
    errors.push({ code, path: name, message: `Not valid JSON: ${describe(err, root)}` })
    return null
  }
}

// Validates the identity fields shared by release.json and release-manifest.json.
function validateIdentity(value, path, code, errors) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push({ code, path, message: 'Expected a JSON object' })
    return null
  }
  let ok = true
  const fail = message => { errors.push({ code, path, message }); ok = false }
  if (typeof value.appId !== 'string' || value.appId !== APP_ID) fail(`appId must be "${APP_ID}"`)
  if (typeof value.version !== 'string' || !VERSION_SHAPE.test(value.version)) fail('version must be a semver string like 0.3.0')
  if (typeof value.gitCommit !== 'string' || !COMMIT_SHAPE.test(value.gitCommit)) fail('gitCommit must be a 40-hex commit SHA')
  if (typeof value.nodeVersion !== 'string' || !/^v?\d+(?:\.\d+)*$/.test(value.nodeVersion)) {
    fail('nodeVersion must be a version string like 24.15.0')
  } else if (Number.parseInt(/^v?(\d+)/.exec(value.nodeVersion)[1], 10) !== NODE_MAJOR) {
    fail(`nodeVersion must be a Node ${NODE_MAJOR} runtime version`)
  }
  if (value.platform !== 'win32') fail('platform must be "win32"')
  if (value.arch !== 'x64') fail('arch must be "x64"')
  return ok ? {
    appId: value.appId,
    version: value.version,
    gitCommit: value.gitCommit.toLowerCase(),
    nodeVersion: value.nodeVersion,
    platform: value.platform,
    arch: value.arch,
  } : null
}

function validateManifest(value, errors) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push({ code: 'manifest', path: MANIFEST_FILE, message: 'Expected a JSON object' })
    return null
  }
  if (value.schemaVersion !== 1) {
    errors.push({ code: 'manifest', path: MANIFEST_FILE, message: 'schemaVersion must be 1' })
  }
  if (typeof value.createdAt !== 'string' || Number.isNaN(Date.parse(value.createdAt))) {
    errors.push({ code: 'manifest', path: MANIFEST_FILE, message: 'createdAt must be an ISO date string' })
  }
  const identity = validateIdentity(value, MANIFEST_FILE, 'manifest', errors)
  if (!Array.isArray(value.files)) {
    errors.push({ code: 'manifest', path: MANIFEST_FILE, message: 'files must be an array' })
    return null
  }
  const listed = new Map()
  for (const entry of value.files) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push({ code: 'manifest', path: MANIFEST_FILE, message: 'Every files entry must be an object' })
      continue
    }
    const path = entry.path
    if (!isSafeManifestPath(path)) {
      errors.push({ code: 'unsafe-path', path: typeof path === 'string' ? path : String(path), message: 'Manifest paths must be relative forward-slash paths without ".", ".." or backslashes' })
      continue
    }
    if (typeof entry.sha256 !== 'string' || !SHA256_SHAPE.test(entry.sha256)) {
      errors.push({ code: 'manifest', path, message: 'sha256 must be a 64-hex digest' })
      continue
    }
    if (!Number.isInteger(entry.bytes) || entry.bytes < 0) {
      errors.push({ code: 'manifest', path, message: 'bytes must be a non-negative integer' })
      continue
    }
    if (listed.has(path)) {
      errors.push({ code: 'duplicate-path', path, message: 'Path is listed twice in the manifest' })
      continue
    }
    listed.set(path, { sha256: entry.sha256.toLowerCase(), bytes: entry.bytes })
  }
  return { identity, listed }
}

function isSafeManifestPath(path) {
  if (typeof path !== 'string' || path.length === 0) return false
  if (path.includes('\\')) return false
  if (isAbsolute(path)) return false
  if (/^[A-Za-z]:/.test(path)) return false
  return !path.split('/').some(part => part.length === 0 || part === '.' || part === '..')
}

function extractLocalLinkTargets(markdown) {
  const targets = []
  const pattern = /\[[^\]]*\]\(([^)]*)\)/g
  let match
  while ((match = pattern.exec(markdown))) {
    let target = match[1].trim()
    if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1).trim()
    const line = markdown.slice(0, match.index).split('\n').length
    targets.push({ target, line })
  }
  return targets
}

async function checkMarkdownLinks(root, docPath, tree, errors) {
  let markdown
  try {
    markdown = await readFile(join(root, ...docPath.split('/')), 'utf8')
  } catch (err) {
    errors.push({ code: 'unreadable', path: docPath, message: describe(err, root) })
    return
  }
  const baseDir = docPath.includes('/') ? docPath.slice(0, docPath.lastIndexOf('/')) : ''
  for (const { target, line } of extractLocalLinkTargets(markdown)) {
    if (target === '' || target.startsWith('#')) continue
    if (/^https?:\/\//i.test(target) || /^(?:mailto|data):/i.test(target) || target.startsWith('//')) continue
    const fail = message => errors.push({ code: 'doc-link', path: docPath, message: `Line ${line}: link "${target}" ${message}` })
    const hash = target.indexOf('#')
    const raw = hash === -1 ? target : target.slice(0, hash)
    if (raw === '') continue
    let decoded
    try {
      decoded = decodeURIComponent(raw)
    } catch {
      fail('is not a valid percent-encoded path')
      continue
    }
    const resolvedRelative = relative(root, resolve(root, ...baseDir.split('/').filter(Boolean), ...decoded.split(/[\\/]/)))
    if (resolvedRelative === '' || resolvedRelative.startsWith('..') || isAbsolute(resolvedRelative)) {
      fail('escapes the package boundary')
      continue
    }
    const resolvedPath = resolvedRelative.split(sep).join('/')
    if (tree.files.has(resolvedPath)) continue
    if (tree.dirs.has(resolvedPath)) fail('resolves to a directory, not a file')
    else fail('does not resolve to a file inside the package')
  }
}

export function assertReportOutsidePackage(reportPath, root) {
  const outside = (base, target) => {
    const part = relative(base, target)
    return part === '..' || part.startsWith(`..${sep}`) || isAbsolute(part)
  }
  const requested = resolve(reportPath)
  // Resolve the nearest existing ancestor too: a directory junction outside the
  // package must not route a report back into the package being inspected.
  let ancestor = requested
  while (!existsSync(ancestor) && dirname(ancestor) !== ancestor) ancestor = dirname(ancestor)
  const actual = resolve(realpathSync(ancestor), relative(ancestor, requested))
  if (!outside(resolve(root), requested) || !outside(realpathSync(root), actual)) {
    throw new Error('--report must point outside the package directory; the package itself is never written to')
  }
}

export async function verifyPackage(packageDir, options = {}) {
  const root = resolve(packageDir)
  const rootStat = await lstat(root).catch(() => null)
  if (!rootStat || !rootStat.isDirectory()) throw new Error(`Package directory not found: ${root}`)

  const errors = []
  const tree = await walkPackage(root)
  errors.push(...tree.errors)

  for (const path of [...tree.files.keys(), ...tree.dirs]) {
    const name = path.slice(path.lastIndexOf('/') + 1)
    if (PRIVATE_NAMES.has(name) || PRIVATE_FILE.test(name)) {
      errors.push({ code: 'private-artifact', path, message: 'Private or machine-specific artifact must not ship in the package' })
    }
  }

  for (const path of REQUIRED_FILES) {
    if (!tree.files.has(path)) errors.push({ code: 'required-file', path, message: 'Required file is missing from the package' })
  }
  const licenseFiles = [...tree.files.keys()].filter(path => path.startsWith('third-party/') && path !== 'third-party/dependencies.json' && /(LICENSE|LICENCE|NOTICE|COPYING)/i.test(path))
  if (tree.files.has('third-party/dependencies.json') && licenseFiles.length === 0) {
    errors.push({ code: 'required-file', path: 'third-party/', message: 'Dependency license tree is missing; third-party/ must contain license files beside dependencies.json' })
  }

  const metadataValue = await readJson(root, METADATA_FILE, 'metadata', errors)
  const release = validateIdentity(metadataValue, METADATA_FILE, 'metadata', errors)

  const manifestValue = await readJson(root, MANIFEST_FILE, 'manifest', errors)
  const manifest = validateManifest(manifestValue, errors)

  if (release && manifest?.identity) {
    for (const field of Object.keys(release)) {
      if (manifest.identity[field] !== release[field]) {
        errors.push({ code: 'metadata-mismatch', path: MANIFEST_FILE, message: `${field} is "${manifest.identity[field]}" but ${METADATA_FILE} says "${release[field]}"` })
      }
    }
  }

  const packageValue = await readJson(root, 'package.json', 'metadata', errors)
  if (packageValue && typeof packageValue === 'object' && !Array.isArray(packageValue)) {
    if (release && packageValue.version !== release.version) {
      errors.push({ code: 'metadata-mismatch', path: 'package.json', message: `version is "${packageValue.version}" but ${METADATA_FILE} says "${release.version}"` })
    }
    if (packageValue.type !== 'module') {
      errors.push({ code: 'metadata', path: 'package.json', message: 'type must be "module"' })
    }
    if (packageValue.dependencies !== undefined && (typeof packageValue.dependencies !== 'object' || packageValue.dependencies === null || Array.isArray(packageValue.dependencies))) {
      errors.push({ code: 'metadata', path: 'package.json', message: 'dependencies must be an object' })
    } else if (packageValue.dependencies) {
      for (const name of Object.keys(packageValue.dependencies)) {
        const dependencyPath = `node_modules/${name}/package.json`
        if (!tree.files.has(dependencyPath)) {
          errors.push({ code: 'node-modules', path: dependencyPath, message: `Production dependency "${name}" is missing from node_modules` })
        }
      }
    }
  } else {
    errors.push({ code: 'metadata', path: 'package.json', message: 'Expected a JSON object' })
  }

  if (manifest) {
    for (const [path, entry] of manifest.listed) {
      if (!tree.files.has(path)) {
        errors.push({ code: 'missing-file', path, message: 'Listed in the manifest but absent from the package' })
        continue
      }
      if (tree.rejected.has(path)) continue
      let hashed
      try {
        hashed = await hashFile(join(root, ...path.split('/')))
      } catch (err) {
        errors.push({ code: 'unreadable', path, message: describe(err, root) })
        continue
      }
      if (hashed.bytes !== entry.bytes) {
        errors.push({ code: 'size-mismatch', path, message: `Manifest declares ${entry.bytes} bytes but the file has ${hashed.bytes}` })
      }
      if (hashed.sha256 !== entry.sha256) {
        errors.push({ code: 'hash-mismatch', path, message: 'SHA-256 does not match the manifest' })
      }
    }
    for (const path of tree.files.keys()) {
      if (path !== MANIFEST_FILE && !manifest.listed.has(path)) {
        errors.push({ code: 'extra-file', path, message: 'Present in the package but not listed in the manifest' })
      }
    }
  }

  const docFiles = ['README.md', 'CONTRIBUTING.md', 'SECURITY.md']
    .filter(path => tree.files.has(path))
    .concat([...tree.files.keys()].filter(path => path.startsWith('docs/user/') && path.endsWith('.md')))
  for (const docPath of docFiles) await checkMarkdownLinks(root, docPath, tree, errors)

  const result = {
    ok: errors.length === 0,
    release,
    fileCount: tree.files.size,
    hashedFileCount: manifest ? manifest.listed.size : 0,
    errors,
  }

  if (options.report) {
    const reportPath = resolve(options.report)
    assertReportOutsidePackage(reportPath, root)
    const payload = {
      tool: 'scripts/release/verify.mjs',
      checkedAt: new Date().toISOString(),
      package: root,
      ok: result.ok,
      release,
      fileCount: result.fileCount,
      errors,
    }
    await mkdir(dirname(reportPath), { recursive: true })
    await writeFile(reportPath, JSON.stringify(payload, null, 2) + '\n', 'utf8')
    result.report = reportPath
  }

  return result
}

function parseArgs(argv) {
  const args = {}
  for (let index = 0; index < argv.length; index++) {
    let name = argv[index]
    let value
    if (!name.startsWith('--')) throw new Error(`Unexpected argument: ${name}`)
    const equals = name.indexOf('=')
    if (equals !== -1) {
      value = name.slice(equals + 1)
      name = name.slice(0, equals)
    } else {
      value = argv[++index]
    }
    if (value === undefined || value === '') throw new Error(`Missing value for ${name}`)
    if (name !== '--package' && name !== '--report') throw new Error(`Unknown option: ${name}`)
    if (args[name.slice(2)]) throw new Error(`Duplicate option: ${name}`)
    args[name.slice(2)] = value
  }
  if (!args.package) throw new Error('Usage: node scripts/release/verify.mjs --package ABS_PACKAGE_DIR [--report ABS_REPORT_JSON]')
  return args
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = parseArgs(process.argv.slice(2))
    const result = await verifyPackage(args.package, { report: args.report })
    if (result.ok) {
      const identity = result.release ? ` ${result.release.version} (${result.release.gitCommit.slice(0, 12)})` : ''
      console.log(`OK${identity} — ${result.fileCount} files checked, manifest consistent${result.report ? `; report written to ${result.report}` : ''}`)
    } else {
      for (const error of result.errors) console.error(formatError(error))
      console.error(`FAILED: ${result.errors.length} problem(s); package paths are relative to the package root`)
      process.exitCode = 1
    }
  } catch (err) {
    console.error(`verify: ${err.message}`)
    process.exitCode = 2
  }
}

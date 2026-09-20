import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile, lstat } from 'node:fs/promises'
import { resolve, join, dirname, relative, isAbsolute, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'

const rootFiles = new Set(['README.md', 'LICENSE', 'THIRD-PARTY-NOTICES.md', 'CONTRIBUTING.md', 'SECURITY.md', 'package.json', 'package-lock.json', 'tsconfig.json', 'playwright.config.ts', '.gitignore', '.gitattributes'])
const internalTests = new Set(['server/test/docs-tooling.test.ts', 'server/test/worktree-tools.test.ts'])

/** Public source is a reviewed source-only snapshot, never development history. */
export function publicSourcePath(path) {
  if (path.split('/').some(part => ['node_modules', 'dist', '.runs', '.mimosa', '.git'].includes(part))) return false
  if (/(?:^|\/)(?:\.env(?:\..*)?|trainer\.config\.json)$|\.(?:db|sqlite|day|log|xls|xlsx)$/i.test(path)) return false
  if (rootFiles.has(path)) return true
  if (path.startsWith('server/src/') || path.startsWith('server/test/')) return path.endsWith('.ts') && !internalTests.has(path)
  if (['server/tsconfig.json', 'server/vitest.config.ts', 'web/tsconfig.json', 'web/vite.config.ts', 'web/index.html'].includes(path)) return true
  if (path.startsWith('web/src/')) return /\.(?:ts|vue|css|svg)$/.test(path)
  if (path.startsWith('e2e/')) return path.endsWith('.ts')
  if (path.startsWith('scripts/runtime/') || path === 'scripts/runtime.ts') return path.endsWith('.ts')
  if (path.startsWith('scripts/release/')) return /\.(?:mjs|cjs|cmd|ps1|json)$/.test(path)
  if (path === 'scripts/verify-m2.ts') return true
  if (path.startsWith('docs/user/')) return path.endsWith('.md')
  if (path.startsWith('third-party/')) return /\.(?:md|txt|json)$/.test(path) || /\/(?:LICENSE|LICENCE|NOTICE|COPYING)(?:[.-][^/]*)?$/i.test(path)
  return ['assets/trainer.ico', 'assets/trainer.png', '.github/workflows/check.yml'].includes(path)
}

export function publicPackage(document) {
  const excluded = new Set(['task', 'docs:check', 'docs:status', 'docs:impact', 'verify:baseline', 'verify:candidate', 'verify:m1'])
  return { ...document, scripts: Object.fromEntries(Object.entries(document.scripts).filter(([name]) => !excluded.has(name))) }
}

export function assertSourceUnchanged(root, expectedCommit) {
  const options = { cwd: root, encoding: 'utf8', windowsHide: true }
  const head = execFileSync('git', ['rev-parse', 'HEAD'], options).trim()
  const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], options).trim()
  if (head !== expectedCommit || dirty) throw new Error('Source changed during export; discard this incomplete snapshot and retry from a clean reviewed commit')
}

export async function exportSource(root, out) {
  root = resolve(root); out = resolve(out)
  const destination = relative(root, out)
  if (!(destination === '..' || destination.startsWith(`..${sep}`) || isAbsolute(destination))) {
    throw new Error('Public snapshot must be outside the development repository')
  }
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim()
  if (git('status', '--porcelain', '--untracked-files=all')) throw new Error('Commit the reviewed source before exporting')
  const sourceCommit = git('rev-parse', 'HEAD')
  await mkdir(out) // exclusive: never overwrite a prior release or delete user files
  const paths = git('ls-tree', '-r', '--name-only', '-z', sourceCommit).split('\0').filter(Boolean).filter(publicSourcePath).sort()
  for (const path of paths) {
    const origin = join(root, path)
    if (!(await lstat(origin)).isFile()) throw new Error(`Refusing non-file source: ${path}`)
    await mkdir(dirname(join(out, path)), { recursive: true })
    // Read immutable Git blobs, so a mid-export edit cannot silently mix builds.
    const bytes = execFileSync('git', ['show', `${sourceCommit}:${path}`], { cwd: root, windowsHide: true, maxBuffer: 32 * 1024 * 1024 })
    // Batch entry points must survive both Git clones and GitHub source archives.
    await writeFile(join(out, path), path.endsWith('.cmd') ? bytes.toString('utf8').replace(/\r?\n/g, '\r\n') : bytes)
  }
  const pkg = publicPackage(JSON.parse(await readFile(join(out, 'package.json'), 'utf8')))
  await writeFile(join(out, 'package.json'), JSON.stringify(pkg, null, 2) + '\n')
  await writeFile(join(out, 'AGENTS.md'), '# Contributor guide\n\nRead README.md and CONTRIBUTING.md. Node24, Vue3, Fastify and SQLite. TDX is read-only; never use personal training databases in tests. Recording replay must not expose future prices or write trades. Use dedicated temporary databases and the isolated Journey runner. Product rules: T+1, whole lots of100shares, close-price execution, visible-date forward adjustment. Preserve user data and dependency licenses.\n')
  const files = [...paths, 'AGENTS.md']
  const manifest = { format: 'trainer-public-source', version: pkg.version, sourceCommit, files: [] }
  for (const path of files) manifest.files.push({ path, sha256: createHash('sha256').update(await readFile(join(out, path))).digest('hex') })
  assertSourceUnchanged(root, sourceCommit)
  await writeFile(join(out, 'SOURCE-MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n')
  return { out, sourceCommit, files: files.length }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2)
  if (args.length !== 2 || args[0] !== '--out') throw new Error('Usage: node scripts/release/export-source.mjs --out NEW_EXTERNAL_DIRECTORY')
  console.log(JSON.stringify(await exportSource(process.cwd(), args[1])))
}

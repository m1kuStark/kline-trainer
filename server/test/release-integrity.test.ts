import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { verifyPackage, assertReportOutsidePackage } from '../../scripts/release/verify.mjs'

const COMMIT = 'a'.repeat(40)
const RELEASE = {
  appId: 'a-share-kline-trainer',
  version: '0.3.0',
  gitCommit: COMMIT,
  nodeVersion: '24.15.0',
  platform: 'win32',
  arch: 'x64',
}

// A minimal but structurally complete package: every required path, one production
// dependency, and a manifest that matches the bytes on disk.
function baseFiles() {
  const files = new Map()
  const set = (path, content) => files.set(path, Buffer.from(content, 'utf8'))
  set('release.json', JSON.stringify(RELEASE))
  set('package.json', JSON.stringify({ name: 'a-share-kline-trainer', version: '0.3.0', type: 'module', dependencies: { fastify: '^5.6.0' } }))
  const simple = [
    'runtime/node.exe', 'runtime/LICENSE',
    'server/dist/index.js', 'web/dist/index.html',
    'launcher.cjs', 'Start.cmd', 'Stop.cmd', 'Create Shortcut.cmd', 'create-shortcut.ps1',
    'trainer.config.example.json', 'assets/trainer.ico',
    'LICENSE', 'THIRD-PARTY-NOTICES.md', 'CONTRIBUTING.md', 'SECURITY.md',
    'third-party/dependencies.json', 'third-party/npm/fastify/LICENSE',
    'docs/user/README.md', 'docs/user/recording.md', 'docs/user/troubleshooting.md',
    'node_modules/fastify/package.json',
  ]
  for (const path of simple) set(path, `content of ${path}\n`)
  set('README.md', '# Trainer\n\n[Install](docs/user/install.md)\n[Guide](docs/user/README.md)\n[License](LICENSE)\n[Upstream](https://github.com/example/trainer/releases)\n')
  set('docs/user/install.md', 'Install\n\n[Contributing](../../CONTRIBUTING.md)\n[Back](README.md)\n')
  return files
}

function manifestFor(files) {
  return {
    schemaVersion: 1,
    ...RELEASE,
    createdAt: '2026-09-21T00:00:00.000Z',
    files: [...files.keys()].sort().map(path => {
      const content = files.get(path)
      return { path, sha256: createHash('sha256').update(content).digest('hex'), bytes: content.length }
    }),
  }
}

async function materialize(files) {
  const root = await mkdtemp(join(tmpdir(), 'trainer-release-integrity-'))
  for (const path of files.keys()) await mkdir(dirname(join(root, ...path.split('/'))), { recursive: true })
  for (const [path, content] of files) await writeFile(join(root, ...path.split('/')), content)
  return root
}

async function freshPackage() {
  const files = baseFiles()
  files.set('release-manifest.json', Buffer.from(JSON.stringify(manifestFor(files), null, 2), 'utf8'))
  return materialize(files)
}

// Rewrites one file and re-signs the manifest entry, so only the behavior under
// test (not a hash mismatch) produces errors.
async function rewriteSigned(root, path, content) {
  const buffer = Buffer.from(content, 'utf8')
  await writeFile(join(root, ...path.split('/')), buffer)
  const manifestPath = join(root, 'release-manifest.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const entry = manifest.files.find(candidate => candidate.path === path)
  entry.sha256 = createHash('sha256').update(buffer).digest('hex')
  entry.bytes = buffer.length
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')
}

const withRoot = async root => { try { return await verifyPackage(root) } finally { await rm(root, { recursive: true, force: true }) } }
const has = (result, code, path) => result.errors.some(error => error.code === code && (path === undefined || error.path === path))
const codes = result => result.errors.map(error => error.code)

describe('release package integrity inspector', () => {
  it('rejects falsy JSON metadata instead of skipping integrity validation', async () => {
    for (const path of ['release-manifest.json', 'release.json', 'package.json']) {
      for (const value of [null, false, 0, '']) {
        const root = await freshPackage()
        if (path === 'release-manifest.json') {
          await writeFile(join(root, path), JSON.stringify(value))
          await writeFile(join(root, 'server/dist/index.js'), 'tampered')
        } else await rewriteSigned(root, path, JSON.stringify(value))
        const result = await withRoot(root)
        expect(result.ok, `${path}=${JSON.stringify(value)}`).toBe(false)
      }
    }
  })
  it('accepts a consistent synthetic package and reports its identity', async () => {
    const result = await withRoot(await freshPackage())
    expect(result.ok).toBe(true)
    expect(result.errors).toEqual([])
    expect(result.release).toEqual(RELEASE)
    expect(result.fileCount).toBeGreaterThan(20)
  })

  it('rejects tampered bytes with a hash mismatch on the relative path', async () => {
    const root = await freshPackage()
    await writeFile(join(root, 'server', 'dist', 'index.js'), 'content of server/dist/indeX.js\n')
    const result = await withRoot(root)
    expect(result.ok).toBe(false)
    expect(has(result, 'hash-mismatch', 'server/dist/index.js')).toBe(true)
  })

  it('rejects a size change with a size mismatch', async () => {
    const root = await freshPackage()
    await writeFile(join(root, 'server', 'dist', 'index.js'), 'longer content than the manifest declares\n')
    const result = await withRoot(root)
    expect(has(result, 'size-mismatch', 'server/dist/index.js')).toBe(true)
  })

  it('rejects missing and extra files against the manifest', async () => {
    const root = await freshPackage()
    await rm(join(root, 'web', 'dist', 'index.html'))
    await writeFile(join(root, 'STRAY-NOTES.txt'), 'not in the manifest\n')
    const result = await withRoot(root)
    expect(has(result, 'missing-file', 'web/dist/index.html')).toBe(true)
    expect(has(result, 'required-file', 'web/dist/index.html')).toBe(true)
    expect(has(result, 'extra-file', 'STRAY-NOTES.txt')).toBe(true)
  })

  it('allows only the manifest itself to be unlisted', async () => {
    const result = await withRoot(await freshPackage())
    expect(result.errors.some(error => error.path === 'release-manifest.json')).toBe(false)
  })

  it('fails on private or machine-specific artifacts', async () => {
    const root = await freshPackage()
    await writeFile(join(root, 'trainer.config.json'), '{"tdxRoot":"C:/Users/someone"}')
    await writeFile(join(root, '.env'), 'SECRET=1')
    await mkdir(join(root, 'data'), { recursive: true })
    await writeFile(join(root, 'data', 'trainer.sqlite-wal'), 'wal')
    const result = await withRoot(root)
    expect(has(result, 'private-artifact', 'trainer.config.json')).toBe(true)
    expect(has(result, 'private-artifact', '.env')).toBe(true)
    expect(has(result, 'private-artifact', 'data/trainer.sqlite-wal')).toBe(true)
  })

  it('rejects traversal, absolute and duplicate manifest paths', async () => {
    for (const [code, path] of [['unsafe-path', '../escape.txt'], ['unsafe-path', 'C:/Users/x.txt'], ['duplicate-path', 'LICENSE']]) {
      const files = baseFiles()
      const manifest = manifestFor(files)
      if (code === 'duplicate-path') manifest.files.push({ ...manifest.files.find(entry => entry.path === 'LICENSE') })
      else manifest.files.push({ path, sha256: '0'.repeat(64), bytes: 1 })
      files.set('release-manifest.json', Buffer.from(JSON.stringify(manifest), 'utf8'))
      const result = await withRoot(await materialize(files))
      expect(result.ok).toBe(false)
      expect(has(result, code, path)).toBe(true)
    }
  })

  it('rejects malformed or mismatched metadata', async () => {
    const cases = [
      { release: { ...RELEASE, appId: 'other-app' }, code: 'metadata', path: 'release.json' },
      { release: { ...RELEASE, gitCommit: 'not-a-sha' }, code: 'metadata', path: 'release.json' },
      { release: { ...RELEASE, nodeVersion: '20.15.0' }, code: 'metadata', path: 'release.json' },
      { release: { ...RELEASE, version: '0.4.0' }, code: 'metadata-mismatch', path: 'release-manifest.json' },
      { release: { ...RELEASE, platform: 'linux' }, code: 'metadata', path: 'release.json' },
    ]
    for (const { release, code, path } of cases) {
      const files = baseFiles()
      files.set('release.json', JSON.stringify(release))
      files.set('release-manifest.json', Buffer.from(JSON.stringify(manifestFor(files), null, 2), 'utf8'))
      const result = await withRoot(await materialize(files))
      expect(result.ok).toBe(false)
      expect(has(result, code, path)).toBe(true)
    }
  })

  it('rejects a manifest whose schemaVersion is not 1', async () => {
    const files = baseFiles()
    const manifest = manifestFor(files)
    manifest.schemaVersion = 2
    files.set('release-manifest.json', Buffer.from(JSON.stringify(manifest), 'utf8'))
    const result = await withRoot(await materialize(files))
    expect(has(result, 'manifest', 'release-manifest.json')).toBe(true)
  })

  it('requires production dependencies inside node_modules', async () => {
    const root = await freshPackage()
    await rm(join(root, 'node_modules', 'fastify', 'package.json'))
    const result = await withRoot(root)
    expect(has(result, 'node-modules', 'node_modules/fastify/package.json')).toBe(true)
  })

  it('requires the third-party license tree beside dependencies.json', async () => {
    const root = await freshPackage()
    await rm(join(root, 'third-party', 'npm', 'fastify', 'LICENSE'))
    const result = await withRoot(root)
    expect(result.errors.some(error => error.code === 'required-file' && error.path === 'third-party/')).toBe(true)
  })

  it('catches a user doc misplaced out of its frozen path', async () => {
    const root = await freshPackage()
    await rm(join(root, 'docs', 'user', 'install.md'))
    await writeFile(join(root, 'docs', 'install.md'), 'misplaced\n')
    const result = await withRoot(root)
    expect(has(result, 'missing-file', 'docs/user/install.md')).toBe(true)
    expect(has(result, 'required-file', 'docs/user/install.md')).toBe(true)
    expect(result.errors.some(error => error.code === 'doc-link' && error.path === 'README.md' && error.message.includes('docs/user/install.md'))).toBe(true)
  })

  it('rejects broken local links while ignoring external and anchor links', async () => {
    const root = await freshPackage()
    await rewriteSigned(root, 'README.md', '# Trainer\n\n[Broken](docs/user/missing.md)\n[Anchor](#top)\n[Site](https://example.com)\n[Mail](mailto:a@example.com)\n')
    const result = await withRoot(root)
    expect(result.errors.length).toBe(1)
    expect(result.errors[0].code).toBe('doc-link')
    expect(result.errors[0].path).toBe('README.md')
    expect(result.errors[0].message).toContain('docs/user/missing.md')
  })

  it('rejects local links that escape the package boundary', async () => {
    const root = await freshPackage()
    await rewriteSigned(root, 'docs/user/install.md', '[Outside](../../../outside.md)\n[Absolute](C:/Windows/system.ini)\n')
    const result = await withRoot(root)
    expect(result.errors.filter(error => error.code === 'doc-link').length).toBe(2)
    expect(result.ok).toBe(false)
  })

  it('resolves relative links from each doc file location', async () => {
    const root = await freshPackage()
    await rewriteSigned(root, 'docs/user/install.md', '[Contributing](../../CONTRIBUTING.md)\n[Deps](../../third-party)\n')
    const result = await withRoot(root)
    expect(result.ok).toBe(false)
    expect(result.errors.filter(error => error.code === 'doc-link').length).toBe(1)
    expect(result.errors[0].message).toContain('directory')
  })

  it('rejects symlinks instead of following them', async () => {
    const root = await freshPackage()
    try {
      await symlink(join(root, 'LICENSE'), join(root, 'LINKED.md'))
    } catch {
      await rm(root, { recursive: true, force: true })
      return // symlink creation needs privileges on this machine
    }
    const result = await withRoot(root)
    expect(has(result, 'symlink', 'LINKED.md')).toBe(true)
  })

  it('refuses a report path inside the package and writes JSON outside', async () => {
    const root = await freshPackage()
    try {
      expect(() => assertReportOutsidePackage(join(root, 'report.json'), root)).toThrow(/outside/)
      expect(() => assertReportOutsidePackage(join(root, '..report.json'), root)).toThrow(/outside/)
      expect(() => assertReportOutsidePackage(root, root)).toThrow(/outside/)
      const reportPath = join(root, '..', 'trainer-release-report.json')
      const result = await verifyPackage(root, { report: reportPath })
      expect(result.ok).toBe(true)
      const report = JSON.parse(await readFile(reportPath, 'utf8'))
      expect(report.ok).toBe(true)
      expect(report.package).toBe(root)
      expect(report.errors).toEqual([])
      await rm(reportPath, { force: true })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports a missing package directory as a usage error', async () => {
    await expect(verifyPackage(join(tmpdir(), 'trainer-release-missing-package'))).rejects.toThrow(/not found/)
  })

  it('refuses an external report path routed back through a directory link', async () => {
    const root = await freshPackage()
    const external = await mkdtemp(join(tmpdir(), 'trainer-report-link-'))
    try {
      const alias = join(external, 'package-link')
      await symlink(root, alias, process.platform === 'win32' ? 'junction' : 'dir')
      expect(() => assertReportOutsidePackage(join(alias, 'nested', 'report.json'), root)).toThrow(/outside/)
      await expect(verifyPackage(root, { report: join(alias, '..report.json') })).rejects.toThrow(/outside/)
      await expect(readFile(join(root, '..report.json'))).rejects.toThrow()
    } finally {
      await rm(external, { recursive: true, force: true })
      await rm(root, { recursive: true, force: true })
    }
  })
})

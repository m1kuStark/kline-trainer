import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
// @ts-expect-error executable ESM release utility has no declaration file
import { publicSourcePath, publicPackage, exportSource, assertSourceUnchanged } from '../../scripts/release/export-source.mjs'

describe('public release source boundary', () => {
  it('excludes personal state, real market data and private development evidence', () => {
    for (const path of [
      '.env', '.env.local', 'trainer.config.json', '.runs/run-a/trainer.sqlite',
      'server/src/fixture.day', 'docs/verification/tdx-export/prices.txt',
      'docs/verification/report.json', 'docs/work-items/prompts/secret.md',
      'web/dist/assets/app.js', 'scripts/agent-monitor/run_glm.py', 'node_modules/package/index.js',
    ]) expect(publicSourcePath(path), path).toBe(false)
  })
  it('retains runnable source, product regressions, notices and user documentation', () => {
    for (const path of ['server/src/index.ts','web/src/App.vue','server/test/train-account.test.ts',
      'scripts/runtime/run.ts','scripts/release/launcher.cjs','docs/user/install.md',
      'assets/trainer.ico','third-party/NOTICE.txt','third-party/npm/klinecharts/NOTICE','third-party/npm/lucide-vue-next/LICENSE','LICENSE','package-lock.json']) {
      expect(publicSourcePath(path), path).toBe(true)
    }
    const pkg = publicPackage({ scripts: { build: 'tsc', test: 'vitest', task: 'private-tool', 'docs:check': 'private-docs', start: 'node server/dist/index.js' } })
    expect(pkg.scripts).toEqual({ build: 'tsc', test: 'vitest', start: 'node server/dist/index.js' })
  })

  it('exports a clean runnable snapshot without development history or private files', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'trainer-source-export-'))
    const root = join(sandbox, 'source')
    const out = join(sandbox, 'public source')
    try {
      await mkdir(root)
      const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe', windowsHide: true })
      git('init', '-q')
      git('config', 'user.email', 'fixture@example.invalid')
      git('config', 'user.name', 'Export test')
      await writeFile(join(root, 'README.md'), '# Public trainer\n')
      await mkdir(join(root, 'scripts', 'release'), { recursive: true })
      await writeFile(join(root, 'scripts', 'release', 'Start.cmd'), '@echo off\necho Ready\n')
      await writeFile(join(root, 'package.json'), JSON.stringify({ version: '0.3.0', scripts: { start: 'node server/dist/index.js', task: 'private-tool' } }))
      await writeFile(join(root, 'private.txt'), 'not for publication')
      git('add', '.')
      git('commit', '-qm', 'Synthetic source fixture')
      await expect(exportSource(root, join(root, '..private'))).rejects.toThrow('outside')
      const result = await exportSource(root, out)
      expect(result.files).toBe(4)
      expect(await readFile(join(out, 'README.md'), 'utf8')).toBe('# Public trainer\n')
      expect(await readFile(join(out, 'scripts', 'release', 'Start.cmd'), 'utf8')).toBe('@echo off\r\necho Ready\r\n')
      expect(JSON.parse(await readFile(join(out, 'package.json'), 'utf8')).scripts).toEqual({ start: 'node server/dist/index.js' })
      for (const privatePath of ['.git', 'private.txt']) await expect(access(join(out, privatePath))).rejects.toThrow()
      const manifest = JSON.parse(await readFile(join(out, 'SOURCE-MANIFEST.json'), 'utf8'))
      expect(manifest.sourceCommit).toMatch(/^[a-f\d]{40}$/)
      expect(manifest.files).toHaveLength(4)
      expect(() => assertSourceUnchanged(root, manifest.sourceCommit)).not.toThrow()
      await expect(exportSource(root, out)).rejects.toThrow()
      await writeFile(join(root, 'README.md'), 'unreviewed change')
      expect(() => assertSourceUnchanged(root, manifest.sourceCommit)).toThrow('Source changed')
      await expect(exportSource(root, join(sandbox, 'dirty'))).rejects.toThrow('Commit the reviewed source')
      await expect(access(join(sandbox, 'dirty'))).rejects.toThrow()
      git('add', 'README.md')
      git('commit', '-qm', 'Changed source commit')
      expect(() => assertSourceUnchanged(root, manifest.sourceCommit)).toThrow('Source changed')
    } finally { await rm(sandbox, { recursive: true, force: true }) }
  }, 20_000)
})

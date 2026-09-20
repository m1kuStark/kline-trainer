import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { access, mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  PACKAGE_PS1,
  assertCleanWorktree,
  assertFreshOutputs,
  assertUnchangedSource,
  classifyStagedPath,
  containsJourneyMarkers,
  expectedChecksumLine,
  findBrokenPackageLinks,
  missingReleaseInputs,
  parseArgs,
  parseNodeArchiveName,
  publishFileExclusive,
  releaseOutputs,
  reserveOutputs,
  runPowerShellScript,
  safeArchiveEntryName,
  stageUserDocsAndNotices,
  verifyNodeArchive,
} from '../../scripts/release/build.mjs'

// Focused unit checks for the release packager's pure validation/allowlist helpers.
// Synthetic repo/staging trees exercise the staging and publication behavior; the full
// clean-room package build (real archive, npm ci, Compress-Archive over the real tree)
// is the integrator's acceptance run once the other REL workers' files have merged.

const SHA = (content: string) => createHash('sha256').update(content).digest('hex')

/** Materialize a synthetic directory tree from relPath -> text content entries. */
async function makeTree(root: string, entries: Record<string, string>) {
  for (const [rel, content] of Object.entries(entries)) {
    const target = join(root, ...rel.split('/'))
    await mkdir(join(target, '..'), { recursive: true })
    await writeFile(target, content)
  }
}

describe('parseNodeArchiveName', () => {
  it('accepts only official Node 24 win-x64 archive names', () => {
    expect(parseNodeArchiveName('node-v24.15.0-win-x64.zip')).toEqual({ version: '24.15.0', major: 24 })
  })

  it('rejects other major versions, platforms and malformed names', () => {
    expect(() => parseNodeArchiveName('node-v22.11.0-win-x64.zip')).toThrow(/pinned to Node 24/)
    expect(() => parseNodeArchiveName('node-v24.15.0-win-x86.zip')).toThrow(/Node 24 win-x64/)
    expect(() => parseNodeArchiveName('node-v24-win-x64.zip')).toThrow(/Node 24 win-x64/)
    expect(() => parseNodeArchiveName('node-custom-build.zip')).toThrow(/Node 24 win-x64/)
  })
})

describe('parseArgs', () => {
  it('requires all three flags and resolves paths', () => {
    expect(() => parseArgs(['--node-archive', 'a.zip', '--node-checksums', 'b.txt'])).toThrow(/--out/)
    expect(() => parseArgs(['--node-archive', 'a.zip', '--out', 'x'])).toThrow(/--node-checksums/)
    expect(() => parseArgs(['--node-archive', 'a.zip', '--node-archive', 'b.zip', '--out', 'x'])).toThrow(/Duplicate/)
    const parsed = parseArgs(['--node-archive', 'a.zip', '--node-checksums', 'b.txt', '--out', 'out'])
    expect(parsed.nodeArchive).toBe(resolve('a.zip'))
    expect(parsed.nodeChecksums).toBe(resolve('b.txt'))
    expect(parsed.out).toBe(resolve('out'))
    expect(parseArgs(['--help'])).toEqual({ help: true })
  })
})

describe('node archive checksum verification', () => {
  it('matches the exact filename in SHASUMS256.txt and verifies archive bytes', async () => {
    const sums = `${SHA('NODE-ARCHIVE-BYTES')}  node-v24.15.0-win-x64.zip\n${SHA('OTHER')}  node-v24.15.0-win-x86.zip\n`
    expect(expectedChecksumLine(sums, 'node-v24.15.0-win-x64.zip')).toBe(SHA('NODE-ARCHIVE-BYTES'))
    expect(() => expectedChecksumLine(sums, 'node-v25.0.0-win-x64.zip')).toThrow(/does not list/)

    const dir = await mkdtemp(join(tmpdir(), 'relpack-'))
    try {
      const archive = join(dir, 'node-v24.15.0-win-x64.zip')
      await writeFile(archive, 'NODE-ARCHIVE-BYTES')
      // verifyNodeArchive only hashes and compares; extraction happens later in
      // main(), so a bad archive is refused before any extraction can exist.
      await expect(verifyNodeArchive(archive, sums)).resolves.toBe(SHA('NODE-ARCHIVE-BYTES'))
      await writeFile(archive, 'NODE-ARCHIVE-BYTES-TAMPERED')
      await expect(verifyNodeArchive(archive, sums)).rejects.toThrow(/checksum mismatch/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('assertCleanWorktree', () => {
  it('accepts a clean tree at a valid sha and refuses dirty trees or bad shas', () => {
    const sha = 'a'.repeat(40)
    expect(() => assertCleanWorktree('', sha)).not.toThrow()
    expect(() => assertCleanWorktree('\r\n', sha)).not.toThrow()
    expect(() => assertCleanWorktree(' M package.json\n?? scripts/release/build.mjs', sha)).toThrow(/clean[\s\S]*package\.json/)
    expect(() => assertCleanWorktree('', 'HEAD')).toThrow(/valid git commit sha/)
    expect(() => assertCleanWorktree('', 'abc123')).toThrow(/valid git commit sha/)
    expect(() => assertCleanWorktree('', '')).toThrow(/valid git commit sha/)
  })
})

describe('assertFreshOutputs', () => {
  it('refuses existing outputs without destroying them', async () => {
    const out = await mkdtemp(join(tmpdir(), 'relpack-out-'))
    try {
      const existingZip = join(out, 'kline-trainer-v0.3.0-windows-x64.zip')
      await mkdir(out, { recursive: true })
      await writeFile(existingZip, 'PRIOR-RELEASE-ZIP')
      await expect(assertFreshOutputs(out, 'kline-trainer-v0.3.0-windows-x64')).rejects.toThrow(/already exist/)
      expect(await readFile(existingZip, 'utf8')).toBe('PRIOR-RELEASE-ZIP')

      const sumsOut = await mkdtemp(join(tmpdir(), 'relpack-sums-'))
      try {
        await writeFile(join(sumsOut, 'SHA256SUMS'), 'x  y.zip\n')
        await expect(assertFreshOutputs(sumsOut, 'kline-trainer-v0.3.0-windows-x64')).rejects.toThrow(/already exist/)
      } finally {
        await rm(sumsOut, { recursive: true, force: true })
      }
      await expect(assertFreshOutputs(await mkdtemp(join(tmpdir(), 'relpack-fresh-')), 'kline-trainer-v0.3.0-windows-x64')).resolves.toBeUndefined()
    } finally {
      await rm(out, { recursive: true, force: true })
    }
  })
})

describe('safeArchiveEntryName', () => {
  it('passes through normal entries and rejects traversal, absolute and backslash names', () => {
    expect(safeArchiveEntryName('node-v24.15.0-win-x64/node.exe')).toBe('node-v24.15.0-win-x64/node.exe')
    expect(() => safeArchiveEntryName('../evil.exe')).toThrow(/Unsafe archive entry/)
    expect(() => safeArchiveEntryName('node-v24.15.0-win-x64/../../evil.exe')).toThrow(/Unsafe archive entry/)
    expect(() => safeArchiveEntryName('C:/Windows/evil.exe')).toThrow(/Unsafe archive entry/)
    expect(() => safeArchiveEntryName('/abs/evil.exe')).toThrow(/Unsafe archive entry/)
    expect(() => safeArchiveEntryName('runtime\\node.exe')).toThrow(/Unsafe archive entry/)
  })
})

describe('classifyStagedPath', () => {
  it('allows only allowlisted package paths', () => {
    expect(classifyStagedPath('server/dist/index.js')).toBe('server')
    expect(classifyStagedPath('server/dist/routes/api.js')).toBe('server')
    expect(classifyStagedPath('web/dist/assets/index-a1b2c3.js')).toBe('web')
    expect(classifyStagedPath('node_modules/fastify/package.json')).toBe('node_modules')
    expect(classifyStagedPath('docs/install.md')).toBe('docs')
    expect(classifyStagedPath('runtime/node.exe')).toBe('runtime')
    expect(classifyStagedPath('runtime/LICENSE')).toBe('runtime')
    expect(classifyStagedPath('assets/trainer.ico')).toBe('assets')
    expect(classifyStagedPath('LICENSE')).toBe('root')
    expect(classifyStagedPath('release.json')).toBe('root')
    expect(classifyStagedPath('trainer.config.example.json')).toBe('root')
    expect(classifyStagedPath('Start.cmd')).toBe('root')
  })

  it('excludes non-allowlisted files (fake files, sources, maps, declarations, data)', () => {
    expect(classifyStagedPath('server/dist/index.d.ts')).toBeNull()
    expect(classifyStagedPath('server/dist/index.js.map')).toBeNull()
    expect(classifyStagedPath('server/dist/fakefile.txt')).toBeNull()
    expect(classifyStagedPath('server/src/index.ts')).toBeNull()
    expect(classifyStagedPath('web/src/App.vue')).toBeNull()
    expect(classifyStagedPath('web/dist-journey/index.html')).toBeNull()
    expect(classifyStagedPath('data/day/sh600519.day')).toBeNull()
    expect(classifyStagedPath('samples/snapshot.json')).toBeNull()
    expect(classifyStagedPath('scripts/agent-monitor/run.ts')).toBeNull()
    expect(classifyStagedPath('e2e/specs/smoke.ts')).toBeNull()
  })

  it('throws on private or sensitive names wherever they appear', () => {
    expect(() => classifyStagedPath('trainer.config.json')).toThrow(/private\/sensitive/)
    expect(() => classifyStagedPath('.env')).toThrow(/private\/sensitive/)
    expect(() => classifyStagedPath('.env.production')).toThrow(/private\/sensitive/)
    expect(() => classifyStagedPath('.git/config')).toThrow(/private\/sensitive/)
    expect(() => classifyStagedPath('.runs/run-abc/manifest.json')).toThrow(/private\/sensitive/)
    expect(() => classifyStagedPath('trainer.sqlite')).toThrow(/private\/sensitive/)
    expect(() => classifyStagedPath('node_modules/pkg/.env')).toThrow(/private\/sensitive/)
    expect(() => classifyStagedPath('node_modules/pkg/.git/index')).toThrow(/private\/sensitive/)
  })
})

describe('containsJourneyMarkers', () => {
  it('detects journey-only runtime hooks and passes production bundles', () => {
    expect(containsJourneyMarkers('if (import.meta.env.MODE === "journey") { window.__trainerChart = {} }')).toBe(true)
    expect(containsJourneyMarkers('var app = createApp(App); app.mount("#app");')).toBe(false)
  })
})

describe('classifyStagedPath: docs/license release surface', () => {
  it('allowlists the docs/user hierarchy, third-party tree and root doc/license entries', () => {
    expect(classifyStagedPath('docs/user/README.md')).toBe('docs')
    expect(classifyStagedPath('docs/user/install.md')).toBe('docs')
    expect(classifyStagedPath('third-party/INVENTORY.md')).toBe('third-party')
    expect(classifyStagedPath('third-party/mit/LICENSE.txt')).toBe('third-party')
    expect(classifyStagedPath('CONTRIBUTING.md')).toBe('root')
    expect(classifyStagedPath('SECURITY.md')).toBe('root')
    expect(classifyStagedPath('Stop.cmd')).toBe('root')
  })
})

describe('assertUnchangedSource', () => {
  it('requires the same clean HEAD after staging as at the start', () => {
    const sha = 'b'.repeat(40)
    expect(() => assertUnchangedSource(sha, sha, '')).not.toThrow()
    expect(() => assertUnchangedSource(sha, 'c'.repeat(40), '')).toThrow(/HEAD moved during the build/)
    expect(() => assertUnchangedSource(sha, sha, '?? late-edit.txt')).toThrow(/changed while the build was running[\s\S]*late-edit\.txt/)
  })
})

describe('required inputs and docs staging (synthetic trees)', () => {
  const SYNTHETIC_REPO: Record<string, string> = {
    'package.json': '{"name":"a-share-kline-trainer","version":"0.3.0"}',
    'package-lock.json': '{}',
    'server/src/index.ts': 'export {}\n',
    'web/index.html': '<!doctype html>\n',
    'LICENSE': 'MIT License\n',
    'README.md': '# 训练器\n[用户手册](docs/user/README.md)、[参与贡献](CONTRIBUTING.md)、[安全报告](SECURITY.md)、[第三方组件](THIRD-PARTY-NOTICES.md)。',
    'CONTRIBUTING.md': '# 参与贡献\n从源码运行见 npm ci。',
    'SECURITY.md': '# 安全报告\n联系方式见仓库主页。',
    'THIRD-PARTY-NOTICES.md': '# 第三方组件\n完整许可文本见 [第三方目录](third-party/INVENTORY.md)。',
    'docs/user/README.md': '# 用户手册\n安装见 [安装说明](install.md)。',
    'docs/user/install.md': '# 安装\n解压后运行 Start.cmd；贡献指南见 [CONTRIBUTING](../../CONTRIBUTING.md)。',
    'third-party/INVENTORY.md': '# 组件清单\n- MIT\n',
    'third-party/mit/LICENSE.txt': 'MIT License\n\nCopyright (c) 2026\n',
    'assets/trainer.ico': 'ICO-BYTES',
    'scripts/release/launcher.cjs': '// launcher\n',
    'scripts/release/Start.cmd': '@echo off\r\n',
    'scripts/release/Stop.cmd': '@echo off\r\n',
    'scripts/release/Create Shortcut.cmd': '@echo off\r\n',
    'scripts/release/create-shortcut.ps1': 'param()\n',
    'scripts/release/trainer.config.example.json': '{}\n',
  }

  it('reports every missing release input at once, including Stop.cmd and third-party', async () => {
    const root = await mkdtemp(join(tmpdir(), 'relpack-repo-'))
    try {
      await makeTree(root, { 'package.json': '{}' })
      const missing = await missingReleaseInputs(root)
      expect(missing).toContain('scripts/release/Stop.cmd')
      expect(missing).toContain('CONTRIBUTING.md')
      expect(missing).toContain('SECURITY.md')
      expect(missing).toContain('third-party')
      expect(missing).toContain('docs/user')

      await makeTree(root, SYNTHETIC_REPO)
      expect(await missingReleaseInputs(root)).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('stages docs/user with its exact hierarchy plus root docs and the full third-party tree', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'relpack-repo-'))
    const staging = await mkdtemp(join(tmpdir(), 'relpack-stage-'))
    try {
      await makeTree(repo, SYNTHETIC_REPO)
      await stageUserDocsAndNotices(staging, repo)

      // Hierarchy preserved: docs/user/install.md stays at docs/user/, never flattened.
      expect(await readFile(join(staging, 'docs', 'user', 'install.md'), 'utf8')).toContain('Start.cmd')
      await expect(access(join(staging, 'docs', 'install.md'))).rejects.toMatchObject({ code: 'ENOENT' })
      // License surface included complete, byte for byte.
      expect(await readFile(join(staging, 'CONTRIBUTING.md'), 'utf8')).toBe(SYNTHETIC_REPO['CONTRIBUTING.md'])
      expect(await readFile(join(staging, 'SECURITY.md'), 'utf8')).toBe(SYNTHETIC_REPO['SECURITY.md'])
      expect(await readFile(join(staging, 'third-party', 'mit', 'LICENSE.txt'), 'utf8')).toBe(SYNTHETIC_REPO['third-party/mit/LICENSE.txt'])
      expect(await readFile(join(staging, 'third-party', 'INVENTORY.md'), 'utf8')).toBe(SYNTHETIC_REPO['third-party/INVENTORY.md'])
    } finally {
      await rm(repo, { recursive: true, force: true })
      await rm(staging, { recursive: true, force: true })
    }
  })

  it('behavior-tests packaged links: all resolve inside the package, broken or escaping ones are reported', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'relpack-repo-'))
    const staging = await mkdtemp(join(tmpdir(), 'relpack-stage-'))
    try {
      await makeTree(repo, SYNTHETIC_REPO)
      await stageUserDocsAndNotices(staging, repo)
      // README.md and THIRD-PARTY-NOTICES.md reach the package root via the runBuild
      // ROOT_FILES loop, not this helper; mirror that here so the link gate sees them.
      await makeTree(staging, {
        'README.md': SYNTHETIC_REPO['README.md'],
        'THIRD-PARTY-NOTICES.md': SYNTHETIC_REPO['THIRD-PARTY-NOTICES.md'],
      })

      const mdFiles = [
        join(staging, 'README.md'),
        join(staging, 'CONTRIBUTING.md'),
        join(staging, 'SECURITY.md'),
        join(staging, 'THIRD-PARTY-NOTICES.md'),
        join(staging, 'docs', 'user', 'README.md'),
        join(staging, 'docs', 'user', 'install.md'),
      ]
      // The release-shaped link set (docs/user/..., ../../CONTRIBUTING.md,
      // third-party/...) resolves entirely inside the staged package.
      expect(await findBrokenPackageLinks(staging, mdFiles)).toEqual([])

      // A dead link and one that escapes the package root are both reported.
      await writeFile(join(staging, 'docs', 'user', 'install.md'), '# 安装\n见 [缺失](../missing-guide.md) 与 [外部](../../../escape.md)。')
      await writeFile(join(staging, '..', 'escape.md'), 'outside the package')
      expect(await findBrokenPackageLinks(staging, mdFiles)).toEqual([
        'docs/user/install.md -> ../missing-guide.md',
        'docs/user/install.md -> ../../../escape.md (outside the package)',
      ])
    } finally {
      await rm(repo, { recursive: true, force: true })
      await rm(staging, { recursive: true, force: true })
    }
  })
})

describe('output reservation lock', () => {
  const ARTIFACT = 'kline-trainer-v0.3.0-windows-x64'

  it('reserves exclusively, names the holder and refuses to wait or steal', async () => {
    const out = await mkdtemp(join(tmpdir(), 'relpack-lock-'))
    try {
      const first = await reserveOutputs(out, ARTIFACT, 'owner-1')
      expect(first.lockPath).toContain(`.${ARTIFACT}.build.lock`)
      expect(JSON.parse(await readFile(first.lockPath, 'utf8'))).toMatchObject({ ownerId: 'owner-1', artifactName: ARTIFACT })

      await expect(reserveOutputs(out, ARTIFACT, 'owner-2')).rejects.toThrow(/refusing to wait or to steal[\s\S]*owner-1/)
      // The losing attempt left the winner's reservation untouched.
      expect(JSON.parse(await readFile(first.lockPath, 'utf8')).ownerId).toBe('owner-1')

      await releaseOutputs(first)
      const second = await reserveOutputs(out, ARTIFACT, 'owner-2')
      expect(second.ownerId).toBe('owner-2')
      await releaseOutputs(second)
    } finally {
      await rm(out, { recursive: true, force: true })
    }
  })

  it('releases only its own reservation; a rewritten foreign lock is never removed', async () => {
    const out = await mkdtemp(join(tmpdir(), 'relpack-lock-foreign-'))
    try {
      const reservation = await reserveOutputs(out, ARTIFACT, 'mine')
      await writeFile(reservation.lockPath, JSON.stringify({ ownerId: 'someone-else' }) + '\n')
      await expect(releaseOutputs(reservation)).resolves.toBeUndefined()
      expect(await readFile(reservation.lockPath, 'utf8')).toContain('someone-else')
      await rm(reservation.lockPath, { force: true })
      // An already-vanished lock is fine to "release".
      await expect(releaseOutputs(reservation)).resolves.toBeUndefined()
    } finally {
      await rm(out, { recursive: true, force: true })
    }
  })
})

describe('publishFileExclusive', () => {
  it('never replaces an existing target and keeps the sentinel plus its own partial', async () => {
    const out = await mkdtemp(join(tmpdir(), 'relpack-pub-'))
    try {
      const dest = join(out, 'SHA256SUMS')
      await writeFile(dest, 'PRIOR-RELEASE-SUMS')
      const source = join(out, 'new-sums')
      await writeFile(source, 'NEW-SUMS')

      await expect(publishFileExclusive(source, dest)).rejects.toThrow(/Refusing to overwrite existing release output/)
      expect(await readFile(dest, 'utf8')).toBe('PRIOR-RELEASE-SUMS')
      const partials = (await readdir(out)).filter(name => name.endsWith('.partial'))
      expect(partials).toHaveLength(1)

      // A free destination name publishes normally.
      const fresh = join(out, 'SHA256SUMS.v2')
      await expect(publishFileExclusive(source, fresh)).resolves.toBe(fresh)
      expect(await readFile(fresh, 'utf8')).toBe('NEW-SUMS')
      expect((await readdir(out)).filter(name => name.endsWith('.partial'))).toEqual(partials)
    } finally {
      await rm(out, { recursive: true, force: true })
    }
  })

  it('parallel publication to one name has exactly one winner and one diagnosable partial', async () => {
    const out = await mkdtemp(join(tmpdir(), 'relpack-race-'))
    try {
      const sourceA = join(out, 'build-a.zip.src')
      const sourceB = join(out, 'build-b.zip.src')
      await writeFile(sourceA, 'BUILD-A-BYTES')
      await writeFile(sourceB, 'BUILD-B-BYTES')
      const dest = join(out, 'kline-trainer-v0.3.0-windows-x64.zip')

      const results = await Promise.allSettled([publishFileExclusive(sourceA, dest), publishFileExclusive(sourceB, dest)])
      const fulfilled = results.filter(result => result.status === 'fulfilled')
      const rejected = results.filter(result => result.status === 'rejected')
      expect(fulfilled).toHaveLength(1)
      expect(rejected).toHaveLength(1)
      expect(String((rejected[0] as PromiseRejectedResult).reason)).toMatch(/Refusing to overwrite existing release output/)

      // The published file is exactly one build's content — never a mixture.
      const published = await readFile(dest, 'utf8')
      expect(published === 'BUILD-A-BYTES' || published === 'BUILD-B-BYTES').toBe(true)
      // The loser leaves its uniquely named partial as evidence; no recursive cleanup ran.
      const partials = (await readdir(out)).filter(name => name.endsWith('.partial'))
      expect(partials).toHaveLength(1)
    } finally {
      await rm(out, { recursive: true, force: true })
    }
  })
})

describe.skipIf(process.platform !== 'win32')('PowerShell packaging helpers (win32)', () => {
  it('pins the compression contract: -LiteralPath and $ErrorActionPreference=Stop', () => {
    expect(PACKAGE_PS1).toContain("$ErrorActionPreference = 'Stop'")
    expect(PACKAGE_PS1).toContain('Expand-Archive -LiteralPath $Source -DestinationPath $Destination')
    expect(PACKAGE_PS1).toContain('Compress-Archive -LiteralPath $Source -DestinationPath $Destination')
    expect(PACKAGE_PS1).not.toMatch(/Compress-Archive -Path/)
  })

  it('round-trips a directory whose path contains wildcard characters', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'relpack-ps1-'))
    try {
      const ps1 = join(dir, 'package-tools.ps1')
      await writeFile(ps1, PACKAGE_PS1, 'utf8')
      const source = join(dir, 'stage [1] dir')
      await mkdir(join(source, 'nested'), { recursive: true })
      await writeFile(join(source, 'nested', 'app.txt'), 'PAYLOAD-BYTES', 'utf8')
      const zip = join(dir, 'artifact [v1].zip')
      await runPowerShellScript(ps1, ['-Mode', 'compress', '-Source', source, '-Destination', zip])
      const extractDir = join(dir, 'extract [x]')
      await runPowerShellScript(ps1, ['-Mode', 'extract', '-Source', zip, '-Destination', extractDir])
      expect(await readFile(join(extractDir, 'stage [1] dir', 'nested', 'app.txt'), 'utf8')).toBe('PAYLOAD-BYTES')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 60000)

  it('turns a failed cmdlet into a rejected run instead of a silent exit 0', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'relpack-ps1-fail-'))
    try {
      const ps1 = join(dir, 'package-tools.ps1')
      await writeFile(ps1, PACKAGE_PS1, 'utf8')
      await expect(runPowerShellScript(ps1, ['-Mode', 'compress', '-Source', join(dir, 'does-not-exist'), '-Destination', join(dir, 'out.zip')])).rejects.toThrow()
      await expect(access(join(dir, 'out.zip'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 60000)
})

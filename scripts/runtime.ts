import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { buildRun, createRun, runNode, startServer, type RunManifest } from './runtime/run.js'
import { prepareJourneySnapshot } from './runtime/snapshot.js'
import { defaultTdxCandidates, discoverTdxRoot } from '../server/src/tdx/discover.js'

/** Return the retained evidence manifest, including after a preview is stopped. */
export async function runRuntime(root: string, args: string[]): Promise<string> {
  const [command, ...forwarded] = args
  if (!['journey', 'preview', 'build-journey'].includes(command)) {
    throw new Error('Usage: runtime.ts journey [...playwright args] | preview | build-journey')
  }
  if (command !== 'journey' && forwarded.length) throw new Error(`${command} does not accept extra arguments`)
  const controller = new AbortController()
  const onSignal = () => controller.abort(new Error('Runtime interrupted'))
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  let server: Awaited<ReturnType<typeof startServer>> | undefined
  let run: RunManifest | undefined
  try {
    const source = process.env.TDX_ROOT?.trim()
    const tdxRoot = command === 'preview'
      ? (await discoverTdxRoot(source ? [source] : defaultTdxCandidates()))?.root
      : source
    run = await createRun(root, command === 'preview' ? 'dev' : 'journey', { tdxRoot })
    console.log(`Run manifest: ${run.manifestPath}`)
    if (command === 'journey') await prepareJourneySnapshot(run)
    await buildRun(run, command === 'preview' ? 'production' : 'journey', { signal: controller.signal })
    if (command === 'build-journey') return run.manifestPath
    controller.signal.throwIfAborted()
    server = await startServer(run)
    controller.signal.throwIfAborted()
    console.log(`Isolated server: ${run.baseURL}`)
    if (command === 'journey') {
      await runNode(run, [join(run.root, 'node_modules/@playwright/test/cli.js'), 'test', ...forwarded], 'journey.log', { signal: controller.signal })
    } else {
      await new Promise<void>(resolveStopped => {
        if (controller.signal.aborted) resolveStopped()
        else controller.signal.addEventListener('abort', () => resolveStopped(), { once: true })
      })
    }
    return run.manifestPath
  } finally {
    await server?.stop()
    process.removeListener('SIGINT', onSignal)
    process.removeListener('SIGTERM', onSignal)
    if (run) console.log(`Evidence retained: ${run.artifactsDir}`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runRuntime(process.cwd(), process.argv.slice(2)).catch(error => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}

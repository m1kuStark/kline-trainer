import Fastify from 'fastify'
import cors from '@fastify/cors'
import staticFiles from '@fastify/static'
import { registerApi } from './api.js'
import { loadConfig } from './config.js'
import { ensureDatabaseDirectory, migrateDatabase, openDatabase } from './db.js'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { writeFile, rename, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'

const config = await loadConfig()
await ensureDatabaseDirectory(config.databasePath)
const database = openDatabase(config.databasePath)
migrateDatabase(database)

const app = Fastify({ logger: true })
app.get('/api/health', async () => ({ status: 'ok', runId: config.runId ?? null, pid: process.pid }))
await app.register(cors, { origin: true })
await registerApi(app, config, database)

const serverDirectory = dirname(fileURLToPath(import.meta.url))
const webDirectory = config.staticDirectory ?? join(serverDirectory, '..', '..', 'web', 'dist')
// wildcard 模式：按请求读文件，rebuild 换 hash 后无需重启即可服务新资产
await app.register(staticFiles, { root: webDirectory })

let closing: Promise<void> | undefined
async function shutdown() {
  return closing ??= (async () => {
    await app.close()
    database.close()
    if (config.readyFile) await rm(config.readyFile, { force: true })
    if (process.connected) process.disconnect()
  })()
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => { void shutdown().catch(error => { console.error(error); process.exitCode = 1 }) })
}
process.on('message', message => {
  if (message && typeof message === 'object' && 'type' in message && 'runId' in message
    && message.type === 'trainer:shutdown' && message.runId === config.runId) {
    void shutdown().catch(error => { console.error(error); process.exitCode = 1 })
  }
})
process.once('disconnect', () => { void shutdown().catch(error => { console.error(error); process.exitCode = 1 }) })

const url = await app.listen({ port: config.port, host: config.host })
const address = app.server.address()
if (!address || typeof address === 'string') throw new Error('Server did not bind a TCP port')
if (config.readyFile) {
  const temporary = `${config.readyFile}.${randomUUID()}.tmp`
  await writeFile(temporary, JSON.stringify({ runId: config.runId ?? null, pid: process.pid, baseURL: url, port: address.port }), { flag: 'wx' })
  await rename(temporary, config.readyFile)
}
console.log(`A-share K-line trainer server listening at ${url}`)

if (process.env.OPEN_BROWSER !== '0' && !process.env.VITEST) {
  const command = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open'
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
  const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true })
  child.unref()
}

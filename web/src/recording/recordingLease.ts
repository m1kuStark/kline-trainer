/** One writer per recording across tabs. The browser also releases the lock on tab termination. */
export async function acquireRecordingLease(id: string): Promise<(() => void) | null> {
  if (!navigator.locks) throw new Error('当前浏览器不支持安全续录，请使用新版 Edge 或 Chrome')
  return new Promise((resolve, reject) => {
    let release!: () => void
    const finished = new Promise<void>(done => { release = done })
    void navigator.locks.request(`trainer.recording.${id}`, { ifAvailable: true }, async lock => {
      if (!lock) { resolve(null); return }
      resolve(release)
      await finished
    }).catch(reject)
  })
}

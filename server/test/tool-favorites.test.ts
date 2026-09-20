import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import {
  DEFAULT_FAVORITE_TOOLS, FAVORITE_TOOLS_STORAGE_KEY, loadFavoriteTools,
  moveFavoriteTool, reconcileFavoriteTools, saveFavoriteTools,
} from '../../web/src/toolFavorites'

describe('custom drawing favorites', () => {
  it('restores defaults for missing, malformed, or obsolete settings', () => {
    for (const raw of [null, '{broken', '{}', '["removedTool"]']) {
      expect(loadFavoriteTools({ getItem: () => raw })).toEqual(DEFAULT_FAVORITE_TOOLS)
    }
  })

  it('preserves order and intentionally empty favorites while dropping duplicate and unknown names', () => {
    expect(reconcileFavoriteTools(['priceLine', 'segment', 'priceLine', 7, 'removedTool']))
      .toEqual(['priceLine', 'segment'])
    expect(reconcileFavoriteTools([])).toEqual([])
  })

  it('moves in either direction by final position without mutating the input', () => {
    const before = ['segment', 'rayLine', 'priceLine']
    expect(moveFavoriteTool(before, 'segment', 2)).toEqual(['rayLine', 'priceLine', 'segment'])
    expect(moveFavoriteTool(before, 'priceLine', 0)).toEqual(['priceLine', 'segment', 'rayLine'])
    expect(before).toEqual(['segment', 'rayLine', 'priceLine'])
  })

  it('adds from other tools, removes to other tools, and bounds insertion indices', () => {
    expect(moveFavoriteTool(['segment'], 'rectangle', 100)).toEqual(['segment', 'rectangle'])
    expect(moveFavoriteTool(['segment'], 'rectangle', -3)).toEqual(['rectangle', 'segment'])
    expect(moveFavoriteTool(['segment', 'rectangle'], 'segment', null)).toEqual(['rectangle'])
    expect(moveFavoriteTool(['segment'], 'unknown', 0)).toEqual(['segment'])
  })

  it('round trips ordered favorites under the versioned key', () => {
    const store = new Map<string, string>()
    const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value) } }
    expect(saveFavoriteTools(storage, ['priceLine', 'segment'])).toBe(true)
    expect([...store.keys()]).toEqual([FAVORITE_TOOLS_STORAGE_KEY])
    expect(loadFavoriteTools(storage)).toEqual(['priceLine', 'segment'])
    expect(saveFavoriteTools(storage, [])).toBe(true)
    expect(loadFavoriteTools(storage)).toEqual([])
  })

  it('keeps toolbar usable when browser storage is unavailable', () => {
    expect(loadFavoriteTools({ getItem: () => { throw new Error('storage disabled') } })).toEqual(DEFAULT_FAVORITE_TOOLS)
    expect(saveFavoriteTools({ setItem: () => { throw new Error('quota exceeded') } }, ['segment'])).toBe(false)
  })

  it('isolates customization hotkeys and pins save feedback outside the scrolling tool list', async () => {
    const source = await readFile(new URL('../../web/src/views/Training.vue', import.meta.url), 'utf8')
    const styles = await readFile(new URL('../../web/src/styles.css', import.meta.url), 'utf8')
    expect(source).toMatch(/if \(customizingTools\.value\) \{[\s\S]*?return\s*\}/)
    expect(source).toMatch(/class="favorite-tools tool-list"/)
    expect(source).toMatch(/class="other-tools tool-list"/)
    expect(source).toMatch(/class="drawing-save-footer"/)
    expect(styles).toMatch(/\.drawing-save-footer\s*\{[^}]*height: 28px/)
    expect(styles).toMatch(/\.toolbar-tool-lists\s*\{[^}]*overflow-y: auto/)
  })
})

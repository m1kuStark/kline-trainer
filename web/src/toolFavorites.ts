import { DRAW_TOOLS } from './drawTools'

export const FAVORITE_TOOLS_STORAGE_KEY = 'trainer.favoriteTools.v1'
export const DEFAULT_FAVORITE_TOOLS = [
  'segment', 'rayLine', 'straightLine', 'horizontalStraightLine',
  'verticalStraightLine', 'priceLine', 'percentageLine',
]

const knownTools = new Set(DRAW_TOOLS.map(tool => tool.name))

export function reconcileFavoriteTools(value: unknown): string[] {
  if (!Array.isArray(value)) return [...DEFAULT_FAVORITE_TOOLS]
  const names = [...new Set(value.filter((name): name is string => typeof name === 'string' && knownTools.has(name)))]
  return value.length > 0 && names.length === 0 ? [...DEFAULT_FAVORITE_TOOLS] : names
}

export function moveFavoriteTool(favorites: readonly string[], name: string, index: number | null): string[] {
  if (!knownTools.has(name)) return [...favorites]
  const remaining = favorites.filter(tool => tool !== name)
  if (index !== null) {
    const position = Number.isFinite(index) ? Math.max(0, Math.min(remaining.length, Math.trunc(index))) : remaining.length
    remaining.splice(position, 0, name)
  }
  return remaining
}

export function loadFavoriteTools(storage: Pick<Storage, 'getItem'>): string[] {
  try {
    const raw = storage.getItem(FAVORITE_TOOLS_STORAGE_KEY)
    return raw === null ? [...DEFAULT_FAVORITE_TOOLS] : reconcileFavoriteTools(JSON.parse(raw))
  } catch {
    return [...DEFAULT_FAVORITE_TOOLS]
  }
}

export function saveFavoriteTools(storage: Pick<Storage, 'setItem'>, favorites: readonly string[]): boolean {
  try {
    storage.setItem(FAVORITE_TOOLS_STORAGE_KEY, JSON.stringify(favorites))
    return true
  } catch {
    return false
  }
}

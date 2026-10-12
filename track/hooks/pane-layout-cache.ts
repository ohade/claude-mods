export type RegionLayout = {
  qHead: number; sHead: number; qRows: number; sRows: number
  qLast: number; sLast: number; qStart: number; qEnd: number; sStart: number; sEnd: number
}

// Keep only measurements used by the current drawing. Width changes discard
// them; edited text gets a new key. Content churn cannot grow this cache forever.
export const createPaneLayoutCache = (measure: (text: string, width: number) => number) => {
  let columns = 0
  const heights = new Map<string, number>()
  const layouts = new Map<string, RegionLayout>()
  const usedHeights = new Set<string>()
  const usedLayouts = new Set<string>()
  return {
    begin(width: number) {
      if (width !== columns) {
        columns = width
        heights.clear()
        layouts.clear()
      }
      usedHeights.clear()
      usedLayouts.clear()
    },
    lines(text: string, width: number) {
      const key = `${width}:${text}`
      usedHeights.add(key)
      const cached = heights.get(key)
      if (cached !== undefined) return cached
      const height = measure(text, width)
      heights.set(key, height)
      return height
    },
    layout(key: string, calculate: () => RegionLayout) {
      usedLayouts.add(key)
      const cached = layouts.get(key)
      if (cached !== undefined) return cached
      const value = calculate()
      layouts.set(key, value)
      return value
    },
    finish() {
      for (const key of heights.keys()) if (!usedHeights.has(key)) heights.delete(key)
      for (const key of layouts.keys()) if (!usedLayouts.has(key)) layouts.delete(key)
    },
  }
}

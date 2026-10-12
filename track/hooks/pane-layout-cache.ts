export type RegionLayout = {
  qHead: number; sHead: number; qRows: number; sRows: number
  qLast: number; sLast: number; qStart: number; qEnd: number; sStart: number; sEnd: number
  summaryRows?: number; qArrowWidth?: number; sArrowWidth?: number; briefFooter?: boolean
}

// Heights and layouts follow the current drawing; previews may also belong to
// retained ledger rows outside the viewport. Width changes discard them, and
// edited or removed text is evicted. Content churn cannot grow this cache forever.
export const createPaneLayoutCache = (measure: (text: string, width: number) => number) => {
  let columns = 0
  const heights = new Map<string, number>()
  const previews = new Map<string, string>()
  const layouts = new Map<string, RegionLayout>()
  const usedHeights = new Set<string>()
  const usedPreviews = new Set<string>()
  const usedLayouts = new Set<string>()
  return {
    begin(width: number) {
      if (width !== columns) {
        columns = width
        heights.clear()
        previews.clear()
        layouts.clear()
      }
      usedHeights.clear()
      usedPreviews.clear()
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
    // Retain a current ledger row without clipping it while it is offscreen.
    retainPreview(text: string, width: number) {
      usedPreviews.add(`${width}:${text}`)
    },
    // Full source text and effective width own the display line.
    preview(text: string, width: number, clip: () => string) {
      const key = `${width}:${text}`
      usedPreviews.add(key)
      const cached = previews.get(key)
      if (cached !== undefined) return cached
      const value = clip()
      previews.set(key, value)
      return value
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
      for (const key of previews.keys()) if (!usedPreviews.has(key)) previews.delete(key)
      for (const key of layouts.keys()) if (!usedLayouts.has(key)) layouts.delete(key)
    },
  }
}

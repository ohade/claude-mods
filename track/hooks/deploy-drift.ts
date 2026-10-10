// Pure parsing only: the native loader cannot follow engine capabilities across imports.
export const deploymentDriftMessage = (main: string, live: string, receiptText: string): string | undefined => {
  const receipt = JSON.parse(receiptText) as { commit?: string }
  if (!/^[0-9a-f]{40}$/.test(main) || !/^[0-9a-f]{40}$/.test(live)) return
  if (receipt.commit !== live || main === live) return
  return `claude-mods: main ${main.slice(0, 7)} is not live (live ${live.slice(0, 7)}). Run scripts/land.sh main.`
}

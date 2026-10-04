// One thumbnail under a prompt row. `n` and `originalPath` are absent on
// rows stored before the large view existed.
export type Thumb = {
  png: string
  width: number
  height: number
  n?: number
  originalPath?: string
}

// The picture the image pane draws.
export type Shown = { png: string; width: number; height: number; n: number }

// Every image pasted this session, for `/image <n>`: Claude Code's number
// and the decoded original on disk.
export type Pasted = { n: number; originalPath: string }

declare module 'claude-code' {
  interface PluginState {
    'image-thumbs': {
      byRow: StateFamily<Thumb[]>
      shown: Shown | null
      // The large picture a thumbnail expanded into, per `<row key>:<index>`.
      expanded: StateFamily<Shown | null>
      pasted: Pasted[]
    }
  }
}

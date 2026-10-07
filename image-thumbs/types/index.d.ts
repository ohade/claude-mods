// One pasted picture's thumbnail, under Claude Code's number for it.
export type Thumb = {
  png: string
  width: number
  height: number
  n: number
  // The decoded original on disk, for the large view.
  originalPath: string
}

// The picture the image pane draws.
export type Shown = { png: string; width: number; height: number; n: number }

// Every image pasted this session, for `/image <n>`: Claude Code's number
// and the decoded original on disk.
export type Pasted = { n: number; originalPath: string }

declare module 'claude-code' {
  interface PluginState {
    'image-thumbs': {
      // Thumbnails by image number: every row whose text names it draws it.
      byImage: StateFamily<Thumb>
      // How many times each thumbnail asked to be drawn again; part of its key.
      repaints: StateFamily<number>
      shown: Shown | null
      // The large picture a thumbnail expanded into, by image number.
      expanded: StateFamily<Shown | null>
      pasted: Pasted[]
      // The newest picture number a row or a submitted prompt took as its own.
      claimed: number
      // When each picture's [Image #n] landed in the prompt box, in ms.
      pastedAt: StateFamily<number>
      // The saved clipboard files thumbnails were built from.
      used: string[]
      // When the last prompt or slash command was submitted, in ms.
      submittedAt: number
    }
  }
}

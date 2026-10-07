// One pasted picture's thumbnail, under Claude Code's number for it.
export type Thumb = {
  png: string
  // The same pixels in other bytes (sips writes another resolution tag), so
  // the engine sends the picture again when the drawing switches to it.
  twin?: string
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
      // How many times each thumbnail asked to be sent again; odd draws the twin.
      sends: StateFamily<number>
      shown: Shown | null
      // The large picture a thumbnail expanded into, by image number.
      expanded: StateFamily<Shown | null>
      pasted: Pasted[]
    }
  }
}

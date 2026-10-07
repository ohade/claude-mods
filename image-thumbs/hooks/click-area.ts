import type { ClientModule } from 'claude-code'

// How long after a thumbnail first draws its click area asks for it to be
// drawn again.
const REPAINT_MS = 300

// Lies over a picture in a prompt row and draws nothing, so the picture
// beneath shows, and tells the hooks module the number of the picture a left
// click landed on.
//
// On a new thumbnail's first drawing cmux's terminal (Ghostty 1.3.2) can leave
// the box empty until a window resize, which sends every picture again and
// writes its cells again. Changing cells beside it, or sending it again under
// the same id, does not; so shortly after, the click area asks for it to be
// drawn again under a new key, which does both for this picture alone.
const ClickArea: ClientModule<{ n: number }, { isRepaintAsked: true }> = (props, surface) => {
  if (surface.state === undefined) {
    surface.setState({ isRepaintAsked: true })
    const stop = surface.every(REPAINT_MS, () => {
      stop()
      surface.post({ repaint: props.n })
    })
  }
  surface.onPointer(event => {
    if (event.type === 'up' && event.button === 'left') {
      surface.post({ toggle: props.n })
    }
  })

  return surface.elements.Box({})
}

export default ClickArea

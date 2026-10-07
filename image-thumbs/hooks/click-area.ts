import type { ClientModule } from 'claude-code'

// How long after a thumbnail first draws its click area asks once for the
// picture to be sent again: past the few frames of that first drawing.
const RESEND_MS = 300

// Lies over a picture in a prompt row and draws nothing, so the picture
// beneath shows, and tells the hooks module the number of the picture a left
// click landed on.
//
// On a new thumbnail's first drawing cmux's terminal can leave the box empty
// until something redraws it (a scroll, a streaming reply, a click). The same
// pixels sent again once the cells are on screen make it show.
const ClickArea: ClientModule<{ n: number }, { isResendAsked: true }> = (props, surface) => {
  if (surface.state === undefined) {
    surface.setState({ isResendAsked: true })
    const stop = surface.every(RESEND_MS, () => {
      stop()
      surface.post({ resend: props.n })
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

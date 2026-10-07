import type { ClientModule } from 'claude-code'

// How long after a thumbnail first draws its click area asks for the frame to
// light up, and again how long after that for it to go back.
const REPAINT_MS = 300

// Lies over a picture in a prompt row and draws nothing, so the picture
// beneath shows, and tells the hooks module the number of the picture a left
// click landed on.
//
// On a new thumbnail's first drawing cmux's terminal can leave the box empty
// until it paints those rows again (a scroll does it). Shortly after, the
// click area asks for the frame's border to light up and go back: that
// changes cells on the picture's rows, so the terminal paints them again.
// Sending the same picture again would not change a cell.
const ClickArea: ClientModule<{ n: number }, { isRepaintAsked: true }> = (props, surface) => {
  if (surface.state === undefined) {
    surface.setState({ isRepaintAsked: true })
    let asked = 0
    const stop = surface.every(REPAINT_MS, () => {
      asked += 1
      surface.post({ repaint: props.n })
      if (asked === 2) {
        stop()
      }
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

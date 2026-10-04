import type { ClientModule } from 'claude-code'

// Lies over a picture in a prompt row and draws nothing, so the picture
// beneath shows, and tells the hooks module which of the row's pictures a
// left click landed on.
const ClickArea: ClientModule<{ index: number }> = (props, surface) => {
  surface.onPointer(event => {
    if (event.type === 'up' && event.button === 'left') {
      surface.post({ toggle: props.index })
    }
  })

  return surface.elements.Box({})
}

export default ClickArea

import type { ClientModule } from 'claude-code'

// Lies over a reply row while a slash command's pictures wait for a row to
// draw them, and draws nothing. On its first drawing it tells the hooks module
// that this row drew here, so the row takes the pictures and draws them.
// A row another mod draws on its own never draws this, and never takes them;
// a render hook may not write state, so the claim comes this way.
const ClaimArea: ClientModule<{ id: string }, { isClaimed: true }> = (props, surface) => {
  if (surface.state === undefined) {
    surface.setState({ isClaimed: true })
    surface.post({ claim: props.id })
  }

  return surface.elements.Box({})
}

export default ClaimArea

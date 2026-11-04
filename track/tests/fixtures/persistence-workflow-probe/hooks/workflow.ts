// P2.1 capability spike: imported sequencing, with no engine or native state.
export type Ports = {
  read: () => Promise<unknown>
  wait: () => Promise<void>
  write: (value: string) => Promise<void>
  publish: (value: string) => Promise<void>
}

export const workflow = async (ports: Ports, value: string): Promise<void> => {
  await ports.read()
  await ports.wait()
  await ports.write(value)
  if (await ports.read() !== value) throw new Error('probe durable read-back differs')
  await ports.publish(value)
}

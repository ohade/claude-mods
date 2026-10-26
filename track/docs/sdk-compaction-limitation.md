# Compaction without an earlier observation

Track can detect a compaction that omits `session.compact` when it has an earlier
transcript baseline. A prompt read or a main-loop turn end can supply that baseline.

If compaction happens before either observation, and the host sends no callback,
Track cannot distinguish the missing transcript from a rewind. It judges that read
as a rewind. Rows whose source calls disappeared can leave the register, and saved
answers or step results can lose their transcript acknowledgement. This SDK
observation limit remains unresolved; the baseline fixes do not remove it.

The FIXTURE pin `B4 SDK limitation: callback-free compaction before any baseline
read is judged as rewind` in
[track-phase2-baseline-races.test.tsx](../tests/track-phase2-baseline-races.test.tsx)
shows this behavior with neither a compact callback nor a prior prompt read or turn
end. It is a modeled regression control, not proof of callback delivery on a live host.

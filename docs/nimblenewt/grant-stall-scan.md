# Turn on stall detection (grant `recovery.stall-scan`)

Stall detection runs in the dispatcher's tick (card L01b) but stays **off** until the owner gives `service:dispatcher` the right `recovery.stall-scan`. Until then the owner gets one maintenance notice and the scan is skipped; nothing else is affected.

## The instruction

Using the owner credential, call the state API:

```json
{ "v": 1, "op": "grant.create", "commandId": "grant-stall-scan",
  "args": { "grantee": "service:dispatcher", "action": "recovery.stall-scan", "project": "*", "basis": "run stall detection" } }
```

Or say it in the owner chat (it makes permanent rights only, and only when you say "permanently"; a limited right uses `grant.create` with `expiresAt`): *"give service:dispatcher the recovery.stall-scan right everywhere, permanently, to run stall detection"*. The chat shows the grant first; answer "yes" to apply it.

No restart is needed: the scan reads the dispatcher's principal at every tick, so the right counts from the next tick. To take it back, use `grant.list` (with `grantee`) to find the grant and `grant.revoke`, or tell the chat.

The right lets the dispatcher run the stall scan and nothing else (it is not `recovery.read`).

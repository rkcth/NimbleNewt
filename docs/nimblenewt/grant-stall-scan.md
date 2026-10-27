# Turn on stall detection (grant `recovery.stall-scan`)

Stall detection is built and runs in the dispatcher's tick (card L01b), but it stays **off** until the owner gives the dispatcher the narrow right `recovery.stall-scan`. Until then the controller sends the owner one maintenance notice ("Stall detection is not running ...") and skips the scan; nothing else is affected.

## What to grant

| Field | Value |
|---|---|
| grantee | `service:dispatcher` (created by the controller at its first start) |
| action | `recovery.stall-scan` |
| project | `*` (everywhere; a project-scoped grant is refused) |
| source | `direct` |
| basis | any short reason, for example `run stall detection` |

The right lets the dispatcher run the stall scan and nothing else. It does not give the broad `recovery.read`, and it reads no unpublished record.

No restart is needed. The scan reads the dispatcher's principal at every tick, so the grant takes effect at the next tick, and revoking it switches the scan off again at the next tick.

## How, today

**There is no way to do this from outside the process yet.** The state API has no grant operation, the owner chat cannot grant this action, and the controller has no command-line entry. The only call that makes the grant is the owner calling `GrantService.grant` inside the running controller:

```ts
await services.grants.grant(owner, {
  commandId: "grant-stall-scan",
  grantee: "service:dispatcher",
  action: "recovery.stall-scan",
  project: "*",
  source: "direct",
  basis: "run stall detection",
});
```

`owner` is the authenticated owner principal; `services` is `controller.services` from `startController`. Do not start a second controller on the same store to run this: a second controller takes over the epoch and stops the first one's loops.

## What is missing

An owner-facing way to grant a right (a state API operation, and a chat command through U03/U03d). That is card U03e; this file should then be replaced with the one-line instruction.

## How to check that it worked

After the next tick the maintenance notice is not repeated, and a task that stops making progress while not paused appears as a suspected stall in the status view.

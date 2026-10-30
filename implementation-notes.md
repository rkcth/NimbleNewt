
## Joined stop and the end-hook suite on slow storage (unhandledRejection on Windows CI)

- Root cause (test): the suite waited a fixed 10 ms for the end hook and asserted `calls === 1`, with `first`/`second` stop promises left unobserved. On slow PostgreSQL (Windows) the hook was not reached in 10 ms, the assertion threw, the suite closed storage, and the still-running stops then rejected ("the storage is closed") with no handler: `unhandledRejection`.
- Production hazard (real, smaller): a second `stop()` that joined an end in progress still wrote the stopped marker via `#update` first, a write that could land after the end finished or storage closed, and a marker write failing because the attempt ended meanwhile rejected the stop. A joined stop now writes nothing; a marker write failure on an already ended attempt is swallowed.
- Test: handlers attach at once, hook reached by polling, joined stop asserted to leave the dispatch record revision unchanged (fails without the fix on all four backends), both stops asserted to resolve.

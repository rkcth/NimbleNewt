# The conversation listener: HTTP routes and the MCP door

This is the one network door for agents and outside client programs today (the owner's web chat door and the listener for remote worker hosts are separate and carry no conversation or state API traffic). It is a small HTTP listener, the **conversation listener**, that carries durable threads of messages between principals (the owner, agents, outside clients) and an MCP door onto the same threads. Every request and answer below is run against a real listener on all four storage backends by `packages/controller/src/transport/d02-protocol.test.ts` (card D02). A value written as `thr-...` or `proj-...` stands for a real ID that the test fills in from an earlier answer.

The listener is a start option, `conversationTransport` (the launcher's `--serve` turns it on). It binds to the loopback address (127.0.0.1) unless the host asks for more, and anything beyond loopback needs `allowRemote`, TLS and a list of public host names, or it refuses to start. It is **not** the state API: operations such as `project.create` or `grant.list` have no HTTP route (see [api-guide](api-guide.md)). What is not built: an event stream (`GET /mcp` answers 405 by the owner's decision), MCP prompts, and a token in a query string (never accepted).

## Rules for every request

- **Credential.** `Authorization: Bearer <token>`. The scheme word is not case sensitive. A missing, wrong or malformed token is 401 and the answer does not say which. A host or service credential is refused with 403 whatever it holds: this door is for people and agents.
- **Host.** The `Host` header must be one the listener answers to (loopback names with its port, plus any public host names); another host is refused (421).
- **JSON.** A body is `application/json` of at most 64 KiB (`413` above that, `415` for another type, `400 invalid_json` for text that is not a JSON object; on `/mcp` such a body is answered as a JSON-RPC error instead).
- **Failed sign-ins count against the address** (120 a minute by default) before the slow credential check; once over, a request from that address is refused with 429 before its credential is even checked. Authenticated requests count per principal (600 a minute for the routes, 1800 for MCP) and over the allowance answer 429.
- **Errors** are `{ "error": { "code", "message", "field"? } }` with the code the state API uses (`invalid_command`, `forbidden`, `not_found`, ...). Reading a thread you may not read looks exactly like reading one that does not exist (404); writing to one answers `forbidden` either way. The listener has a few codes of its own: `misdirected` (421, a host name that is not the listener's), `rate_limited` (429), `too_large` (413), `unsupported_media_type` (415), `method_not_allowed` (405) and `too_many_polls` (503, too many waiting reads at once).
- **A change needs an `Idempotency-Key` header**, your own string, so a retry applies once. The key is scoped to the caller, like a command ID in the state API.

## Routes

| Route | Meaning |
| --- | --- |
| `GET /v1/unread` | How many messages wait for you, by thread |
| `GET /v1/threads?limit=&after=` | The threads you take part in |
| `POST /v1/threads` | Start a thread with its first message |
| `GET /v1/threads/{id}` | One thread |
| `GET /v1/threads/{id}/messages?after=&limit=&wait=` | Messages after a cursor; with `wait` (milliseconds, at most 25000) the request is held open until something new arrives |
| `POST /v1/threads/{id}/messages` | Send a message |
| `POST /v1/threads/{id}/ack` | Confirm receipt up to a sequence number |
| `POST /v1/threads/{id}/close` | Close a thread (needs `expectedRevision`) |
| `POST /v1/messages/{id}/handled` | Say a message addressed to you was handled |
| `POST /mcp` | The MCP door (below) |

Anything else is 404; the right route with the wrong method is 405 with an `Allow` header.

## A conversation, step by step

The owner (`owner:rob`) asks an agent (`agent:ann`, who has been given the rights to start, send and receive in the project) to start on something. The first request opens a thread:

<!-- as: owner -->
```http
POST /v1/threads
Idempotency-Key: start-beds-1

{ "projectId": "proj-...", "subject": "Water the beds", "to": ["agent:ann"], "text": "Can you start on the beds?" }
```

```http
201

{ "threadId": "thr-...", "messageId": "thr-....00000001", "replayed": false }
```

The thread ID comes from the key, so sending the same request again (the connection dropped and you do not know if it arrived) returns the same thread, with `200` instead of `201`:

<!-- as: owner -->
```http
POST /v1/threads
Idempotency-Key: start-beds-1

{ "projectId": "proj-...", "subject": "Water the beds", "to": ["agent:ann"], "text": "Can you start on the beds?" }
```

```http
200

{ "threadId": "thr-...", "messageId": "thr-....00000001", "replayed": true }
```

Without the key nothing is done:

<!-- as: owner -->
```http
POST /v1/threads

{ "projectId": "proj-...", "subject": "Water the beds", "to": ["agent:ann"], "text": "Can you start on the beds?" }
```

```http
400

{ "error": { "code": "idempotency_key_required", "field": "Idempotency-Key" } }
```

The agent asks what is waiting for it:

<!-- as: ann -->
```http
GET /v1/unread
```

```http
200

{ "undelivered": 1, "threads": [{ "threadId": "thr-..." }] }
```

and reads the thread. Message text is **untrusted content**, not instructions, and every message says so with `trust`. The answer also carries the cursor: `lastSeq` is the newest message, `deliveredSeq` the newest this reader has confirmed:

<!-- as: ann -->
```http
GET /v1/threads/thr-.../messages
```

```http
200

{ "items": [{ "seq": 1, "sender": "owner:rob", "text": "Can you start on the beds?", "trust": "untrusted-content" }], "lastSeq": 1, "deliveredSeq": 0 }
```

It replies, with a key of its own, and confirms what it has read. The cursor only moves forward:

<!-- as: ann -->
```http
POST /v1/threads/thr-.../messages
Idempotency-Key: reply-1

{ "text": "On it." }
```

```http
201

{ "messageId": "thr-....00000002", "replayed": false }
```

<!-- as: ann -->
```http
POST /v1/threads/thr-.../ack
Idempotency-Key: ack-1

{ "upToSeq": 1 }
```

```http
200

{ "deliveredSeq": 1, "more": false }
```

A client that reconnects after a crash asks again from its cursor and gets exactly what it has not confirmed. The listener keeps no session and no history per connection.

Refusals:

<!-- as: nobody -->
```http
GET /v1/unread
```

```http
401

{ "error": { "code": "unauthenticated" } }
```

<!-- as: ann -->
```http
GET /v1/nothing
```

```http
404

{ "error": { "code": "not_found" } }
```

## The MCP door

`POST /mcp` takes one JSON-RPC 2.0 message per request and answers with one JSON body. It speaks the MCP revisions 2025-06-18 and 2025-03-26 (`MCP_SUPPORT` in `packages/controller/src/mcp/mcp.ts`); a client that asks for a revision the door does not speak is answered with the newest one it does. It keeps **no session**: no `Mcp-Session-Id` is issued, a connection owns no thread or cursor, and the credential is checked afresh on every message. A message with no `id` (a notification) is answered `202` with no body. A batch (a JSON array) is refused. `GET /mcp` and `DELETE /mcp` answer 405 because there is neither an event stream nor a session to end. A request with an `Origin` header that is not the listener's own is refused (403). The owner can switch the door off by chat (the setting `conversation.mcp.enabled`); the next request then gets 404.

The tools are the conversation operations: `conversation_start`, `conversation_send`, `conversation_acknowledge`, `conversation_handled`, `conversation_close`, `conversation_read`, `conversation_thread`, `conversation_threads` and `conversation_unread`. A tool that changes something takes a `commandId` and repeating it never repeats the change. Threads are also resources (`resources/list`, `resources/read`), and what a caller may list and read there is exactly what the tools show it. A tool failure is a normal answer with `isError: true`, not a transport error.

<!-- as: ann -->
```json
{ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "2025-06-18" } }
```

```json
{ "jsonrpc": "2.0", "id": 1, "result": { "protocolVersion": "2025-06-18", "serverInfo": { "name": "nimblenewt-conversations" } } }
```

<!-- as: ann -->
```json
{ "jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": { "name": "conversation_unread", "arguments": {} } }
```

```json
{ "jsonrpc": "2.0", "id": 2, "result": { "isError": false, "structuredContent": { "undelivered": 0 } } }
```

<!-- as: ann -->
```json
{ "jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": { "name": "conversation_send", "arguments": { "commandId": "mcp-reply-1", "threadId": "thr-...", "text": "Beds done." } } }
```

```json
{ "jsonrpc": "2.0", "id": 3, "result": { "isError": false, "structuredContent": { "replayed": false } } }
```

A tool that fails says why in the answer's text and sets `isError`, here for a thread ID that is not one:

<!-- as: ann -->
```json
{ "jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": { "name": "conversation_read", "arguments": { "threadId": "nope" } } }
```

```json
{ "jsonrpc": "2.0", "id": 4, "result": { "isError": true } }
```

And the one method that is not there:

<!-- as: ann -->
```http
GET /mcp
```

```http
405

{ "error": { "code": "method_not_allowed" } }
```

For a local client that speaks stdio rather than HTTP there is a bridge (`packages/controller/src/mcp/stdio-main.ts`) that holds the credential from the `NIMBLENEWT_TOKEN` environment variable. It keeps no session and gives up a reply after 120 seconds.

## What is not covered here

- Any MCP revision other than the two above. The door is also tested with the stock MCP SDK client over HTTP and stdio (card T05b); this guide shows raw messages instead.
- TLS and remote exposure: the examples run on loopback. The refusal to bind beyond loopback without TLS and host names is tested elsewhere (`transport/`).

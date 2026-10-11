# Agent state and conversation APIs

NimbleNewt exposes one controller-owned API contract to its UI, local workers, other harnesses, and authorized external agents. The API is part of the product vision; it is not implemented or scheduled. [The architecture task](../paperclip-backlog.md#aii-251--n01--agree-on-architecture-and-first-useful-release) chooses the initial transport and wire format before implementation. The contract below describes required behavior rather than fixed URLs or a database schema.

## Durable state API

Authorized clients can create, read, edit, and query task and agent state: assignments, lifecycle intent and observed state, checkpoints, owner-written desk records, decisions, message references, and evidence links. Every response identifies the durable object, revision, provenance, and whether a requested change was merely accepted or has actually taken effect. Reads support bounded filtering and pagination so a client need not load an entire agent history.

An agent writes its own permitted desk records. Other agents can read shared work records within their project and audience scope but cannot edit them; private scratch remains private from peers and supervisors unless a specific grant says otherwise. Human and service identities have separately scoped capabilities. A friendly agent name is never a routing or authorization key. Direct API calls, UI actions, and harness tools pass through the same controller checks; access to backing files or indexes cannot grant a second write path.

Writes use a stable operation ID and expected object revision. The controller atomically rejects stale edits and records an auditable event for each accepted mutation. Repeating the same request returns the prior outcome rather than applying it twice. External effects have separate intent, outcome, and reconciliation records: retrying a state edit cannot silently repeat a payment, deployment, or tool action. Long-running commands expose accepted, queued, running, completed, blocked, failed, and outcome-unknown states as appropriate. Acknowledged changes, event cursors, and subscriptions survive controller and worker restarts.

Lifecycle gates remain effective at this boundary. A paused agent can receive permitted queued messages and state updates without resuming its task. Suspension makes its saved records readable but does not release its assignments. Only a completed, authorized Suspend and Release permits ordinary reassignment. Stop does not delete history or convert an unknown external outcome into success. Stale workers are fenced from writes even if they reconnect with a valid old credential.

## Two-way conversation API

Either a NimbleNewt agent or an authorized external agent can start a thread, address a permitted participant, send a message, read new turns, and send a reply or follow-up in the same thread. Conversations are multi-turn and asynchronous; neither participant must keep a request open while the other thinks or works. A recipient can ask the sender a question in return. Conversation identity, participant IDs, message IDs, reply-to links, ordering, and delivery cursors are durable and independent of any live connection or model context.

The controller authenticates the sender and checks recipient discovery, project scope, message type, and delegated authority. A message is untrusted content, not an instruction from the human owner or a grant of access to the recipient desk. Agents answer using only permitted context and may publish selected evidence without exposing private scratch, secrets, or another project. A message that requests an action enters the normal authorization and task workflow; a conversational reply alone does not prove the action was completed.

Remote API exposure is opt-in. Bind locally by default; remote access requires a configured protected transport and revocable, scoped client credentials. Record the authenticated client separately from any claimed sender identity in message content. An external messaging client is not a registered worker and cannot acquire tool, task, or filesystem capabilities by joining a thread.

Sending, accepting, delivering, handling, and answering are distinct recorded states. Clients can reconnect from a cursor and retrieve missed turns. Stable message IDs deduplicate retries after timeouts. Queue limits, batching, rate limits, causation links, and loop detection keep agents from continually interrupting one another. Routine questions wait for a suitable boundary; urgent requests follow explicit priority and lifecycle policy. Paused or suspended recipients report queued or unavailable state honestly, and manual holds are never lifted by an incoming message.

## Transport and harness integration

The durable store and controller contract are authoritative. An initial remote interface could use authenticated HTTPS requests to send or reply, with cursor-based long-polling or server-sent events for new turns. WebSockets are another candidate for low-latency live exchange. All choices must recover after disconnects from durable message IDs and cursors; a socket or protocol session is never the conversation record. Local clients may use a simpler transport while preserving identical permissions and results. The choice remains open in the [decision register](design-decisions.md).

An optional Model Context Protocol (MCP) adapter can expose state and conversation operations as tools and permitted records as resources to compatible harnesses. It calls the same controller API and cannot gain authority through the model or the adapter. MCP is an integration surface, not the owner of NimbleNewt threads or a requirement for clients that do not use MCP. The current MCP specification uses stateless HTTP requests and explicit handles for application state; do not rely on an MCP connection to preserve a conversation. Recheck its versioned contract when implementing the adapter. See the [MCP 2026-07-28 specification update](https://blog.modelcontextprotocol.io/posts/2026-07-28/) and [TypeScript SDK transport guidance](https://ts.sdk.modelcontextprotocol.io/v2/).

## Qualification

- An authorized client edits state, restarts its process, and reads the committed revision on macOS, Linux, and Windows. Competing updates reject stale writers and repeated requests apply once.
- A direct API caller cannot read private scratch, write a peer desk, cross a project boundary, impersonate the owner, or bypass Pause, Suspend, and review gates.
- An external agent and a NimbleNewt agent each initiate a thread and carry on several back-and-forth turns. Either can disconnect and resume without missing or duplicating a message.
- A busy or suspended recipient reports queue or unavailability state; routine traffic does not repeatedly interrupt work, and a loop of replies is bounded.
- Transport adapters, including an MCP adapter if selected, produce the same authorized state and conversation outcomes. Restart and protocol upgrades preserve thread IDs, cursors, and audit history.

The proposed Paperclip tasks are [AII-519, state API](../paperclip-backlog.md#aii-519--n07a--expose-a-durable-state-api) and [AII-520, conversation API](../paperclip-backlog.md#aii-520--n10a--expose-an-inter-agent-conversation-api). Both remain unassigned in Backlog behind the human activation gate.

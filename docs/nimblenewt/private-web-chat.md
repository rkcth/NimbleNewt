# Private web chat: reaching NimbleNewt from your phone

Written 2026-11-10 (card U07). The web chat is the owner's chat in a phone browser: chat, approvals, status, blockers, cost and recovery, in one responsive page. It is **private by construction**: the controller refuses to bind it to a public address, to a wildcard address or to a host name, and it refuses any connection from outside the network you declared. **No VPN or tunnel vendor is required.** Tailscale is the example below because it is the easiest; any private network that gives the machine a private address works the same way.

## What you get

- One page (`/`) with five views next to the chat: Status, Needs you, Blockers, Cost and Recovery, plus a list of the browsers signed in.
- Everything the chat does is reachable by free text, as everywhere else in NimbleNewt. The page adds buttons for what is awkward to type on a phone: Apply and Discard on a proposal, quick questions, and the Pause and Resume recovery orders. Recovery orders are typed commands, so they work when the assistant (the model) is down.
- If the connection drops (the phone sleeps, you walk out of range), what you wrote waits in an outbox on the phone and is sent again when the connection returns, **with the same message id**. The controller records each message under that id, so the second send returns the first answer and runs nothing twice. An approval is sent under its own key in the same way.
- Sign-in is the owner's credential, or a one-time pairing code made from a browser that is already signed in (so you never type the long credential on a phone). The cookie is `HttpOnly` and `SameSite=Strict`, and `Secure` over HTTPS. The credential is held in the controller's memory only, never in the page, a record or a log.
- A session ends by idle time (24 hours), by an absolute limit (7 days), by sign-out, when you sign it out from another browser (**Browsers** tab), when you rotate the owner's credential (checked on every request) and when the controller restarts. Failed sign-ins are counted per network address.

## Wiring it

The controller does not depend on the UI package; you pass the page files in. In your start script (see [Getting started](getting-started.md), step 1), next to `chat`:

```js
import { startController } from "./packages/controller/dist/index.js";
import { webChatAssets } from "./packages/ui/dist/index.js";

const controller = await startController({
  /* storage, argv, env, chat: { interpreter, ... } as before */
  webChat: {
    host: "127.0.0.1",            // required: an IP address, never a name and never 0.0.0.0
    network: "loopback",          // required: "loopback" or "private"; never "public"
    port: 8787,
    behindTlsProxy: true,         // a TLS proxy on this machine fronts it (Option A or C below)
    publicHosts: ["newt.example-tailnet.ts.net"],   // the names your phone uses
    assets: webChatAssets(),
  },
});
console.log("web chat on", controller.webChat.url);
// A pairing code for the phone (valid five minutes, works once):
console.log((await controller.webChat.createPairing(ownerToken)).code);
```

The web chat needs the owner chat (`chat` option); without it the controller refuses to start. The binding rules, all enforced at start:

| You state | The address must be | Also needed |
| --- | --- | --- |
| `network: "loopback"` | 127.0.0.0/8 or ::1 | with `publicHosts` and no `tls`: `behindTlsProxy: true` |
| `network: "private"` | 10/8, 172.16/12, 192.168/16, 100.64/10 (what Tailscale and similar hand out), 169.254/16, fc00::/7 (includes Tailscale's `fd7a:115c:a1e0::/48`), fe80::/10 | `tls` (cert and key) and `publicHosts` |

Anything else is refused with a message: `0.0.0.0` and `::` (every interface), public addresses, and host names (which could resolve to anything). On every request the controller also checks the connecting address against the same network and the `Host` header against `publicHosts` (this defeats DNS rebinding), and a change must come from a page of the listener itself (CSRF header, same-origin `Origin`, JSON).

## Option A: Tailscale Serve (HTTPS from your tailnet, nothing public)

1. Install Tailscale on the NimbleNewt machine and the phone, and sign both in to the same tailnet. Enable HTTPS certificates for the tailnet in its admin settings. The machine now has a name such as `newt-box.tail1234.ts.net`.
2. Start the controller with `host: "127.0.0.1"`, `network: "loopback"`, `behindTlsProxy: true`, `publicHosts: ["newt-box.tail1234.ts.net"]` (the example above).
3. Tell Tailscale to proxy HTTPS to the loopback port. The command line differs between versions: check `tailscale serve --help`; a current one is `tailscale serve --bg 8787`. **Use `serve`, never `funnel`:** Funnel publishes the port to the whole internet, which is exactly what this guide excludes.
4. On the phone, open `https://newt-box.tail1234.ts.net/`, sign in with the pairing code, and add the page to the home screen if you like (it has an app manifest).

The listener itself is still bound to loopback, so the only way to it is through the proxy; the proxy is only reachable from your tailnet.

## Option B: any private network and your own certificate

For WireGuard, ZeroTier, Nebula, a home LAN with a VPN into it, or any network that gives the machine a private address:

1. Give the machine a private address and a name your devices resolve (a hosts-file or private DNS entry is enough).
2. Make a certificate for that name that the phone trusts: a private certificate authority installed on the phone (`mkcert`, `step-ca`, `openssl`), or an ACME certificate through a DNS challenge if you own a domain.
3. Start with `host: "10.8.0.1"` (the private address), `network: "private"`, `tls: { cert, key }` (the PEM text), `publicHosts: ["newt.home.example"]`, `port: 8787` or 443.

## Option C: a reverse proxy on the same machine, or an SSH tunnel

- Caddy or nginx on the machine, listening only on the private address and terminating TLS, in front of the loopback listener: as Option A, with the proxy in place of Tailscale Serve. Pass the client's `Host` header through. The controller never trusts `X-Forwarded-For`, so all clients share the proxy's address for the sign-in allowance.
- A laptop can use `ssh -L 8787:127.0.0.1:8787 machine` and open `http://localhost:8787/` (loopback binding, no proxy, no `publicHosts`): the cookie is then not `Secure`, which is fine because nothing leaves the SSH connection.

## Check that nothing is public

Do these once, and again after any network change:

1. `ss -ltn | grep 8787` (Linux) or `lsof -iTCP:8787 -sTCP:LISTEN` shows only `127.0.0.1` or your private address, never `0.0.0.0` or `*` or `[::]`.
2. From a device **outside** your private network (phone on mobile data with the VPN off), the address does not answer at all.
3. No router port-forward and no cloud firewall rule points at the port. `tailscale funnel status` shows nothing for it.
4. `curl -sI -H 'Host: wrong.example' http://127.0.0.1:8787/` answers 421.
5. Sign in on the phone, open **Browsers**, sign out the other browser, and check that browser gets signed out on its next action.

## Running it

- **Lost phone:** from any other signed-in browser, **Browsers**, then **Sign out all other browsers** (this also cancels every unused pairing code); or rotate the owner's credential (`PrincipalService.issueCredential`), which ends every session on its next request; or restart the controller. In code, `controller.webChat.revokeAll(ownerId)`.
- **Credential rotation** means the pairing and sign-in use the new credential from then on.
- **The transcript** on the phone (your messages and the answers, last 100) is in the browser's local storage so a reload resumes. Signing out removes it. A phone whose storage is blocked still works, but cannot resume after a reload.
- **Limits** (`webChat.limits`, `webChat.session`): 16 KiB request bodies, 300 requests a minute per session, 10 failed sign-ins a minute per address, 20 sessions, 24 h idle, 7 days absolute, a pairing code lives 5 minutes.

## What this does not do

- It is not a deployment: nothing here starts a service, changes a firewall or installs a VPN. That stays with you.
- It does not give anyone but the owner a way in. Agents, clients and hosts have their own routes (the conversation listener, the worker channel).
- There is no second factor beyond the network and the credential, and sessions are lost on a restart. Both are listed in the implementation notes (card U07).

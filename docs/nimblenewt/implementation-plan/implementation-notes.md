# Implementation notes and known limitations

Running record of limitations found while implementing task cards. Each entry names the card that should resolve it.

- **Install scripts (for F03):** `npm install` warns that install scripts of `@google/genai` (preinstall, a no-op echo) and `protobufjs` (postinstall) are not covered by `allowScripts`. Both arrive through Pi Durable's `pi-ai` dependency. F03 must decide an explicit allow/deny policy and capture it with the license inventory.
- **Minimum Node (for F03):** `engines` requires Node >=22.19.0 and `@types/node` is pinned to 22.x so that typecheck matches the minimum. Only Node 24.21.0 on Linux has been exercised so far; F03 must run the oldest supported Node and macOS/Windows.
- **Database isolation is convention (F01):** the boundary check restricts package dependencies and imports, but does not forbid built-ins such as `node:sqlite` inside `pi-adapter`.

# Notices and licenses

## NimbleNewt's own license

NimbleNewt is released under the **MIT License**; the text is in [LICENSE](../../LICENSE) and every package's `package.json` says `"license": "MIT"`. The copyright line reads "NimbleNewt contributors". By contributing you agree that your contribution is offered under the same license (see [CONTRIBUTING.md](../../CONTRIBUTING.md)).

## Third-party software

NimbleNewt does not copy third-party source into this repository. Dependencies are installed from the npm registry by `npm ci` from the exact versions and integrity hashes in `package-lock.json`, with install scripts disabled (`.npmrc`). They keep their own licenses, which come with each package in `node_modules/<package>/`.

The full list, with each package's exact version, license, whether it is needed at run time or only for development, and whether it declares an install script, is the generated file [implementation-plan/license-inventory.md](implementation-plan/license-inventory.md). **Do not edit it by hand:** `npm run licenses:write` regenerates it from the lockfile and `npm run licenses:check` (part of `npm test`) fails when it is stale or when any package has a license outside the allow-list.

### The allow-list and why

| License | Obligation in short |
| --- | --- |
| MIT, ISC, 0BSD, Unlicense | Keep the copyright and permission notice (not for 0BSD and the Unlicense) |
| BSD-2-Clause, BSD-3-Clause | Keep the copyright notice and conditions; do not use contributors' names to endorse |
| Apache-2.0 | Keep the license and any `NOTICE` file; state significant changes; includes a patent grant |

SPDX `OR` expressions need one allowed branch; `AND` expressions need all of them. A copyleft license (GPL, LGPL, AGPL, MPL, EUPL, SSPL and similar), a "source available" license, or a package with no license is refused by the check, so adding such a dependency is a deliberate decision to change the allow-list as its own reviewed change, not a side effect of an upgrade.

The most important third-party parts, all MIT licensed: Pi Durable and its companion packages (`@earendil-works/pi-durable`, `pi-ai`, `chord`, `pi-codemode`, `pi-telemetry`), `pg` (PostgreSQL client), the MCP SDK (`@modelcontextprotocol/sdk`). TypeScript is Apache-2.0 and is a build tool only. The embedded PostgreSQL server used by tests (`embedded-postgres`) is MIT, ships PostgreSQL itself under the PostgreSQL License, and is a development dependency only.

## Redistributing

The repository is source only. Anyone who redistributes a built copy that includes `node_modules` must include each package's own license text and, for Apache-2.0 packages, its `NOTICE` file; the files are already in each package folder, so copying `node_modules` whole satisfies it. **Not done:** a release build that assembles a single combined notices file. It belongs with release packaging, which is not built.

## What is not covered by the code license

- **Models.** NimbleNewt ships no model. A model you point it at has its own license and terms, and a provider's terms govern what you may send it.
- **Names.** "Pi Durable", "MCP", "PostgreSQL" and the like are the names of other people's projects, used to say what NimbleNewt works with.
- **The mascot.** The images in `assets/` (the mascot) were made with an AI image tool from the prompts in the same folder. The repository's license file does not say separately how they are licensed; the owner has not recorded different terms. They are not needed to run NimbleNewt.

## If you find a problem

A dependency whose license is not what the lockfile says, a missing notice, or a file you believe was copied without permission: tell us through a public issue (these are not security reports), naming the package and version.

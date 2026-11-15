# Security policy

NimbleNewt is a controller that lets AI agents work on a person's own projects on their own hardware, so a security problem here can mean someone else's agent, or someone else, doing things as you. We want to hear about those problems and we ask you to tell us privately first.

## Reporting a vulnerability

**Please do not open a public issue, pull request or discussion for a suspected vulnerability.**

Report it through GitHub's private vulnerability reporting on this repository: open the repository's **Security** tab, choose **Report a vulnerability** and fill in the form. Only the maintainers can read it. If that button is not there (it is a repository setting the owner has to switch on), open an ordinary issue that says only "I have a security report and need a private way to send it", with no details, and a maintainer will reply with a private channel.

A useful report says:

- what you found and what it lets someone do (read, change, run, impersonate, deny service);
- the version or commit, your operating system and whether you used SQLite or PostgreSQL;
- the smallest steps that show it. Use synthetic data: do not send real credentials, real project contents or anyone's personal data;
- whether you have told anyone else.

## What to expect

NimbleNewt is developed by a very small team and agents, so these are intentions, not a contract:

- we acknowledge a report within **7 days**;
- we tell you whether we think it is a vulnerability, and our plan, within **30 days**;
- we fix confirmed problems as fast as their seriousness calls for and tell you before we publish;
- we credit you in the fix notes if you want to be named, and we do not if you do not.

We will not take legal action against research that follows this policy: it stays on your own installation, uses synthetic data, does not harm other people's data or systems and stops when you have shown the problem.

## Which versions are supported

NimbleNewt has no stable release yet; it is under development. **Only the current `main` branch receives security fixes.** When tagged releases exist, this section will name which of them are supported and for how long. The environments that are tested, and the ones the controller refuses to start on, are listed in [compatibility and support](docs/nimblenewt/compatibility-and-support.md).

## What is in scope

- Anything that lets a principal (an agent, a client, another project's agent) do or read something its grants do not allow, including reaching another project's data or an agent's scratch space.
- A way past the owner's approval gates, the review gates, or the protected-branch rules.
- A way to obtain, guess or replay a credential, or to learn a secret from a log, an answer, an error message, a backup or the database.
- Escaping the sandbox that confines an agent's tools.
- A flaw in the conversation listener, the web chat or the MCP door: authentication, host and origin checks, rate limits, request sizes.
- A flaw in backup, restore, update or rollback that lets someone replace what is installed or restored.
- A dependency with a known vulnerability that is reachable in NimbleNewt's use of it. The dependency list is [license-inventory.md](docs/nimblenewt/implementation-plan/license-inventory.md).

## What is out of scope

- Problems that need the owner's own credential, or full control of the machine the controller runs on, to begin with.
- Remote exposure that the owner switched on against the guidance (the listener binds to the loopback address unless told otherwise and refuses remote use without TLS and host names).
- Behaviour of a model: an agent that says something wrong or unwise is a quality issue unless it got past a gate to do it.
- Denial of service by someone who already holds a valid credential, within that credential's allowances.
- Reports with no demonstration, scanner output alone, and missing hardening that has no concrete effect.
- The AI model servers, Pi Durable and other third-party software themselves: report those to their own projects (tell us too if NimbleNewt makes them worse).

## How it is meant to be safe

[security-guide](docs/nimblenewt/security-guide.md) explains the model: credentials stored only as salted hashes, grants checked on every call, secrets kept in the operating system's store, install scripts off for dependencies, no telemetry. Please read it before judging whether something is a flaw or a documented limit. [pitfalls-and-safeguards](docs/nimblenewt/pitfalls-and-safeguards.md) lists risks we already know about.

## Handling secrets in your own installation

Never commit a credential, a model key or a database address. Put them in the secret store (`node scripts/nimblenewt.mjs secret set NAME`) and refer to them by name in the configuration. If one is exposed, replace it at its source first, then in NimbleNewt.

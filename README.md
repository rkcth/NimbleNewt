# Relay

Relay is a system for running a persistent team of AI agents that can work independently, collaborate, and resume their work after interruptions or restarts.

One human owner directs agents across software development, QA, operations, marketing, support, graphic design, research, and documentation. Conversation is the primary interface; agents maintain durable context, scoped permissions, and configurable tools and model routes.

## Project status

Relay is in design and runtime evaluation. There is no installable Relay application yet. Pi Durable is the selected runtime direction; the included experiments establish limited recovery behavior, not a complete implementation. macOS, Linux, and Windows are required product targets; the current experiments have only been run on macOS.

- [Full design and document guide](docs/relay/README.md)
- [Accepted decisions and open questions](docs/relay/design-decisions.md)
- [Harness evaluation results](docs/relay/harness-test-results.md)
- [Reproducible harness experiments](benchmarks/relay-harness/README.md)

This standalone local repository was extracted from the original incubation project. Public hosting, licensing, and final branding remain undecided.

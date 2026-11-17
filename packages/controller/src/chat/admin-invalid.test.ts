import assert from "node:assert/strict";
import { after, test } from "node:test";
import { ConfigurationService } from "../configuration/index.js";
import { ConversationService } from "../conversations/index.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PolicyService } from "../policy/index.js";
import { ReviewService } from "../review/index.js";
import { RoutingService } from "../routing/index.js";
import { GrantService } from "../security/index.js";
import { adminIntent } from "../web/door.js";
import { PolicyEditService } from "./index.js";
import { cid, openWorld, options } from "./testing/harness.js";

// Card U08, "invalid values are rejected with path-addressed errors": a value the setting refuses, sent from the Administration page, is refused in words that name the setting's path, whether it is refused
// when the change is drawn up or when it is applied, and nothing is applied. All four storage backends.

after(stopServer);

const CASES: readonly { label: string; key: string; value: unknown; path: RegExp; why: RegExp; at: "apply" | "draft" }[] = [
  { label: "zero days", key: "grants.maxDays", value: 0, path: /set\.grants\.maxDays: /, why: /must be a whole number from 1 to 36500/, at: "apply" },
  { label: "too many days", key: "grants.maxDays", value: 99_999_999, path: /set\.grants\.maxDays: /, why: /from 1 to 36500/, at: "apply" },
  { label: "a fraction", key: "grants.defaultDays", value: 1.5, path: /set\.grants\.defaultDays: /, why: /whole number/, at: "apply" },
  { label: "text for a number", key: "grants.maxDays", value: "ten", path: /set\.grants\.maxDays: /, why: /whole number/, at: "apply" },
  { label: "text for a switch", key: "provider.cloud.enabled", value: "yes", path: /set\.provider\.cloud\.enabled: /, why: /must be true or false/, at: "apply" },
  { label: "a setting that does not exist", key: "grants.nope", value: 3, path: /grants\.nope is not a setting this system has/, why: /Known settings: /, at: "draft" },
];

for (const backend of backends) {
  test(`${backend.name}: a value the setting refuses, sent from the page, is refused with an error that names the setting's path, and nothing is applied (card U08)`, async () => {
    const w = await openWorld(backend, {});
    try {
      const storage = w.world.storage, epoch = w.projects.epoch;
      const configuration = ConfigurationService.withEpoch(storage, epoch, { ...options, routing: RoutingService.withEpoch(storage, epoch, options) });
      const grants = GrantService.withEpoch(storage, epoch, options);
      const policy = PolicyService.withEpoch(storage, epoch, grants, options);
      const edits = PolicyEditService.withEpoch(storage, epoch, { policy, reviews: ReviewService.withEpoch(storage, epoch, options), grants, configuration, conversations: ConversationService.withEpoch(storage, epoch, options), interpreter: w.interpreter }, options);
      const chat = w.chat({ policy, policyEdits: edits });
      // A good value first, so "untouched" means something: the value in force is this one throughout.
      const good = adminIntent("setting", { key: "grants.maxDays", value: 12 });
      const g = await chat.submit(w.ownerToken, { messageId: cid("ui"), text: good.text }, { fixedIntents: [good.intent] } as never);
      assert.equal((await chat.applyProposal(w.ownerToken, { commandId: cid("ap"), proposalId: (g.outcomes[0] as any).proposalId } as never) as any).applied, true);
      const before = (await configuration.layer(w.owner, "installation"))!;
      for (const c of CASES) {
        const { text, intent } = adminIntent("setting", { key: c.key, value: c.value });
        const turn = await chat.submit(w.ownerToken, { messageId: cid("ui"), text }, { fixedIntents: [intent] } as never);
        const o = turn.outcomes[0] as any;
        let said: string;
        if (c.at === "draft") {
          assert.equal(o.status, "refused", `${c.label}: ${JSON.stringify(o)}`);
          said = `${o.message ?? ""} ${turn.reply.join(" ")}`;
        } else {
          assert.equal(o.status, "proposed", `${c.label}: ${JSON.stringify(o)}`);
          const r = await chat.applyProposal(w.ownerToken, { commandId: cid("ap"), proposalId: o.proposalId } as never) as any;
          assert.equal(r.applied, false, `${c.label}: ${JSON.stringify(r)}`);
          assert.equal(r.failure.code, "invalid_command", c.label);
          said = r.failure.message;
        }
        assert.match(said, c.path, `${c.label}: the error names the setting's path: ${said.slice(0, 200)}`);
        assert.match(said, c.why, c.label);
        const now = (await configuration.layer(w.owner, "installation"))!;
        assert.deepEqual([now.revision, now.history.length, now.applied["grants.maxDays"]!.value], [before.revision, before.history.length, 12], `${c.label}: nothing applied`);
        assert.equal(now.applied["grants.defaultDays"], undefined, c.label);
      }
    } finally { await w.close(); }
  });
}

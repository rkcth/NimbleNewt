import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { PLAN_FILE, requestId } from "@nimblenewt/contracts";
import { COMPLETION_CHECK_RULE, COMPLETION_END_RULE, COMPLETION_JOB_RULE, COMPLETION_RULES, COMPLETION_RULE_GROUPS, JOB_WAKE_RULE_TEXT, PI_AGENT_LAYOUT, PiAdapter, assertStableText, checkLayout, layoutFingerprint, sharedSystemText } from "./index.js";
import { BRIDGE_TOOL_NAMES, WORK_END_TOOL, createBridge } from "./bridge.js";
import { NUDGE_TEXT, nudgeText } from "./worker/nudge.js";
import { rig, wireBody } from "./testing/wire.js";

// Card W06: the completion rules every Pi agent has in its system prompt.

test("W06: the completion rules are fixed text that passes the layout's stability check, one paragraph per named group", () => {
  assert.doesNotThrow(() => assertStableText("completion", COMPLETION_RULES), "no date, time, UUID, timestamp or generated ID: the same bytes on every turn");
  assert.equal(COMPLETION_RULES, COMPLETION_RULE_GROUPS.join("\n\n"));
  assert.ok(Object.isFrozen(COMPLETION_RULE_GROUPS));
  assert.ok(COMPLETION_RULES.length < 3000, `short (${COMPLETION_RULES.length} characters)`);
  for (const needle of ["PLAN.md", "- [ ] ...", "- [x] ...", "Keep each step small", "You do not commit", "evidence", "checks the task names", "must pass", "blocked or partial", "never report done for work that is not done", "Never end with prose alone"]) assert.ok(COMPLETION_RULES.includes(needle), needle);
  // W05 checks a done only for a task whose contract names evidence or checks (and tells that task so at the start); a done of any other task is taken unchecked, so the rule must not say every done is checked.
  assert.ok(COMPLETION_CHECK_RULE.includes("When the task names required evidence or checks (you are told so at the start), a done is checked"), COMPLETION_CHECK_RULE);
  assert.ok(!/When you end with result done, the controller checks/.test(COMPLETION_RULES));
  // W06 second review: the plan file is a working note; W05's change against the base does not count it (GitBridge.doneState), and the rules say so with the shared name.
  assert.ok(COMPLETION_CHECK_RULE.includes(`a change against the task's base other than ${PLAN_FILE} (your plan is a working note, not the work)`), COMPLETION_CHECK_RULE);
  assert.equal(COMPLETION_RULES.match(/PLAN\.md/g)?.length, 3, "the plan, check and end rules each name the plan file");
  assert.ok(COMPLETION_END_RULE.includes(WORK_END_TOOL) && BRIDGE_TOOL_NAMES.includes(WORK_END_TOOL), "names the real work.end tool");
  assert.ok(COMPLETION_JOB_RULE.endsWith(JOB_WAKE_RULE_TEXT), "the job rule is W11's sentence, word for word");
  assert.ok(BRIDGE_TOOL_NAMES.includes("nimblenewt__job-start") && COMPLETION_JOB_RULE.includes("nimblenewt__job-start"));
});

test("W06: no agent-facing text tells a Pi agent to commit (the checkout has no git directory); the nudge and the work.end tool agree with the rules", () => {
  const tools = createBridge({ send: async () => ({ ok: true, result: {} }) }).tools;
  const workEnd = tools.find((t) => t.name === WORK_END_TOOL)!;
  const jobStart = tools.find((t) => t.name === "nimblenewt__job-start")!;
  const texts: Record<string, string> = { rules: COMPLETION_RULES, nudge: NUDGE_TEXT, lengthNudge: nudgeText("length"), workEnd: workEnd.description, jobStart: jobStart.description };
  // "commit" may only appear as "you do not commit" or "it is committed after review" / "do not commit them".
  for (const [name, text] of Object.entries(texts)) {
    const left = text.replace(/you do not commit( them)?/gi, "").replace(/it is committed after review/gi, "");
    assert.ok(!/commit/i.test(left), `${name} says commit: ${text}`);
  }
  for (const [name, text] of Object.entries({ rules: COMPLETION_RULES, nudge: NUDGE_TEXT })) {
    assert.ok(text.includes(WORK_END_TOOL) && /blocked or partial/.test(text) && /PLAN\.md/.test(text), `${name}: work.end, the honest endings and PLAN.md`);
  }
  assert.match(workEnd.description, /last call/);
  assert.match(jobStart.description, /woken once/);
});

test("W06: a layout with the rules renders them first; an empty preamble is allowed only with them; the fingerprint and the shared text cover them", () => {
  assert.equal(sharedSystemText(PI_AGENT_LAYOUT), `<nn_completion>\n${COMPLETION_RULES}\n</nn_completion>`);
  assert.ok(Object.isFrozen(PI_AGENT_LAYOUT));
  assert.deepEqual(checkLayout(PI_AGENT_LAYOUT), { completionRules: true, preamble: "" });
  assert.throws(() => checkLayout({ preamble: "" }), /needs a preamble/);
  assert.throws(() => checkLayout({ completionRules: true, preamble: "  " }), /needs a preamble/);
  assert.throws(() => checkLayout({ completionRules: "yes" as never, preamble: "p" }), /true or false/);
  const withRules = sharedSystemText({ completionRules: true, preamble: "Be exact.", project: "Aster." });
  assert.ok(withRules.startsWith(`<nn_completion>\n${COMPLETION_RULES}\n</nn_completion>\n\n<nn_preamble>\nBe exact.\n</nn_preamble>`));
  assert.equal(sharedSystemText({ preamble: "Be exact." }), "<nn_preamble>\nBe exact.\n</nn_preamble>", "a layout without the rules is as before");
  assert.notEqual(layoutFingerprint({ preamble: "p" }, []), layoutFingerprint({ preamble: "p", completionRules: true }, []));
  assert.equal(layoutFingerprint({ preamble: "p" }, []), layoutFingerprint({ preamble: "p", completionRules: false }, []), "false is the default");
});

test("W06: an adapter opened with the worker's layout sends exactly the rules as its system text, and nothing else (Anthropic and OpenAI-style)", async () => {
  for (const api of ["anthropic-messages", "openai-completions"] as const) {
    const world = rig(api);
    const adapter = await PiAdapter.open({ storage: new MemoryStorage(), models: world.models, model: world.ref, promptLayout: PI_AGENT_LAYOUT });
    try {
      world.reply("one");
      await (await adapter.root().submit({ kind: "input", requestId: requestId("r1"), content: "hello" })).result();
      const sections = (world.seen[0]!.context.messages[0] as { sections?: Record<string, string> }).sections!;
      assert.deepEqual(sections, { nn_completion: sharedSystemText(PI_AGENT_LAYOUT) }, api);
      const body = await wireBody(world.seen[0]!);
      const system = api === "anthropic-messages" ? (body["system"] as { text: string }[]).map((s) => s.text).join("\n\n") : String((body["messages"] as { content: unknown }[])[0]!.content);
      assert.equal(system, sharedSystemText(PI_AGENT_LAYOUT), api);
    } finally { await adapter.close(); }
  }
});

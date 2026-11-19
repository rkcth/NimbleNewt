import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { bridgeToolName } from "../bridge.js";

const write = (title: string) => fauxAssistantMessage(fauxToolCall(bridgeToolName("desk.write"), { kind: "note", title, body: "text", visibility: "private" }, { id: "call_0" }), { stopReason: "toolUse" });
/** The model's replies in the G04 follow-up bridge crash test: three desk writes, each under the provider call ID `call_0`, then a final answer. The child is killed during the second. */
export const BRIDGE_CRASH_REPLIES = [write("one"), write("two"), write("three"), fauxAssistantMessage("written")];

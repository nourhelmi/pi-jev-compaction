import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { SessionManager, type ExtensionAPI, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { registerJev } from "../extensions/jev.ts";
import {
  applyPruning, candidates, configuration, ENTRY_TYPE, ledger, MAX_REQUEST_BYTES,
  original, reference, requestBody, score, textOf, type Config, type ToolResult,
} from "../src/pruning.ts";

const config: Config = { ...configuration({}), apiKey: "test-key", keepRecentTokens: 2_000 };
type StoredMessage = Parameters<SessionManager["appendMessage"]>[0];
function pair(id: string, name = "read", input = { path: `${id}.ts` }): StoredMessage[] {
  return [{
    role: "assistant", content: [
      { type: "thinking", thinking: "PRIVATE_REASONING", thinkingSignature: "PRIVATE_SIGNATURE" },
      { type: "text", text: `Inspect ${id}`, textSignature: "KEEP_SIGNATURE" },
      { type: "toolCall", id, name, arguments: input },
    ], api: "openai-responses", provider: "openai", model: "test", stopReason: "toolUse", timestamp: 1,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  }, { role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text: `BEGIN_${id}\n${"old code\n".repeat(600)}END_${id}` }],
    details: { private: "PRIVATE_DETAILS" }, isError: false, timestamp: 2 }];
}
function transcript(): StoredMessage[] {
  return [{ role: "user", content: "Fix the parser. Keep the public API unchanged.", timestamp: 0 },
    ...pair("old"), ...pair("also-old"),
    { role: "custom", customType: "checkpoint", content: "PRIVATE_CHECKPOINT", display: false, timestamp: 3 },
    { role: "user", content: "Current task: finish the parser. " + "recent work ".repeat(1_000), timestamp: 4 }];
}
function fakeFetch(probability = 0.1, inspect?: (body: Record<string, any>, init: RequestInit) => void): typeof fetch {
  return (async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    inspect?.(body, init!);
    return Response.json({ answers: Object.fromEntries(Object.keys(body.questions).map(key => [key, { noul: probability }])), usage: { input_tokens: 100 } });
  }) as typeof fetch;
}
function harness(fetcher: typeof fetch = fakeFetch(), settings = config, sm = SessionManager.inMemory("/tmp/pi-jev-test")) {
  for (const message of transcript()) sm.appendMessage(message);
  const handlers = new Map<string, ((event: any, ctx: ExtensionContext) => any)[]>();
  const tools = new Map<string, ToolDefinition>();
  const notices: string[] = [];
  const statuses: string[] = [];
  let pressure: number | null = 70_000;
  let active = ["jev_read"];
  const ctx = {
    sessionManager: sm, model: { contextWindow: 100_000 }, getContextUsage: () => pressure === null ? null : ({ tokens: pressure }),
    hasUI: true, ui: { notify: (text: string) => notices.push(text), setStatus(_id: string, text?: string) { if (text) statuses.push(text); } },
  } as unknown as ExtensionContext;
  const pi = {
    on(name: string, fn: (event: unknown, ctx: ExtensionContext) => unknown) { handlers.set(name, [...(handlers.get(name) ?? []), fn]); },
    appendEntry(type: string, data: unknown) { sm.appendCustomEntry(type, data); },
    registerTool(tool: ToolDefinition) { tools.set(tool.name, tool); },
    registerCommand() {}, getActiveTools() { return active; },
  } as unknown as ExtensionAPI;
  registerJev(pi, { config: settings, fetch: fetcher });
  return { sm, handlers, tools, notices, statuses, ctx, pi,
    pressure(value: number | null) { pressure = value; }, active(value: string[]) { active = value; },
    async fire(type: string, event: any = {}) {
      let result: any;
      for (const fn of handlers.get(type) ?? []) result = await fn(event, ctx);
      return result;
    },
  };
}

test("candidate selection protects recent batches, errors, skills, images, tool loading, coordination and ambiguous pairs", () => {
  const messages = transcript();
  assert.equal(candidates(messages, new Set(), 2_000).length, 2);
  const error = pair("error"); (error[1] as ToolResult).isError = true;
  const image = pair("image"); (image[1] as ToolResult).content.push({ type: "image", data: "PRIVATE_IMAGE", mimeType: "image/png" });
  const loaded = pair("loaded"); Object.assign(loaded[1]!, { addedToolNames: ["new_tool"] });
  const skipped = [...error, ...image, ...loaded, ...pair("skill", "read", { path: "/skills/test/SKILL.md" }),
    ...pair("job", "bg_agent"), ...pair("retrieval", "jev_read"), ...pair("orphan").slice(1),
    ...pair("duplicate"), ...pair("duplicate"), messages.at(-1)!];
  assert.deepEqual(candidates(skipped, new Set(), 2_000), []);
  const batch = pair("one");
  (batch[0] as Extract<AgentMessage, { role: "assistant" }>).content.push({ type: "toolCall", id: "two", name: "read", arguments: {} });
  const last = pair("two")[1] as ToolResult; last.content = [{ type: "text", text: "x".repeat(20_000) }];
  assert.deepEqual(candidates([...batch, last], new Set(), 2_000), [], "protect the whole latest parallel batch");
});

test("projection keeps message order, calls, signatures, metadata and originals; stable replay is idempotent", () => {
  const messages = transcript();
  const before = structuredClone(messages);
  const candidate = candidates(messages, new Set(), 2_000)[0]!;
  const projected = applyPruning(messages, new Set([candidate.ref]));
  assert.deepEqual(messages, before);
  assert.equal(projected.length, messages.length);
  for (let i = 0; i < messages.length; i++) {
    if (messages[i] !== candidate.result) assert.equal(projected[i], messages[i]);
    else {
      assert.deepEqual({ ...projected[i], content: [] }, { ...messages[i], content: [] });
      assert.match(textOf(projected[i] as ToolResult), /jev_read/);
      assert.match(textOf(projected[i] as ToolResult), /Do not rerun/);
    }
  }
  assert.deepEqual(applyPruning(projected, new Set([candidate.ref])), projected);
});

test("Jev requests contain bounded excerpts, not private reasoning, images, metadata or custom messages", () => {
  const messages = transcript();
  const choices = candidates(messages, new Set(), 2_000);
  const request = requestBody(messages, choices, config.model);
  assert.ok(Buffer.byteLength(request.body) <= MAX_REQUEST_BYTES);
  assert.match(request.body, /BEGIN_old/);
  assert.match(request.body, /END_old/);
  assert.doesNotMatch(request.body, /PRIVATE_|KEEP_SIGNATURE/);
  const unicode = choices.map((item, i) => ({ ...item, ref: String(i), input: { path: "漢字".repeat(4_000) }, result: { ...item.result, content: [{ type: "text" as const, text: "漢字".repeat(5_000) }] } }));
  const many = Array.from({ length: 16 }, (_, i) => unicode[i % unicode.length]!);
  const bounded = requestBody(messages, many, config.model);
  assert.ok(Buffer.byteLength(bounded.body) <= MAX_REQUEST_BYTES);
  assert.ok(bounded.choices.length < 16);
});

test("scoring validates every probability before accepting a batch", async () => {
  const messages = transcript(), choices = candidates(messages, new Set(), 2_000);
  assert.equal((await score(messages, choices, config, undefined, fakeFetch())).refs.length, 2);
  assert.equal((await score(messages, choices, config, undefined, fakeFetch(0.9))).refs.length, 0);
  for (const invalid of [{}, { answers: {} }, { answers: { r0: { noul: 0 }, r1: { noul: 2 } } }, { answers: { r0: { noul: -1 }, r1: { noul: 0 } } }]) {
    await assert.rejects(score(messages, choices, config, undefined, (async () => Response.json(invalid)) as typeof fetch));
  }
  await assert.rejects(score(messages, choices, config, undefined, (async () => new Response("secret echoed by provider", { status: 429 })) as typeof fetch), error => String(error).includes("429") && !String(error).includes("secret"));
  await assert.rejects(score(messages, choices, config, undefined, (async () => new Response("secret echoed by provider")) as typeof fetch), { message: "Invalid Jev response JSON" });
});

test("HTTP requests have a deadline and propagate abort", async () => {
  const messages = transcript(), choices = candidates(messages, new Set(), 2_000);
  const waiting = (async (_url: unknown, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
    if (init.signal?.aborted) reject(init.signal.reason);
    init.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
  })) as typeof fetch;
  const keepAlive = setTimeout(() => {}, 1_000);
  try {
    await assert.rejects(score(messages, choices, { ...config, timeoutMs: 10 }, undefined, waiting), { name: "TimeoutError" });
    const controller = new AbortController(); controller.abort();
    await assert.rejects(score(messages, choices, config, controller.signal, waiting), { name: "AbortError" });
  } finally { clearTimeout(keepAlive); }
});

test("automatic hook flow persists only masks and retrieval returns exact paged originals", async () => {
  let requests = 0;
  const h = harness(fakeFetch(0.1, () => requests++));
  const messages = h.sm.buildSessionContext().messages;
  const originalEntries = structuredClone(h.sm.getBranch());
  const wanted = candidates(messages, new Set(), 2_000)[0]!;
  await h.fire("turn_end");
  assert.match(h.statuses.at(-1)!, /^Jev: 70\.0% · ~[\d.]+k cleared$/);
  assert.equal(requests, 1);
  assert.deepEqual(h.sm.getBranch().slice(0, originalEntries.length), originalEntries);
  assert.equal(ledger(h.sm.getBranch()).size, 2);
  const result = await h.fire("context", { messages });
  assert.match(textOf(result.messages.find((m: AgentMessage) => m.role === "toolResult" && m.toolCallId === wanted.result.toolCallId)), /cleared/);
  const tool = h.tools.get("jev_read")!;
  const page = await tool.execute("retrieve", { ref: wanted.ref, offset: 7, limit: 31 }, undefined, undefined, h.ctx);
  assert.equal((page.content[0] as { text: string }).text.split("\n").slice(1).join("\n"), textOf(wanted.result).slice(7, 38));
  assert.equal((page.details as any).nextOffset, 38);
  await assert.rejects(tool.execute("retrieve", { ref: wanted.ref, offset: 999_999 }, undefined, undefined, h.ctx), /Offset/);
  await assert.rejects(tool.execute("retrieve", { ref: "0".repeat(24) }, undefined, undefined, h.ctx), /not on this session branch/);
  await h.fire("context", { messages }); await h.fire("turn_end");
  assert.equal(requests, 1, "no network from context or unchanged turns");
  assert.equal(h.handlers.has("session_before_compact"), false, "normal manual/threshold/overflow compaction stays authoritative");
});

test("pressure, missing key, disabled retrieval, null usage and all-keep cooldown", async () => {
  let calls = 0;
  const h = harness(fakeFetch(1, () => calls++));
  h.pressure(10_000); await h.fire("turn_end"); assert.equal(calls, 0);
  h.pressure(null); await h.fire("turn_end"); assert.equal(calls, 0);
  h.pressure(70_000); h.active([]); await h.fire("turn_end"); assert.equal(calls, 0);
  h.active(["jev_read"]); await h.fire("turn_end"); await h.fire("turn_end"); assert.equal(calls, 1);
  assert.equal(ledger(h.sm.getBranch()).size, 0);
  const missing = harness(fakeFetch(0, () => calls++), { ...config, apiKey: "" });
  await missing.fire("session_start"); await missing.fire("turn_end");
  assert.equal(missing.statuses.at(-1), "Jev: dormant");
  assert.equal(await missing.fire("context", { messages: transcript() }), undefined);
  assert.equal(calls, 1);
});

test("disabled retrieval restores originals and prevents in-flight decisions", async () => {
  const h = harness();
  const messages = h.sm.buildSessionContext().messages;
  await h.fire("turn_end");
  h.active([]);
  assert.equal(await h.fire("context", { messages }), undefined);
  h.active(["jev_read"]);
  assert.match(JSON.stringify(await h.fire("context", { messages })), /older tool output cleared/);
  let finish!: () => void;
  const pending = harness((async (_url, init) => {
    await new Promise<void>(resolve => { finish = resolve; });
    return fakeFetch()(_url, init);
  }) as typeof fetch);
  const evaluation = pending.fire("turn_end");
  pending.active([]); finish(); await evaluation;
  assert.equal(ledger(pending.sm.getBranch()).size, 0);
});

test("failed real SessionManager persistence cannot activate masks, even after reload", async t => {
  const dir = mkdtempSync(join(tmpdir(), "pi-jev-persistence-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const h = harness(fakeFetch(), config, SessionManager.create(dir, dir));
  const file = h.sm.getSessionFile()!;
  const saved = readFileSync(file);
  const messages = h.sm.buildSessionContext().messages;
  rmSync(file); mkdirSync(file); // Real EISDIR after Pi has already inserted the entry in memory.
  await h.fire("turn_end");
  assert.equal(h.notices.length, 1);
  assert.equal(ledger(h.sm.getBranch()).size, 0);
  assert.deepEqual((await h.fire("context", { messages })).messages, messages);
  h.handlers.clear(); registerJev(h.pi, { config, fetch: fakeFetch() });
  await h.fire("session_start");
  assert.deepEqual((await h.fire("context", { messages })).messages, messages);
  rmSync(file, { recursive: true }); writeFileSync(file, saved);
  assert.equal(ledger(SessionManager.open(file, dir).getBranch()).size, 0);
});

test("failures and failed persistence commit no new pruning", async () => {
  const h = harness((async () => new Response("bad", { status: 500 })) as typeof fetch);
  const before = structuredClone(h.sm.getBranch());
  await h.fire("turn_end"); await h.fire("turn_end");
  assert.deepEqual(h.sm.getBranch(), before);
  assert.equal(h.notices.length, 1);
  const persist = harness();
  persist.pi.appendEntry = () => { throw new Error("disk unavailable"); };
  await persist.fire("turn_end");
  assert.equal(ledger(persist.sm.getBranch()).size, 0);
});

test("restart and branch navigation recover only branch-local masks and evidence", async () => {
  const h = harness();
  const forkPoint = h.sm.getLeafId()!;
  const target = candidates(h.sm.buildSessionContext().messages, new Set(), 2_000)[0]!;
  await h.fire("turn_end");
  const prunedLeaf = h.sm.getLeafId()!;
  await h.fire("session_start");
  assert.equal(ledger(h.sm.getBranch()).size, 2);
  assert.match(h.statuses.at(-1)!, /cleared$/);
  assert.equal(original(h.sm.getBranch(), target.ref), target.result);
  h.sm.branch(forkPoint); await h.fire("session_tree");
  assert.equal(ledger(h.sm.getBranch()).size, 0);
  const separate = pair("only-sibling"); for (const message of separate) h.sm.appendMessage(message);
  const siblingRef = reference(separate[1] as ToolResult);
  h.sm.branch(prunedLeaf); await h.fire("session_tree");
  assert.equal(ledger(h.sm.getBranch()).size, 2);
  assert.equal(original(h.sm.getBranch(), siblingRef), undefined);
  await h.fire("session_compact");
  assert.equal(ledger(h.sm.getBranch()).size, 2, "old entries remain available for retained-tail masks and evidence");
});

test("late Jev results after a tree change cannot append decisions", async () => {
  let finish!: () => void;
  const h = harness((async (_url, init) => {
    await new Promise<void>(resolve => { finish = resolve; });
    const request = JSON.parse(String(init!.body));
    return Response.json({ answers: Object.fromEntries(Object.keys(request.questions).map(key => [key, { noul: 0 }])) });
  }) as typeof fetch);
  const pending = h.fire("turn_end");
  await h.fire("session_tree"); finish(); await pending;
  assert.equal(ledger(h.sm.getBranch()).size, 0);
});

test("configuration is bounded and ledger rejects unknown versions and malformed references", () => {
  const parsed = configuration({ PI_JEV_THRESHOLD: "999", PI_JEV_TIMEOUT_MS: "-1", PI_JEV_KEEP_THRESHOLD: "NaN" });
  assert.equal(parsed.threshold, 0.65); assert.equal(parsed.timeoutMs, 5_000); assert.equal(parsed.keepThreshold, 0.25);
  const h = harness();
  h.sm.appendCustomEntry(ENTRY_TYPE, { version: 2, refs: ["a".repeat(24)] });
  h.sm.appendCustomEntry(ENTRY_TYPE, { version: 1, refs: ["invalid", 4] });
  assert.equal(ledger(h.sm.getBranch()).size, 0);
});

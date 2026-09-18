import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai/compat";
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { registerJev } from "../extensions/jev.ts";
import { configuration, ledger } from "../src/pruning.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
function sandbox(t: { after(fn: () => void): void }) {
  const path = mkdtempSync(join(tmpdir(), "pi-jev-sdk-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

test("Pi's resource loader loads the actual package entrypoint", async t => {
  const dir = sandbox(t);
  const loader = new DefaultResourceLoader({
    cwd: dir, agentDir: dir, settingsManager: SettingsManager.inMemory(),
    additionalExtensionPaths: [join(root, "extensions/jev.ts")],
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  assert.ok(loaded.extensions[0]!.tools.has("jev_read"));
  assert.ok(loaded.extensions[0]!.handlers.has("turn_end"));
});

test("real Pi agent loop prunes automatically before the next model request", async t => {
  const dir = sandbox(t);
  const sm = SessionManager.inMemory(dir);
  const model: Model<"openai-responses"> = {
    id: "fixture", name: "Fixture", provider: "openai", api: "openai-responses", baseUrl: "https://example.invalid",
    reasoning: false, input: ["text"], contextWindow: 100_000, maxTokens: 4_096,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const assistant = (content: AssistantMessage["content"], input = 0): AssistantMessage => ({
    role: "assistant", content, api: model.api, provider: model.provider, model: model.id,
    stopReason: "stop", timestamp: Date.now(),
    usage: { input, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: input + 1, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  });
  sm.appendMessage({ role: "user", content: "Inspect source then fix it", timestamp: 0 });
  sm.appendMessage(assistant([{ type: "toolCall", id: "old-read", name: "read", arguments: { path: "old.ts" } }]));
  const evidence = { role: "toolResult" as const, toolCallId: "old-read", toolName: "read",
    content: [{ type: "text" as const, text: "ORIGINAL_EVIDENCE\n" + "line\n".repeat(2_000) }], isError: false, timestamp: 1 };
  sm.appendMessage(evidence);
  sm.appendMessage({ role: "user", content: "Latest context " + "recent ".repeat(2_000), timestamp: 2 });
  let evaluations = 0;
  const settings = SettingsManager.inMemory({ compaction: { enabled: true }, retry: { enabled: false } });
  const loader = new DefaultResourceLoader({
    cwd: dir, agentDir: dir, settingsManager: settings,
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [pi => registerJev(pi, {
      config: { ...configuration({}), apiKey: "fixture", keepRecentTokens: 2_000 },
      fetch: (async (_url, init) => {
        evaluations++;
        const request = JSON.parse(String(init?.body));
        return Response.json({ answers: Object.fromEntries(Object.keys(request.questions).map(key => [key, { noul: 0.01 }])) });
      }) as typeof fetch,
    })],
  });
  await loader.reload();
  const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: join(dir, "models.json"), modelsStorePath: join(dir, "models-store.json") });
  await runtime.setRuntimeApiKey("openai", "offline-fixture-key");
  const { session } = await createAgentSession({ cwd: dir, agentDir: dir, model, modelRuntime: runtime,
    resourceLoader: loader, sessionManager: sm, settingsManager: settings, noTools: "builtin", thinkingLevel: "off" });
  t.after(() => session.dispose());
  await session.bindExtensions({ mode: "json" });
  const sent: string[] = [];
  session.agent.streamFunction = (_model, context) => {
    sent.push(JSON.stringify(context.messages));
    const stream = createAssistantMessageEventStream();
    const message = assistant([{ type: "text", text: "Continuing." }], 70_000);
    stream.push({ type: "done", reason: "stop", message });
    stream.end(message);
    return stream;
  };
  await session.prompt("Continue the work.");
  assert.equal(evaluations, 1);
  assert.equal(ledger(sm.getBranch()).size, 1);
  await session.prompt("Continue once more.");
  assert.equal(sent.length, 2);
  assert.match(sent[0]!, /ORIGINAL_EVIDENCE/);
  assert.doesNotMatch(sent[1]!, /ORIGINAL_EVIDENCE/);
  assert.match(sent[1]!, /jev_read/);
  assert.equal(evaluations, 1);
  assert.match(evidence.content[0]!.text, /ORIGINAL_EVIDENCE/);
});

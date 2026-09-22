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
import { Type } from "typebox";
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

test("active Pi tool loop scores concurrently and prunes a later model request", async t => {
  const dir = sandbox(t);
  const sm = SessionManager.inMemory(dir);
  const model: Model<"openai-responses"> = {
    id: "fixture", name: "Fixture", provider: "openai", api: "openai-responses", baseUrl: "https://example.invalid",
    reasoning: false, input: ["text"], contextWindow: 100_000, maxTokens: 4_096,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const assistant = (content: AssistantMessage["content"], input = 0, stopReason: "stop" | "toolUse" = "stop"): AssistantMessage => ({
    role: "assistant", content, api: model.api, provider: model.provider, model: model.id,
    stopReason, timestamp: Date.now(),
    usage: { input, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: input + 1, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  });
  sm.appendMessage({ role: "user", content: "Inspect source then fix it", timestamp: 0 });
  sm.appendMessage(assistant([{ type: "toolCall", id: "old-read", name: "read", arguments: { path: "old.ts" } }]));
  const evidence = { role: "toolResult" as const, toolCallId: "old-read", toolName: "read",
    content: [{ type: "text" as const, text: "ORIGINAL_EVIDENCE\n" + "line\n".repeat(2_000) }], isError: false, timestamp: 1 };
  sm.appendMessage(evidence);
  sm.appendMessage({ role: "user", content: "Latest context " + "recent ".repeat(2_000), timestamp: 2 });
  let evaluations = 0;
  let releaseEvaluation!: () => void;
  const evaluationGate = new Promise<void>(resolve => { releaseEvaluation = resolve; });
  const settings = SettingsManager.inMemory({ compaction: { enabled: true }, retry: { enabled: false } });
  const loader = new DefaultResourceLoader({
    cwd: dir, agentDir: dir, settingsManager: settings,
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [
      pi => pi.registerTool({
        name: "fixture_output", label: "Fixture output", description: "Return fixture output.",
        parameters: Type.Object({}),
        async execute() { return { content: [{ type: "text" as const, text: "fresh output" }], details: {} }; },
      }),
      pi => registerJev(pi, {
        config: { ...configuration({}), apiKey: "fixture", keepRecentTokens: 2_000 },
        fetch: (async (_url, init) => {
          evaluations++;
          const request = JSON.parse(String(init?.body));
          await evaluationGate;
          return Response.json({
            model: "jev-fixture",
            answers: Object.fromEntries(Object.keys(request.questions).map(key => [key, { type: "noul", noul: 0.01 }])),
            usage: { input_tokens: 1, output_tokens: 1 },
          });
        }) as typeof fetch,
      }),
    ],
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
    const request = sent.length;
    const toolUse = request < 3;
    const message = toolUse
      ? assistant([{ type: "toolCall", id: `live-call-${request}`, name: "fixture_output", arguments: {} }], request === 1 ? 70_000 : 0, "toolUse")
      : assistant([{ type: "text", text: "Finished." }]);
    const finish = () => {
      stream.push({ type: "done", reason: toolUse ? "toolUse" : "stop", message });
      stream.end(message);
    };
    if (request === 2) {
      releaseEvaluation();
      setImmediate(() => setImmediate(finish));
    } else finish();
    return stream;
  };
  await session.prompt("Continue the work.");
  assert.equal(sent.length, 3);
  assert.equal(evaluations, 1);
  assert.equal(ledger(sm.getBranch()).size, 1);
  assert.match(sent[0]!, /ORIGINAL_EVIDENCE/);
  assert.match(sent[1]!, /ORIGINAL_EVIDENCE/, "the next request must not wait for unfinished scoring");
  assert.doesNotMatch(sent[2]!, /ORIGINAL_EVIDENCE/);
  assert.match(sent[2]!, /jev_read/);
  assert.match(evidence.content[0]!.text, /ORIGINAL_EVIDENCE/);
});

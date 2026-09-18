import { Type } from "typebox";
import { buildSessionContext, estimateTokens, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  applyPruning, candidates, configuration, ENTRY_TYPE, GROWTH_TOKENS,
  ledger, original, score, textOf, type Config,
} from "../src/pruning.ts";

/** Injectable transport/configuration keep tests entirely offline. */
export function registerJev(pi: ExtensionAPI, options: { config?: Config; fetch?: typeof fetch } = {}): void {
  const config = options.config ?? configuration();
  let lastAttemptTokens = -Infinity;
  let controller: AbortController | undefined;
  let epoch = 0;
  let lastStatus = "No evaluation yet";
  let warned = false;

  const reset = () => {
    epoch++;
    controller?.abort();
    controller = undefined;
    lastAttemptTokens = -Infinity;
    lastStatus = "No evaluation yet";
    warned = false;
  };
  pi.on("session_start", (_event, ctx) => {
    reset();
    if (!config.apiKey && ctx.hasUI) ctx.ui.notify("pi-jev is dormant: set TYPESAFE_API_KEY and reload. Normal Pi compaction remains enabled.", "info");
  });
  pi.on("session_shutdown", reset);
  pi.on("session_tree", reset);
  pi.on("session_compact", reset);

  pi.on("context", (event, ctx) => {
    if (!config.apiKey) return;
    return { messages: applyPruning(event.messages, ledger(ctx.sessionManager.getBranch())) };
  });

  // Runs after tools, before the next assistant request. The context hook itself never makes a network call.
  pi.on("turn_end", async (_event, ctx) => {
    if (!config.apiKey || controller || !ctx.model || !pi.getActiveTools().includes("jev_read")) return;
    const usage = ctx.getContextUsage();
    if (!usage || usage.tokens === null || usage.tokens / ctx.model.contextWindow < config.threshold) return;
    const branch = ctx.sessionManager.getBranch();
    const messages = buildSessionContext(branch).messages;
    const rawTokens = messages.reduce((sum, message) => sum + estimateTokens(message), 0);
    if (rawTokens >= lastAttemptTokens && rawTokens - lastAttemptTokens < GROWTH_TOKENS) return;
    lastAttemptTokens = rawTokens;
    const refs = ledger(branch);
    const choices = candidates(messages, refs, config.keepRecentTokens);
    if (!choices.length) { lastStatus = "No old eligible outputs"; return; }
    const ownController = new AbortController();
    controller = ownController;
    const ownEpoch = epoch;
    const leaf = ctx.sessionManager.getLeafId();
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, ownController.signal]) : ownController.signal;
    try {
      const result = await score(applyPruning(messages, refs), choices, config, signal, options.fetch);
      if (signal.aborted || epoch !== ownEpoch || ctx.sessionManager.getLeafId() !== leaf) return;
      const saved = choices.filter(item => result.refs.includes(item.ref))
        .reduce((sum, item) => sum + estimateTokens(item.result) - estimateTokens(applyPruning([item.result], new Set(result.refs))[0]!), 0);
      if (result.refs.length) pi.appendEntry(ENTRY_TYPE, {
        version: 1, refs: result.refs, model: config.model, evaluated: result.evaluated,
        estimatedTokensCleared: saved, inputTokens: result.inputTokens,
      });
      lastStatus = `${result.refs.length}/${result.evaluated} outputs cleared; ~${saved.toLocaleString()} context tokens removed`;
      warned = false;
      if (ctx.hasUI) ctx.ui.setStatus("pi-jev", `Jev: ${ledger(ctx.sessionManager.getBranch()).size} cleared`);
    } catch (error) {
      if (epoch !== ownEpoch || ownController.signal.aborted || ctx.signal?.aborted) return;
      lastStatus = error instanceof Error ? error.message : "Jev unavailable";
      if (!warned && ctx.hasUI) ctx.ui.notify(`pi-jev: ${lastStatus}. Context unchanged; normal compaction remains available.`, "warning");
      warned = true;
    } finally {
      if (controller === ownController) controller = undefined;
    }
  });

  pi.registerTool({
    name: "jev_read",
    label: "Read cleared output",
    description: "Retrieve original tool output cleared by pi-jev from this session's active branch. Use the ref in its marker. Read original evidence rather than rerunning commands. offset and limit are character counts; maximum page 16000 characters.",
    parameters: Type.Object({
      ref: Type.String({ pattern: "^[a-f0-9]{24}$" }),
      offset: Type.Optional(Type.Integer({ minimum: 0 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 16_000 })),
    }),
    async execute(_id, args, _signal, _update, ctx) {
      const result = original(ctx.sessionManager.getBranch(), args.ref);
      if (!result) throw new Error("Original output is not on this session branch");
      const text = textOf(result);
      const offset = args.offset ?? 0;
      const limit = args.limit ?? 8_000;
      if (offset > text.length) throw new Error(`Offset exceeds output length (${text.length})`);
      const end = Math.min(text.length, offset + limit);
      return {
        content: [{ type: "text", text: `[Original ${result.toolName} output; characters ${offset}–${end} of ${text.length}]\n${text.slice(offset, end)}` }],
        details: { ref: args.ref, offset, nextOffset: end < text.length ? end : null, totalCharacters: text.length },
      };
    },
  });

  pi.registerCommand("jev-status", {
    description: "Show automatic Jev context-clearing status",
    handler: async (_args, ctx) => {
      ctx.ui.notify([
        config.apiKey ? `Automatic at ${Math.round(config.threshold * 100)}% context · ${config.model}` : "Dormant: TYPESAFE_API_KEY is missing",
        `${ledger(ctx.sessionManager.getBranch()).size} cleared outputs on this branch`,
        lastStatus,
      ].join("\n"), "info");
    },
  });
}

export default function jevCompaction(pi: ExtensionAPI): void {
  registerJev(pi);
}

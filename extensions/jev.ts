import { Type } from "typebox";
import {
  CustomEditor, buildSessionContext, estimateTokens, type ExtensionAPI, type ExtensionContext, type SessionEntry, type SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
  applyPruning, candidates, configuration, ENTRY_TYPE, GROWTH_TOKENS,
  ledger, original, score, superseded, textOf, type Config,
} from "../src/pruning.ts";

const EDITOR_COMPONENT_CHANGED_EVENT = "ui-pack:v1:editor-component-changed";
const JEV_EDITOR_FACTORY = "__piJevEditorFactory";
const JEV_EDITOR_LISTENER = Symbol.for("pi-jev.editorChangedListener");
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;

function nativeCheckpoint(branch: readonly SessionEntry[]): boolean {
  const latest = branch.findLast(entry => entry.type === "compaction"
    || (entry.type === "custom" && entry.customType === "openai-codex-native-compaction"));
  return latest?.type === "custom" || (latest?.type === "compaction"
    && (latest.details as { kind?: unknown } | undefined)?.kind === "openai-codex-native-compaction");
}
type EditorFactory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;
type EditorInstance = ReturnType<EditorFactory>;
interface MarkedEditorFactory extends Function { __piJevEditorFactory?: true; }

function isJevEditorFactory(value: unknown): boolean {
  return typeof value === "function" && (value as MarkedEditorFactory).__piJevEditorFactory === true;
}

export function injectJevEditorStatus(
  lines: readonly string[], label: string, style: (text: string) => string = text => text,
): string[] {
  let bottom = -1;
  for (let i = lines.length - 1; i > 0; i--) {
    const plain = lines[i]!.replace(ANSI, "");
    if (/^[╰└┗][─━]+/.test(plain) || /^[─━]+$/.test(plain)) { bottom = i; break; }
  }
  if (bottom < 0) return [...lines];

  const text = ` ${label} · `;
  const line = lines[bottom]!;
  const run = /(─+|━+)/.exec(line);
  if (!run || run[0].length <= text.length + 1) return [...lines];

  const output = [...lines];
  output[bottom] = line.slice(0, run.index)
    + run[0].slice(0, -text.length) + style(text)
    + line.slice(run.index + run[0].length);
  return output;
}

function editorWithStatus(
  inner: EditorInstance,
  label: () => string,
  theme: ExtensionContext["ui"]["theme"],
): EditorInstance {
  return new Proxy(inner, {
    get(target, property) {
      if (property === "render") {
        return (width: number) => injectJevEditorStatus(
          target.render(width), label(), text => theme.fg("muted", text),
        );
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
    set: (target, property, value) => Reflect.set(target, property, value, target),
  });
}

function cumulativeClearedTokens(entries: readonly SessionEntry[]): number {
  let total = 0;
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
    const data = entry.data as { version?: unknown; refs?: unknown; estimatedTokensCleared?: unknown } | undefined;
    if (data?.version !== 1 || !Array.isArray(data.refs) || !data.refs.length
      || !data.refs.every(ref => typeof ref === "string" && /^[a-f0-9]{24}$/.test(ref))) continue;
    if (typeof data.estimatedTokensCleared === "number"
      && Number.isFinite(data.estimatedTokensCleared) && data.estimatedTokensCleared > 0) total += data.estimatedTokensCleared;
  }
  return total;
}

function restoreLeaf(manager: ExtensionContext["sessionManager"], leaf: string | null): void {
  // SAFETY: ExtensionContext exposes the concrete SessionManager as read-only, but appendEntry
  // mutates that same instance before persistence, so rollback must use its public leaf methods.
  const mutable = manager as unknown as Pick<SessionManager, "branch" | "resetLeaf">;
  if (leaf) mutable.branch(leaf); else mutable.resetLeaf();
}

function compactTokens(tokens: number): string {
  if (tokens < 1_000) return tokens.toLocaleString();
  return `${(tokens / 1_000).toFixed(tokens < 10_000 ? 1 : 0).replace(/\.0$/, "")}k`;
}

/** Injectable transport/configuration keep tests entirely offline. */
export function registerJev(pi: ExtensionAPI, options: { config?: Config; fetch?: typeof fetch } = {}): void {
  const config = options.config ?? configuration();
  let lastAttemptTokens = -Infinity;
  let controller: AbortController | undefined;
  let epoch = 0;
  let lastStatus = "No evaluation yet";
  let warned = false;
  let barLabel = `${config.apiKey ? "Jev ready" : "Jev dormant"} · 0 saved`;
  let editorTui: { requestRender(): void } | undefined;
  let editorInstalled = false;

  const installEditorStatus = (ctx: ExtensionContext): boolean => {
    if (ctx.mode !== "tui") return false;
    const current = ctx.ui.getEditorComponent();
    if (isJevEditorFactory(current)) return true;

    const factory: EditorFactory = (tui, theme, keybindings) => {
      editorTui = tui;
      const inner = current?.(tui, theme, keybindings) ?? new CustomEditor(tui, theme, keybindings);
      return editorWithStatus(inner, () => barLabel, ctx.ui.theme);
    };
    Object.defineProperty(factory, JEV_EDITOR_FACTORY, { value: true });
    ctx.ui.setEditorComponent(factory);
    ctx.ui.setStatus("pi-jev", undefined);
    return true;
  };

  const updateStatus = (ctx: ExtensionContext) => {
    const saved = cumulativeClearedTokens(ctx.sessionManager.getEntries());
    const savings = `${saved ? `~${compactTokens(saved)}` : "0"} saved`;
    const active = pi.getActiveTools().includes("jev_read");
    const state = !config.apiKey ? "Jev dormant"
      : !active || nativeCheckpoint(ctx.sessionManager.getBranch()) ? "Jev paused"
      : controller ? "Jev checking…"
      : warned ? "Jev error"
      : "Jev ready";
    barLabel = `${state} · ${savings}`;
    if (editorInstalled && ctx.mode === "tui") { editorTui?.requestRender(); return; }
    if (!ctx.hasUI) return;
    if (!config.apiKey) { ctx.ui.setStatus("pi-jev", `Jev: dormant · ${savings}`); return; }
    if (!active) { ctx.ui.setStatus("pi-jev", `Jev: paused · ${savings} · jev_read inactive`); return; }
    if (nativeCheckpoint(ctx.sessionManager.getBranch())) {
      ctx.ui.setStatus("pi-jev", `Jev: paused · ${savings} · Codex checkpoint owns provider context`);
      return;
    }
    const usage = ctx.getContextUsage();
    const pressure = usage?.tokens !== null && usage?.tokens !== undefined && ctx.model?.contextWindow
      ? `${(usage.tokens / ctx.model.contextWindow * 100).toFixed(1)}%`
      : "waiting";
    ctx.ui.setStatus("pi-jev", `Jev: ${controller ? "checking…" : warned ? "error" : pressure} · ${savings}`);
  };

  const globals = globalThis as Record<PropertyKey, unknown>;
  const previousListener = globals[JEV_EDITOR_LISTENER];
  if (typeof previousListener === "function") previousListener();
  const disposeEditorListener = pi.events?.on(EDITOR_COMPONENT_CHANGED_EVENT, payload => {
    try { editorInstalled = installEditorStatus(payload as ExtensionContext); }
    catch { /* A stale session context can outlive an editor-change event. */ }
  });
  if (disposeEditorListener) globals[JEV_EDITOR_LISTENER] = disposeEditorListener;
  else delete globals[JEV_EDITOR_LISTENER];

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
    editorInstalled = installEditorStatus(ctx);
    if (!config.apiKey && ctx.hasUI) ctx.ui.notify("pi-jev is dormant: set TYPESAFE_API_KEY and reload. Normal Pi compaction remains enabled.", "info");
    updateStatus(ctx);
  });
  pi.on("session_shutdown", (_event, ctx) => {
    reset();
    editorInstalled = false;
    editorTui = undefined;
    if (ctx.hasUI) ctx.ui.setStatus("pi-jev", undefined);
  });
  pi.on("session_tree", (_event, ctx) => { reset(); updateStatus(ctx); });
  pi.on("session_before_compact", (_event, ctx) => { reset(); updateStatus(ctx); });
  pi.on("session_compact", (_event, ctx) => { reset(); updateStatus(ctx); });

  const startEvaluation = (ctx: ExtensionContext): void => {
    if (!config.apiKey || controller || !ctx.model || !pi.getActiveTools().includes("jev_read")) return;
    const branch = ctx.sessionManager.getBranch();
    if (nativeCheckpoint(branch)) return;
    const messages = buildSessionContext(branch).messages;
    const rawTokens = messages.reduce((sum, message) => sum + estimateTokens(message), 0);
    const usageTokens = ctx.getContextUsage()?.tokens ?? 0;
    if (Math.max(rawTokens, usageTokens) / ctx.model.contextWindow < config.threshold) return;
    if (rawTokens >= lastAttemptTokens && rawTokens - lastAttemptTokens < GROWTH_TOKENS) return;
    lastAttemptTokens = rawTokens;
    const refs = ledger(branch);
    const choices = candidates(messages, refs, config.keepRecentTokens);
    if (!choices.length) { lastStatus = "No old eligible outputs"; return; }
    const automatic = superseded(messages, choices, refs);
    const uncertain = choices.filter(item => !automatic.has(item.ref));

    const ownController = new AbortController();
    controller = ownController;
    const ownEpoch = epoch;
    const snapshotLeaf = ctx.sessionManager.getLeafId();
    updateStatus(ctx);

    void (async () => {
      try {
        const result = uncertain.length
          ? await score(applyPruning(messages, refs), uncertain, config, ownController.signal, options.fetch)
          : { refs: [] as string[], evaluated: 0, inputTokens: null };
        if (ownController.signal.aborted || epoch !== ownEpoch || !pi.getActiveTools().includes("jev_read")) return;
        const currentBranch = ctx.sessionManager.getBranch();
        const snapshotIndex = snapshotLeaf ? currentBranch.findIndex(entry => entry.id === snapshotLeaf) : -1;
        if (snapshotLeaf && snapshotIndex < 0) return;
        if (currentBranch.slice(snapshotIndex + 1).some(entry => entry.type === "message" && entry.message.role === "user")) {
          lastAttemptTokens = -Infinity;
          return;
        }
        const currentRefs = ledger(currentBranch);
        const currentMessages = buildSessionContext(currentBranch).messages;
        const eligible = new Set(candidates(currentMessages, currentRefs, config.keepRecentTokens).map(item => item.ref));
        const cleared = choices.filter(item => eligible.has(item.ref)
          && (result.refs.includes(item.ref) || (automatic.has(item.ref) && superseded(currentMessages, [item], currentRefs).has(item.ref))));
        const clearedRefs = new Set(cleared.map(item => item.ref));
        const saved = cleared.reduce((sum, item) => sum + estimateTokens(item.result)
          - estimateTokens(applyPruning([item.result], clearedRefs)[0]!), 0);
        if (cleared.length) {
          const entry = {
            version: 1, refs: [...clearedRefs], model: config.model, evaluated: choices.length,
            estimatedTokensCleared: saved, inputTokens: result.inputTokens,
          };
          const commitLeaf = ctx.sessionManager.getLeafId();
          try { pi.appendEntry(ENTRY_TYPE, entry); }
          catch (error) {
            // Pi advances its in-memory leaf before disk I/O. Invalidate the entry and restore the
            // persisted branch head so later writes cannot become children of an unpersisted ID.
            entry.refs = [];
            restoreLeaf(ctx.sessionManager, commitLeaf);
            throw error;
          }
        }
        lastStatus = `${cleared.length}/${choices.length} outputs cleared; ~${saved.toLocaleString()} context tokens removed`;
        warned = false;
      } catch (error) {
        if (epoch !== ownEpoch || ownController.signal.aborted) return;
        lastStatus = error instanceof Error ? error.message : "Jev unavailable";
        if (!warned && ctx.hasUI) ctx.ui.notify(`pi-jev: ${lastStatus}. Context unchanged; normal compaction remains available.`, "warning");
        warned = true;
      } finally {
        if (controller === ownController) controller = undefined;
        if (epoch === ownEpoch) updateStatus(ctx);
      }
    })();
  };

  pi.on("context", (event, ctx) => {
    if (!config.apiKey) return;
    updateStatus(ctx);
    if (!pi.getActiveTools().includes("jev_read") || nativeCheckpoint(ctx.sessionManager.getBranch())) return;
    const projected = applyPruning(event.messages, ledger(ctx.sessionManager.getBranch()));
    startEvaluation(ctx);
    return { messages: projected };
  });

  // Launch scoring at each live model/tool boundary, then let the next provider request proceed.
  // A concurrent result is committed only while its candidates remain eligible on this branch.
  pi.on("turn_end", (_event, ctx) => {
    updateStatus(ctx);
    startEvaluation(ctx);
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

  pi.registerCommand("jev-reset", {
    description: "Release all Jev-cleared outputs on the active branch",
    handler: async (_args, ctx) => {
      const released = ledger(ctx.sessionManager.getBranch()).size;
      reset();
      if (!released) {
        lastStatus = "No cleared outputs to release";
        updateStatus(ctx);
        ctx.ui.notify(lastStatus, "info");
        return;
      }
      const entry = { version: 1, refs: [] as string[], reset: true };
      const leaf = ctx.sessionManager.getLeafId();
      try { pi.appendEntry(ENTRY_TYPE, entry); }
      catch {
        entry.reset = false;
        restoreLeaf(ctx.sessionManager, leaf);
        lastStatus = "Could not persist mask reset";
        warned = true;
        updateStatus(ctx);
        ctx.ui.notify(`pi-jev: ${lastStatus}; existing masks remain active.`, "warning");
        return;
      }
      lastStatus = `${released} cleared outputs released on this branch`;
      updateStatus(ctx);
      ctx.ui.notify(`pi-jev: ${lastStatus}.`, "info");
    },
  });

  pi.registerCommand("jev-status", {
    description: "Show automatic Jev context-clearing status",
    handler: async (_args, ctx) => {
      const saved = cumulativeClearedTokens(ctx.sessionManager.getEntries());
      ctx.ui.notify([
        config.apiKey ? `Automatic at ${Math.round(config.threshold * 100)}% context · ${config.model}` : "Dormant: TYPESAFE_API_KEY is missing",
        !pi.getActiveTools().includes("jev_read") ? "Paused: jev_read is inactive"
          : nativeCheckpoint(ctx.sessionManager.getBranch()) ? "Paused: Codex checkpoint owns provider context; retrieval active"
          : "Retrieval active",
        `${ledger(ctx.sessionManager.getBranch()).size} cleared outputs on this branch`,
        `Cumulative estimated context saved: ${saved ? `~${compactTokens(saved)}` : "0"} tokens`,
        lastStatus,
      ].join("\n"), "info");
    },
  });
}

export default function jevCompaction(pi: ExtensionAPI): void {
  registerJev(pi);
}

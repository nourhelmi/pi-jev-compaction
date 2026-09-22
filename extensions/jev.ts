import { Type } from "typebox";
import {
  CustomEditor, buildSessionContext, estimateTokens, type ExtensionAPI, type ExtensionContext, type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
  applyPruning, candidates, configuration, ENTRY_TYPE, GROWTH_TOKENS,
  ledger, original, score, textOf, type Config,
} from "../src/pruning.ts";

const EDITOR_COMPONENT_CHANGED_EVENT = "ui-pack:v1:editor-component-changed";
const JEV_EDITOR_FACTORY = "__piJevEditorFactory";
const JEV_EDITOR_LISTENER = Symbol.for("pi-jev.editorChangedListener");
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;

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

function clearedTokens(branch: readonly SessionEntry[]): number {
  let total = 0;
  for (const entry of branch) {
    if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
    const data = entry.data as { version?: unknown; estimatedTokensCleared?: unknown } | undefined;
    if (data?.version === 1 && typeof data.estimatedTokensCleared === "number"
      && Number.isFinite(data.estimatedTokensCleared) && data.estimatedTokensCleared > 0) total += data.estimatedTokensCleared;
  }
  return total;
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
  let barLabel = config.apiKey ? "Jev ready" : "Jev dormant";
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
    const saved = clearedTokens(ctx.sessionManager.getBranch());
    barLabel = !config.apiKey ? "Jev dormant"
      : controller ? "Jev checking…"
      : warned ? "Jev error"
      : saved ? `Jev ~${compactTokens(saved)}`
      : "Jev ready";
    if (editorInstalled && ctx.mode === "tui") { editorTui?.requestRender(); return; }
    if (!ctx.hasUI) return;
    if (!config.apiKey) { ctx.ui.setStatus("pi-jev", "Jev: dormant"); return; }
    const usage = ctx.getContextUsage();
    const pressure = usage?.tokens !== null && usage?.tokens !== undefined && ctx.model?.contextWindow
      ? `${(usage.tokens / ctx.model.contextWindow * 100).toFixed(1)}%`
      : "waiting";
    ctx.ui.setStatus("pi-jev", `Jev: ${pressure}${saved ? ` · ~${compactTokens(saved)} cleared` : ""}`);
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
  pi.on("session_compact", (_event, ctx) => { reset(); updateStatus(ctx); });

  pi.on("context", (event, ctx) => {
    if (!config.apiKey || !pi.getActiveTools().includes("jev_read")) return;
    updateStatus(ctx);
    return { messages: applyPruning(event.messages, ledger(ctx.sessionManager.getBranch())) };
  });

  // Runs after tools, before the next assistant request. The context hook itself never makes a network call.
  pi.on("turn_end", async (_event, ctx) => {
    if (!config.apiKey) return;
    updateStatus(ctx);
    if (controller || !ctx.model || !pi.getActiveTools().includes("jev_read")) return;
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
    updateStatus(ctx);
    const ownEpoch = epoch;
    const leaf = ctx.sessionManager.getLeafId();
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, ownController.signal]) : ownController.signal;
    try {
      const result = await score(applyPruning(messages, refs), choices, config, signal, options.fetch);
      if (signal.aborted || epoch !== ownEpoch || ctx.sessionManager.getLeafId() !== leaf
        || !pi.getActiveTools().includes("jev_read")) return;
      const saved = choices.filter(item => result.refs.includes(item.ref))
        .reduce((sum, item) => sum + estimateTokens(item.result) - estimateTokens(applyPruning([item.result], new Set(result.refs))[0]!), 0);
      if (result.refs.length) {
        const entry = {
          version: 1, refs: result.refs, model: config.model, evaluated: result.evaluated,
          estimatedTokensCleared: saved, inputTokens: result.inputTokens,
        };
        try { pi.appendEntry(ENTRY_TYPE, entry); }
        catch (error) {
          // Pi inserts the same data object into memory before its disk write can fail.
          // Invalidate that entry too, so context/reload never trusts an uncommitted mask.
          entry.refs = [];
          throw error;
        }
      }
      lastStatus = `${result.refs.length}/${result.evaluated} outputs cleared; ~${saved.toLocaleString()} context tokens removed`;
      warned = false;
      updateStatus(ctx);
    } catch (error) {
      if (epoch !== ownEpoch || ownController.signal.aborted || ctx.signal?.aborted) return;
      lastStatus = error instanceof Error ? error.message : "Jev unavailable";
      if (!warned && ctx.hasUI) ctx.ui.notify(`pi-jev: ${lastStatus}. Context unchanged; normal compaction remains available.`, "warning");
      warned = true;
    } finally {
      if (controller === ownController) controller = undefined;
      updateStatus(ctx);
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

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { AssistantMessageComponent } from "@earendil-works/pi-coding-agent";
import { Markdown, MouseRegion, Text, stripTerminalSequences, type Component, type MarkdownTheme, type MouseRegionHandler, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { hookMethod } from "./compact-tools-hook.ts";
import { isKind } from "./compact-tools-silent.ts";

export type ThinkingView = "summary" | "hidden";

type ThinkingRenderOptions = {
	styleSummary?: (summary: string, sectionIndex: number) => string;
};

function plainSummary(line: string): string {
	return line
		.replace(/^\s{0,3}#{1,6}\s+/u, "")
		.replace(/^\s*[-*+]\s+/u, "")
		.replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
		.replace(/[*_~`]/gu, "")
		.replace(/\s+/gu, " ")
		.trim();
}

type ThinkingSection = { summary: string; detail: string };

export function splitThinkingSections(markdown: string): ThinkingSection[] {
	const normalized = markdown.includes("\r") ? markdown.replace(/\r\n?/gu, "\n") : markdown;
	const lines = normalized.split("\n");
	let first = -1;
	let summary = "";
	for (let index = 0; index < lines.length; index++) {
		summary = plainSummary(lines[index]!);
		if (summary) {
			first = index;
			break;
		}
	}
	if (first < 0) return [{ summary: "Thinking...", detail: "" }];
	const sections: ThinkingSection[] = [];
	let detail: string[] = [];
	let inFence = false;
	const flush = () => {
		sections.push({ summary, detail: detail.join("\n").trim() });
		detail = [];
	};
	for (let index = first + 1; index < lines.length; index++) {
		const line = lines[index]!;
		const fence = /^\s*(```|~~~)/u.test(line);
		if (!inFence) {
			const boldHeading = line.match(/^\s*\*\*(.+?)\*\*\s*$/u)?.[1];
			const markdownHeading = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*$/u)?.[1];
			const heading = boldHeading ?? markdownHeading;
			if (heading) {
				flush();
				summary = plainSummary(heading);
				continue;
			}
		}
		detail.push(line);
		if (fence) inFence = !inFence;
	}
	flush();
	return sections;
}

/** A finished block reads as one line; the summary carries the section titles while it streams. */
export function renderThinkingView(
	markdown: string,
	view: ThinkingView,
	_availableWidth: number,
	options: ThinkingRenderOptions = {},
): string {
	if (view === "hidden") return "Thinking...";
	return splitThinkingSections(markdown)
		.map(({ summary }, sectionIndex) => {
			const plain = stripTerminalSequences(summary);
			return options.styleSummary?.(plain, sectionIndex) ?? plain;
		})
		.join("\n\n");
}

/** "Thought for 12 seconds", "Thought for 1m 20s", "Thought for under a second". */
export function formatThinkingDuration(ms: number): string {
	if (ms < 1000) return "under a second";
	const seconds = Math.round(ms / 1000);
	if (seconds < 60) return seconds === 1 ? "1 second" : `${seconds} seconds`;
	const minutes = Math.floor(seconds / 60);
	const rest = seconds % 60;
	return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
}

// --- Measured durations ------------------------------------------------------
// Pi streams thinking through message_update events that carry a contentIndex.
// Each thinking_start opens a timer and each thinking_end closes it; the run's
// text is keyed the same way AssistantMessageComponent joins consecutive blocks,
// so a render can find its duration from the markdown alone.

type ThinkingTimings = {
	starts: Map<string, number>;
	blocks: Map<string, number>;
	runs: Map<string, number>;
};

const TIMINGS_KEY = Symbol.for("pi-compact-tools.thinking.timings");

function thinkingTimings(): ThinkingTimings {
	const holder = globalThis as typeof globalThis & { [TIMINGS_KEY]?: ThinkingTimings };
	return holder[TIMINGS_KEY] ??= { starts: new Map(), blocks: new Map(), runs: new Map() };
}

/** Two cheap orders over the same text, plus its length: a 64-bit footprint. */
function runHash(text: string): string {
	let fnv = 0x811c9dc5;
	let djb = 5381;
	for (let index = 0; index < text.length; index++) {
		const code = text.charCodeAt(index);
		fnv = Math.imul(fnv ^ code, 0x01000193) >>> 0;
		djb = (Math.imul(djb, 33) ^ code) >>> 0;
	}
	return `${fnv.toString(16)}:${djb.toString(16)}:${text.length}`;
}

type ThinkingContentLike = { type: string; thinking?: string };
type ThinkingEventLike = { type: string; contentIndex?: number };

type ThinkingMessageLike = { id?: unknown; content?: ThinkingContentLike[] };

/**
 * Record a streaming event's timing. Pass `now` in tests; production calls omit it.
 */
export function noteThinkingEvent(
	message: ThinkingMessageLike | unknown,
	event: ThinkingEventLike,
	now: number = Date.now(),
): void {
	const source = message as ThinkingMessageLike;
	if (event.type !== "thinking_start" && event.type !== "thinking_end") return;
	const id = typeof source.id === "string" ? source.id : "";
	if (!id) return;
	const index = event.contentIndex;
	if (!Number.isInteger(index)) return;
	const content = source.content ?? [];
	if (content[index!]?.type !== "thinking") return;
	const timings = thinkingTimings();
	const key = `${id}:${index}`;
	if (event.type === "thinking_start") {
		timings.starts.set(key, now);
		return;
	}
	const started = timings.starts.get(key);
	timings.starts.delete(key);
	if (started !== undefined) timings.blocks.set(key, now - started);
	// The run is every consecutive thinking block around this one, joined the way
	// the host joins them: trimmed, empties skipped, "\n\n" between blocks.
	let first = index!;
	while (first > 0 && content[first - 1]?.type === "thinking") first--;
	let last = index!;
	while (last + 1 < content.length && content[last + 1]?.type === "thinking") last++;
	let text = "";
	let ms = 0;
	let timed = false;
	for (let i = first; i <= last; i++) {
		const trimmed = (content[i]?.thinking ?? "").trim();
		if (!trimmed) continue;
		text = text ? `${text}\n\n${trimmed}` : trimmed;
		const blockMs = timings.blocks.get(`${id}:${i}`);
		if (blockMs !== undefined) {
			ms += blockMs;
			timed = true;
		}
	}
	if (text && timed) timings.runs.set(runHash(text), ms);
}

/** The measured duration of a finished thinking run, or undefined while it streams. */
export function thinkingDurationFor(markdown: string): number | undefined {
	return thinkingTimings().runs.get(runHash(markdown));
}

/** Drop every recorded duration; called when a session is replaced. */
export function clearThinkingTimings(): void {
	const timings = thinkingTimings();
	timings.starts.clear();
	timings.blocks.clear();
	timings.runs.clear();
}

// --- Collapsing finished runs ------------------------------------------------

const EXPANDED_RUNS = Symbol.for("pi-compact-tools.thinking.expanded");

/** The theme the collapse one-liners paint with; bound alongside the view controller. */
let collapseTheme: Theme | undefined;

export function setCollapseTheme(theme: Theme | undefined): void {
	collapseTheme = theme;
}

type AssistantLike = {
	contentContainer: { children: unknown[] };
	lastMessage?: { content?: ThinkingContentLike[] } | undefined;
	outputPad?: number;
	markdownTheme?: unknown;
	updateContent(message?: unknown): void;
};

/** The thinking runs the host would render, in order, as the joined markdown it hands to transformers. */
function thinkingRunsOf(message: AssistantLike["lastMessage"]): string[] {
	const content = message?.content;
	if (!Array.isArray(content)) return [];
	const runs: string[] = [];
	let text = "";
	for (const block of content) {
		if (block?.type !== "thinking") {
			if (text) runs.push(text);
			text = "";
			continue;
		}
		const trimmed = (block.thinking ?? "").trim();
		if (!trimmed) continue;
		text = text ? `${text}\n\n${trimmed}` : trimmed;
	}
	if (text) runs.push(text);
	return runs;
}

function expandedRunsOf(self: AssistantLike): Set<number> {
	const holder = self as unknown as Record<PropertyKey, unknown>;
	let set = holder[EXPANDED_RUNS] as Set<number> | undefined;
	if (!set) holder[EXPANDED_RUNS] = set = new Set();
	return set;
}

/** A click that toggles one run between its one-liner and its full text. */
function toggleRun(self: AssistantLike, index: number): MouseRegionHandler {
	return (event: TuiMouseEvent): TuiMouseEventResult | undefined => {
		if (event.type !== "click" || event.button !== "left") return undefined;
		const set = expandedRunsOf(self);
		if (set.has(index)) set.delete(index);
		else set.add(index);
		self.updateContent(self.lastMessage);
		return { handled: true };
	};
}

/**
 * Swap every finished, measured thinking run for a one-liner that expands on
 * click and compacts on the next click. Runs that stream or have no recorded
 * duration keep the host's own rendering and click behavior.
 */
function collapseFinishedRuns(self: AssistantLike): void {
	if (thinkingTimings().runs.size === 0) return;
	const runs = thinkingRunsOf(self.lastMessage);
	if (runs.length === 0) return;
	const outputPad = self.outputPad ?? 0;
	const children = self.contentContainer.children;
	// Each rendered unit sits behind at most one Spacer, and a thinking run the
	// host draws visibly is a MouseRegion, while a hidden run is a bare Text.
	// Walking both lists together aligns them; trailing notices fall outside.
	let unit = 0;
	for (let i = 0; i < children.length && unit < runs.length; i++) {
		const child = children[i];
		if (!isKind(child, MouseRegion)) {
			// A hidden run renders as plain text with the same padding and owns no
			// click region, but still occupies its run's slot.
			if (isKind(child, Text) && (child as unknown as { paddingX?: number }).paddingX === outputPad) unit++;
			continue;
		}
		const run = runs[unit++];
		if (run === undefined) break;
		const ms = thinkingDurationFor(run);
		if (ms === undefined) continue;
		const index = unit - 1;
		const expanded = expandedRunsOf(self).has(index);
		const label = `Thought for ${formatThinkingDuration(ms)}`;
		const component: Component = expanded
			? new Markdown(run, outputPad, 0, self.markdownTheme as MarkdownTheme, collapseTheme
					? { color: (text: string) => collapseTheme!.fg("thinkingText", text), italic: true }
					: undefined)
			: new Text(collapseTheme
					? collapseTheme.italic(collapseTheme.fg("thinkingText", label))
					: label, outputPad, 0);
		children[i] = new MouseRegion(component, toggleRun(self, index));
	}
}

/**
 * Wrap Pi's thinking rendering once per process. Returns false when the host
 * no longer has that shape, leaving its own behavior in place.
 */
export function installThinkingCollapse(): boolean {
	const prototype = (AssistantMessageComponent as unknown as { prototype?: { updateContent?: unknown } })?.prototype;
	if (!prototype || typeof prototype.updateContent !== "function") return false;
	return hookMethod(prototype, "updateContent", "thinking.collapse", (self, args, original) => {
		const result = original.apply(self, args);
		try {
			collapseFinishedRuns(self as unknown as AssistantLike);
		} catch {
			// A shape change must never break Pi's own rendering.
		}
		return result;
	});
}

/** Renders streaming summaries and keeps Pi's hidden-thinking label in sync. */
export class ThinkingViewController {
	private theme: Theme | undefined;

	constructor(pi: ExtensionAPI) {
		pi.registerMarkdownTransformer((markdown, context) => {
			if (context.messageType !== "assistant-thinking") return markdown;
			const theme = this.theme;
			return renderThinkingView(markdown, "summary", context.availableWidth, {
				// Thinking chrome stays in Pi's own thinking color: the detail text and
				// the host's hidden label both use it, so summaries match them and no
				// part of a thinking block reads louder than the answer.
				styleSummary: theme ? (summary) => theme.fg("thinkingText", summary) : undefined,
			});
		});
	}

	bind(ctx: ExtensionContext): void {
		this.theme = ctx.ui.theme;
		setCollapseTheme(ctx.ui.theme);
		// Pi writes its own hidden label in italic thinkingText, so this matches it.
		ctx.ui.setHiddenThinkingLabel(ctx.ui.theme.italic(ctx.ui.theme.fg("thinkingText", "Thinking...")));
	}

	dispose(): void {
		this.theme = undefined;
	}
}

import "./pinned-themes.ts";
import { uiRenderers } from "./ui-renderers.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AssistantMessageComponent, CustomMessageComponent, initTheme, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import * as tui from "@earendil-works/pi-tui";
import { MouseRegion, Spacer, stripTerminalSequences, Text, visibleWidth } from "@earendil-works/pi-tui";
import {
	classifyCallStatus,
	formatDurationMs,
	indicatorGlyph,
	indicatorStrength,
	indicatorTone,
	normalizeLineEndings,
	RUNNING_INDICATOR_FRAME_COUNT,
} from "../extensions/compact-tools-core.ts";
import { colorizeRgb, fillRgb } from "../extensions/compact-tools-color.ts";
import { DEFAULT_CONFIG, loadConfig, mergeConfig } from "../extensions/compact-tools-config.ts";
import { patchToolRows } from "../extensions/compact-tools-custom.ts";
import { findAnchorTop, ViewportKeeper } from "../extensions/compact-tools-viewport.ts";
import { hookMethod } from "../extensions/compact-tools-hook.ts";
import { isIntermediateAssistant, parseSilentArgument, patchRender, renderAnswerOnly, renderWithoutNotices, SilentModeController } from "../extensions/compact-tools-silent.ts";
import { classifyShellCommand, claudeArgument, claudeCommand, claudeFailure, claudeOutcome, claudeTitle } from "../extensions/compact-tools-claude.ts";
import { countGroup, EXPAND_HINT, groupChildren, groupFailures, groupHint, summarizeGroup, ToolGroupComponent, type ToolRowLike } from "../extensions/compact-tools-grouping.ts";
import { languageFromPath, languageFromShebang, resolveLanguage } from "../extensions/compact-tools-language.ts";
import {
	formatResultLineSummary,
	getArgumentDetails,
	getCallDetails,
	countEditChanges,
	getEditChanges,
	splitReadFooter,
	summarizeCustomArguments,
	summarizeFailure,
	summarizeShellCommand,
} from "../extensions/compact-tools-invocation.ts";
import {
	CachedContainer,
	hardWrapTextWithAnsi,
	limitComponentLines,
	parseCodeDiff,
	claudeRows,
	prefixedLines,
	prefixedText,
	renderArguments,
	renderCodeDiff,
	renderCodeView,
	renderOutput,
	renderToolCall,
	styleMultiline,
	trimDiffContext,
} from "../extensions/compact-tools-layout.ts";
import { highlightMarkdown } from "../extensions/compact-tools-markdown.ts";
import { completionPainter, paintChrome } from "../extensions/compact-tools-palette.ts";
import { ToolRuntime } from "../extensions/compact-tools-runtime.ts";
import {
	ThinkingViewController,
	clearThinkingTimings,
	formatThinkingDuration,
	installThinkingCollapse,
	noteThinkingEvent,
	setCollapseTheme,
	thinkingDurationFor,
} from "../extensions/compact-tools-thinking.ts";
import { SUPPORTED_TOOLS, type BuiltInDefinition, type RowState } from "../extensions/compact-tools-types.ts";
import { fakeTheme, hostResolvesColors, rgb } from "./theme-fixture.ts";

// Tests must never read the developer's real ~/.pi/agent: its settings.json
// (thinking visibility) and compact-tools.json would change what they see.
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "compact-tools-agent-"));

test("normalizes CRLF, LF, and CR line endings", () => {
	assert.equal(normalizeLineEndings("a\r\nb\rc\nd"), "a\nb\nc\nd");
});

test("formats durations with millisecond precision", () => {
	assert.equal(formatDurationMs(23), "0.023s");
	assert.equal(formatDurationMs(1_039), "1.039s");
	assert.equal(formatDurationMs(59_999), "59.999s");
});

test("groups durations of a minute or more like Pi's own shell renderers", () => {
	assert.equal(formatDurationMs(60_000), "1m 0s");
	assert.equal(formatDurationMs(312_481), "5m 12s");
	assert.equal(formatDurationMs(3_599_999), "59m 59s");
	assert.equal(formatDurationMs(3_600_000), "1h 0m 0s");
	assert.equal(formatDurationMs(3_723_400), "1h 2m 3s");
});

test("merges configuration without mutating defaults", () => {
	const merged = mergeConfig(DEFAULT_CONFIG, {
		tools: ["read", "grep"],
		auto_compact: { read: false },
		previewLines: 12,
	}, "test");
	assert.deepEqual(merged.tools, ["read", "grep"]);
	assert.equal(merged.auto_compact.read, false);
	assert.equal(merged.auto_compact.edit, false);
	assert.equal(merged.previewLines, 12);
	assert.equal(mergeConfig(DEFAULT_CONFIG, { previewLines: 0 }, "test").previewLines, 10);
	assert.equal(DEFAULT_CONFIG.auto_compact.read, true);
});

test("parses display mode and keeps the previous value when invalid", () => {
	assert.equal(DEFAULT_CONFIG.mode, "normal");
	assert.equal(DEFAULT_CONFIG.style, "compact");
	assert.equal(mergeConfig(DEFAULT_CONFIG, { style: "claude" }, "test").style, "claude");
	assert.equal(mergeConfig(DEFAULT_CONFIG, { style: "off" }, "test").style, "off");
	assert.equal(mergeConfig(DEFAULT_CONFIG, { style: "codex" }, "test").style, "codex");
	assert.equal(mergeConfig(DEFAULT_CONFIG, { style: "Codex" }, "test").style, "compact", "styles are spelled exactly");
	assert.equal(mergeConfig(DEFAULT_CONFIG, { style: "fancy" }, "test").style, "compact", "an unknown style keeps the previous one");
	assert.equal(mergeConfig(DEFAULT_CONFIG, { mode: "claude" }, "test").mode, "normal", "styles are not modes");
	const both = mergeConfig(DEFAULT_CONFIG, { style: "claude", mode: "silent" }, "test");
	assert.deepEqual([both.style, both.mode], ["claude", "silent"], "a style and silent mode combine");
	assert.equal(mergeConfig(DEFAULT_CONFIG, { mode: "silent" }, "test").mode, "silent");
	const silent = mergeConfig(DEFAULT_CONFIG, { mode: "silent" }, "test");
	assert.equal(mergeConfig(silent, { mode: "quiet" }, "test").mode, "silent");
	assert.equal(mergeConfig(silent, { previewLines: 4 }, "test").mode, "silent");
});

test("treats every tool-handoff assistant turn as intermediate, however it ended", () => {
	assert.equal(isIntermediateAssistant({ hasToolCalls: true }), true);
	assert.equal(isIntermediateAssistant({ hasToolCalls: false }), false);
	assert.equal(isIntermediateAssistant({}), false);
});

test("parses /silent arguments as a toggle or an explicit state", () => {
	assert.equal(parseSilentArgument("", false), true);
	assert.equal(parseSilentArgument("  ", true), false);
	assert.equal(parseSilentArgument("ON", false), true);
	assert.equal(parseSilentArgument("off", true), false);
	assert.equal(parseSilentArgument("maybe", true), undefined);
});

test("wraps a render prototype once and hides only while the predicate holds", () => {
	class Row {
		constructor(readonly label: string) {}
		render(_width: number): string[] {
			return [this.label];
		}
	}
	let hidden = true;
	const hideWhen = (predicate: (row: Row) => boolean) =>
		(row: Row, width: number, render: (width: number) => string[]) => predicate(row) ? [] : render(width);
	assert.equal(patchRender(Row.prototype, hideWhen((row) => hidden && row.label === "tool")), true);
	// A second install (as after /reload) must not stack another wrapper.
	assert.equal(patchRender(Row.prototype, () => []), true);
	assert.deepEqual(new Row("tool").render(80), []);
	assert.deepEqual(new Row("answer").render(80), ["answer"]);
	hidden = false;
	assert.deepEqual(new Row("tool").render(80), ["tool"]);
	// A subclass inheriting render() gets its own wrapper without touching the base.
	class Notice extends Row {}
	assert.equal(patchRender(Notice.prototype, hideWhen(() => hidden)), true);
	hidden = true;
	assert.deepEqual(new Notice("notice").render(80), []);
	assert.deepEqual(new Row("answer").render(80), ["answer"]);
	assert.equal(patchRender(undefined, () => []), false);
	assert.equal(patchRender({} as never, () => []), false);
});

test("renders only an assistant turn's answer and restores the children", () => {
	const line = (text: string) => ({ render: () => [text], invalidate: () => {} });
	const children: unknown[] = [
		new Spacer(1),
		new MouseRegion(line("THINKING"), () => undefined),
		new Spacer(1),
		line("ANSWER"),
	];
	const component = { contentContainer: { children } };
	const render = () => (component.contentContainer.children as Array<{ render(width: number): string[] }>)
		.flatMap((child) => child.render(20));
	assert.deepEqual(renderAnswerOnly(component, 20, render).map((row: string) => row.trim()), ["", "ANSWER"]);
	assert.equal(component.contentContainer.children, children, "the component keeps its own children");
	assert.equal(children.length, 4);
	// A turn with nothing but thinking renders nothing, not a stray blank line.
	const onlyThinking = { contentContainer: { children: [new Spacer(1), new MouseRegion(line("T"), () => undefined)] } };
	assert.deepEqual(renderAnswerOnly(onlyThinking, 20, () => ["unexpected"]), []);
	// Error, abort, and truncation notices go with the spacer Pi puts before them.
	const failed = {
		contentContainer: {
			children: [new Spacer(1), line("PARTIAL"), new Spacer(1), new Text("Error: 400 invalid_request_error", 1, 0)],
		},
	};
	const renderFailed = () => (failed.contentContainer.children as Array<{ render(width: number): string[] }>)
		.flatMap((child) => child.render(40));
	assert.deepEqual(renderAnswerOnly(failed, 40, renderFailed).map((row: string) => row.trim()), ["", "PARTIAL"]);
	const errorOnly = { contentContainer: { children: [new Spacer(1), new Text("Error: 400", 1, 0)] } };
	assert.deepEqual(renderAnswerOnly(errorOnly, 40, () => ["unexpected"]), []);
	// A plain answer is rendered unchanged.
	assert.deepEqual(renderAnswerOnly({ contentContainer: { children: [line("A")] } }, 20, () => ["A"]), ["A"]);
});

test("/silent offers on and off, but nothing already typed in full, so Enter runs it at once", async () => {
	let completions: ((prefix: string) => unknown) | undefined;
	const pi = {
		on: () => {},
		registerCommand: (_name: string, definition: { getArgumentCompletions?: (prefix: string) => unknown }) => {
			completions = definition.getArgumentCompletions;
		},
		registerShortcut: () => {},
	} as unknown as ExtensionAPI;
	new SilentModeController(pi);
	assert.deepEqual(await completions!(""), [{ value: "on", label: "on" }, { value: "off", label: "off" }]);
	assert.deepEqual(await completions!("o"), [{ value: "on", label: "on" }, { value: "off", label: "off" }]);
	assert.deepEqual(await completions!("of"), [{ value: "off", label: "off" }]);
	// Pi applies a shown completion on Enter instead of running the command.
	for (const typed of ["on", "off", "ON ", "x"]) assert.equal(await completions!(typed), null, typed);
});

test("restores hidden rows when silent mode is disposed and preserves the choice across reload", async () => {
	// Pi paints stop notices with its global theme, so the real components need one.
	initTheme(undefined, false);
	let command: ((args: string, ctx: any) => Promise<void>) | undefined;
	let shortcut: ((ctx: any) => Promise<void> | void) | undefined;
	let shortcutKey: string | undefined;
	const pi = {
		on: () => {},
		registerCommand: (_name: string, definition: { handler: typeof command }) => { command = definition.handler; },
		registerShortcut: (key: string, definition: { handler: typeof shortcut }) => {
			shortcutKey = key;
			shortcut = definition.handler;
		},
	} as unknown as ExtensionAPI;
	const ctx = {
		ui: {
			theme: { fg: (_color: string, text: string) => text },
			setStatus: () => {},
			setWidget: () => {},
			notify: (message: string) => notifications.push(message),
		},
	} as unknown as ExtensionContext;
	const notifications: string[] = [];
	const failedAnswer = new AssistantMessageComponent({
		content: [{ type: "text", text: "Partial answer" }],
		stopReason: "error",
		errorMessage: "400 invalid_request_error",
	} as never);
	const failedHandoff = new AssistantMessageComponent({
		content: [{ type: "toolCall", id: "call-2", name: "web_search", arguments: {} }],
		stopReason: "error",
		errorMessage: "400 invalid_request_error",
	} as never);
	const visible = (component: { render(width: number): string[] }) =>
		component.render(80).map((line) => stripTerminalSequences(line).trim()).filter(Boolean);
	const assistant = new AssistantMessageComponent({
		content: [{ type: "text", text: "Before call" }, { type: "toolCall", id: "call-1", name: "read", arguments: {} }],
		stopReason: "toolUse",
	} as never);
	const notice = new CustomMessageComponent(
		{ customType: "notice", content: "Content ready" } as never,
		() => ({ render: () => ["Content ready"], invalidate() {} }),
	);
	const controller = new SilentModeController(pi);
	controller.bind(ctx, "normal", false);
	assert.ok(assistant.render(80).length > 0);
	assert.ok(notice.render(80).length > 0);
	assert.ok(visible(failedAnswer).some((line) => line.startsWith("Error: 400")));
	await command!("on", ctx);
	assert.deepEqual(notifications, [], "toggling must not write a notice into the transcript");
	assert.deepEqual(assistant.render(80), []);
	assert.deepEqual(notice.render(80), []);
	assert.deepEqual(visible(failedAnswer), ["Partial answer"], "the answer stays, its error notice goes");
	assert.deepEqual(failedHandoff.render(80), [], "a failed tool handoff is hidden like any other");
	await command!("off", ctx);
	assert.ok(visible(failedAnswer).some((line) => line.startsWith("Error: 400")), "off restores the notice");
	await command!("on", ctx);
	assert.deepEqual(notifications, []);
	// Ctrl+' toggles the same state as /silent.
	assert.equal(shortcutKey, "ctrl+'");
	await shortcut!(ctx);
	assert.ok(assistant.render(80).length > 0, "the shortcut turns silent mode off");
	await shortcut!(ctx);
	assert.deepEqual(assistant.render(80), [], "and on again");
	assert.deepEqual(notifications, []);
	controller.dispose();
	assert.ok(assistant.render(80).length > 0);
	assert.ok(notice.render(80).length > 0);
	controller.bind(ctx, "normal", true);
	assert.deepEqual(assistant.render(80), []);
	assert.deepEqual(notice.render(80), []);
	controller.dispose();
	assert.ok(assistant.render(80).length > 0);
	assert.ok(notice.render(80).length > 0);
});

test("summarizes failure diagnostics from file and shell output", () => {
	assert.equal(summarizeFailure("read", "\x1b[31mENOENT: missing file\x1b[0m\nstack frame"), "ENOENT: missing file");
	assert.equal(summarizeFailure("bash", "running tests\nError: missing module\n\nCommand exited with code 1"),
		"Error: missing module (Command exited with code 1)");
	assert.equal(summarizeFailure("bash", "output\n\nCommand timed out after 5 seconds"),
		"Command timed out after 5 seconds");
	assert.equal(summarizeFailure("read", "  \n  "), undefined);
});

test("hard-wraps long ANSI paths into remaining columns instead of moving the path", () => {
	const input = `● read \x1b[90m/var/folders/example-with-a-long-name.png\x1b[39m`;
	const lines = hardWrapTextWithAnsi(input, 16);
	assert.ok(stripTerminalSequences(lines[0]!).startsWith("● read /var/"));
	assert.ok(lines.length > 1);
	assert.ok(lines.every((line) => visibleWidth(line) <= 16));
	assert.equal(lines.map(stripTerminalSequences).join(""), stripTerminalSequences(input));
});

test("drops separator whitespace at the start of wrapped command lines", () => {
	const input = `echo \x1b[90mfoo bar\x1b[39m`;
	const lines = hardWrapTextWithAnsi(input, 4).map(stripTerminalSequences);
	assert.deepEqual(lines, ["echo", "foo ", "bar"]);
});

test("caches immutable prefixed layout by terminal width", () => {
	const component = prefixedText("a long line that wraps", " │ ");
	const first = component.render(12);
	assert.equal(component.render(12), first);
	component.invalidate();
	assert.notEqual(component.render(12), first);
});

test("reports completed output lines instead of invocation limits", () => {
	const readArgs = { path: "file.ts", offset: 20, limit: 22 };
	assert.equal(getCallDetails("read", readArgs), "file.ts");
	assert.equal(formatResultLineSummary("read", readArgs, {
		content: [{ type: "text", text: "one\ntwo\nthree" }],
		details: undefined,
	}), "3 lines");
	assert.equal(formatResultLineSummary("read", readArgs, {
		content: [{ type: "text", text: "one" }],
		details: undefined,
	}), "1 line");
	assert.equal(formatResultLineSummary("read", readArgs, {
		content: [{ type: "text", text: "one\ntwo\n\n[8 more lines in file. Use offset=3 to continue.]" }],
		details: undefined,
	}), "2 lines");
	assert.equal(formatResultLineSummary("grep", { context: 3, limit: 5 }, {
		content: [{ type: "text", text: "match\ncontext\ncontext" }],
		details: undefined,
	}), "3 lines");
	assert.equal(formatResultLineSummary("bash", {}, {
		content: [{ type: "text", text: "" }],
		details: undefined,
	}), "0 lines");
	assert.equal(formatResultLineSummary("write", { content: "one\r\ntwo\r\n" }, {
		content: [{ type: "text", text: "ok" }],
		details: undefined,
	}), "2 lines");
	assert.equal(formatResultLineSummary("edit", {}, {
		content: [{ type: "text", text: "ok" }],
		details: { diff: "     ...\n  8 unchanged\n- 9 old\n+ 9 new\n 10 unchanged\n     ..." },
	}), "2 lines");
	assert.equal(formatResultLineSummary("grep", {}, {
		content: [{ type: "text", text: "visible\nfooter" }],
		details: { truncation: { outputLines: 42 } },
	}), "42 lines");
});

test("keeps invocation targets visible while separating large result payloads", () => {
	const readArgs = { path: "file.ts", offset: 20, limit: 22 };
	assert.equal(getCallDetails("read", readArgs), "file.ts");
	assert.deepEqual(getArgumentDetails("read", readArgs), {});
	const grepArgs = { path: "src", pattern: "TODO", glob: "*.ts", context: 3, limit: 5 };
	assert.equal(getCallDetails("grep", grepArgs), "/TODO/ in src");
	const findArgs = { path: "src", pattern: "**/*.test.ts", limit: 20 };
	assert.equal(getCallDetails("find", findArgs), "**/*.test.ts in src");
	assert.equal(getCallDetails("ls", { path: "src", limit: 50 }), "src");
	assert.deepEqual(getArgumentDetails("grep", { path: "src", pattern: "TODO", limit: 5 }), {});
	assert.deepEqual(getArgumentDetails("find", { path: "src", pattern: "*.ts", limit: 5 }), {});
	assert.deepEqual(getArgumentDetails("ls", { path: "src", limit: 5 }), {});
	assert.deepEqual(getArgumentDetails("write", { path: "file.ts", content: "large payload" }), {});
});

test("summarizes collapsed shell calls and shows text-search patterns", () => {
	assert.equal(summarizeShellCommand("bash", "npm run check"), "Run check task");
	assert.equal(summarizeShellCommand("bash", "cd release && git status --short && git log -1"), "Check repository status + 1 more step");
	assert.equal(summarizeShellCommand("bash", "rg very-secret-query src"), 'Search text "very-secret-query"');
	assert.equal(summarizeShellCommand("bash", "cat README.md | tee copy.md"), 'Read file "README.md" + 1 more step',
		"a pipe ends the first command; what it feeds is a step of its own, never a file");
	assert.equal(summarizeShellCommand("bash", "rg 'a|b' src"), 'Search text "a|b"', "a quoted pipe is part of the pattern");
	assert.equal(summarizeShellCommand("bash", "ps aux | grep node | head"), "Run ps + 2 more steps");
	assert.equal(summarizeShellCommand("bash", "rg -n '\\d+ items' src"), 'Search text "\\\\d+ items"');
	assert.equal(summarizeShellCommand("bash", "grep -R --include='*.ts' 'foo bar' ."), 'Search text "foo bar"');
	assert.equal(summarizeShellCommand("bash", "rg --type ts -e 'TODO|FIXME' src"), 'Search text "TODO|FIXME"');
	assert.equal(summarizeShellCommand("powershell", "Select-String -Pattern 'fatal error' -Path *.log"), 'Search text "fatal error"');
	assert.equal(summarizeShellCommand("bash", "find src -name '*.test.ts'"), 'Find files "*.test.ts" in "src"');
	assert.equal(summarizeShellCommand("bash", "fd -e ts controller src tests"), 'Find files "controller" in "src", "tests"');
	assert.equal(summarizeShellCommand("bash", "ls -la src"), 'List files "src"');
	assert.equal(summarizeShellCommand("powershell", "Get-ChildItem -Path C:\\private"), 'List files "C:\\\\private"');
	assert.equal(summarizeShellCommand("bash", "rm -rf build cache"), 'Run rm "build", "cache"');
	assert.equal(summarizeShellCommand("bash", "cp -r src backup/src"), 'Copy "src" to "backup/src"');
	assert.equal(summarizeShellCommand("bash", "custom-tool --token secret"), "Run custom tool");
	assert.equal(summarizeShellCommand("bash", ""), "Prepare shell command");
});

/** A dark theme's neutral ramp plus an accent, so derived chrome colors have room to move. */
const THEME_RAMP_ANSI: Record<string, string> = {
	text: "\x1b[38;2;201;209;217m",
	muted: "\x1b[38;2;139;148;158m",
	dim: "\x1b[38;2;110;118;129m",
	accent: "\x1b[38;2;149;167;255m",
	toolOutput: "\x1b[38;2;152;161;172m",
	thinkingLow: "\x1b[38;2;110;118;129m",
	thinkingMax: "\x1b[38;2;159;207;248m",
};

const DIFF_ANSI: Record<string, string> = {
	text: "\x1b[38;2;201;209;217m",
	toolDiffAdded: "\x1b[38;2;87;166;74m",
	toolDiffRemoved: "\x1b[38;2;229;83;75m",
};

const diffTheme = fakeTheme({
	fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
	getFgAnsi: (color: string) => DIFF_ANSI[color] ?? "",
	getColorMode: () => "truecolor",
});

test("keeps only changed edit lines for the result line summary", () => {
	const result = {
		content: [{ type: "text" as const, text: "Successfully replaced 1 block" }],
		details: { diff: "     ...\r\n  8 unchanged\r\n- 9 old\r\n+ 9 new\r\n 10 unchanged\r\n     ..." },
	};
	assert.equal(getEditChanges(result), "- 9 old\n+ 9 new");
});

test("renders an edit as a diff with a line-number gutter and tinted change rows", () => {
	const patch = [
		"--- file.ts",
		"+++ file.ts",
		"@@ -8,3 +8,3 @@",
		" const before = 1;",
		"-const value = old();",
		"+const value = next();",
		" return value;",
	].join("\n");
	const rendered = renderCodeDiff(patch, "", "file.ts", diffTheme)?.render(60)
		.map((line) => stripTerminalSequences(line).trimEnd());
	assert.deepEqual(rendered, [
		"<dim> │ </dim><toolDiffContext>  8  </toolDiffContext>const before = 1;",
		"<dim> │ </dim><toolDiffRemoved>  9 -</toolDiffRemoved>const value = old();",
		"<dim> │ </dim><toolDiffAdded>  9 +</toolDiffAdded>const value = next();",
		"<dim> │ </dim><toolDiffContext> 10  </toolDiffContext>return value;",
	]);
});

test("marks the changed words of a paired edit row and leaves a rewritten row alone", () => {
	const patch = [
		"--- file.ts",
		"+++ file.ts",
		"@@ -1,2 +1,2 @@",
		"-const a = 1;",
		"-return `Yo, ${name}!`;",
		"+const a = 10;",
		"+return 42;",
	].join("\n");
	const rows = renderCodeDiff(patch, "", "file.ts", diffTheme)!.render(60);
	const fills = (row: string) => new Set(row.match(/\x1b\[48;[0-9;]+m/gu));
	assert.equal(fills(rows[0]!).size, 2, "the changed number is brighter than the row around it");
	assert.equal(fills(rows[1]!).size, 1, "a rewritten row keeps one tint");
	assert.equal(fills(rows[2]!).size, 2);
	assert.equal(fills(rows[3]!).size, 1);
	assert.equal(stripTerminalSequences(rows[0]!).trimEnd().endsWith("const a = 1;"), true);
});

test("renders file contents with offset line numbers and a dim continuation notice", () => {
	const rendered = renderCodeView("const a = 1;\n\treturn a;\n", "file.ts", diffTheme, {
		startLine: 99,
		footer: "[Showing lines 99-100 of 300. Use offset=101 to continue.]",
	})?.render(80).map((line) => stripTerminalSequences(line).trimEnd());
	assert.deepEqual(rendered, [
		"<dim> │ </dim><toolDiffContext>  99 </toolDiffContext>const a = 1;",
		"<dim> │ </dim><toolDiffContext> 100 </toolDiffContext>   return a;",
		"<dim> │ </dim><dim>[Showing lines 99-100 of 300. Use offset=101 to continue.]</dim>",
	]);
});

test("plain-text files keep the output color instead of guessing a language", () => {
	const rendered = renderCodeView("hello", "NOTES", diffTheme)?.render(120).map(stripTerminalSequences);
	assert.deepEqual(rendered, ["<dim> │ </dim><toolDiffContext> 1 </toolDiffContext><toolOutput>hello</toolOutput>"]);
});

test("highlights Markdown prose and fenced code while keeping every source character", () => {
	const theme = fakeTheme({
		fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
		bold: (text: string) => `<b>${text}</b>`,
		italic: (text: string) => `<i>${text}</i>`,
	});
	const source = [
		"# Title",
		"See `x` and [docs](https://x.dev) with **bold**.",
		"- item",
		"> quote",
		"```",
		"# not a heading",
		"```",
	];
	const rendered = highlightMarkdown(source, theme);
	assert.deepEqual(rendered, [
		"<b><mdHeading># Title</mdHeading></b>",
		"<toolOutput>See </toolOutput><dim>`</dim><mdCode>x</mdCode><dim>`</dim><toolOutput> and </toolOutput>"
			+ "<dim>[</dim><mdLink>docs</mdLink><dim>](</dim><mdLinkUrl>https://x.dev</mdLinkUrl><dim>)</dim>"
			+ "<toolOutput> with </toolOutput><dim>**</dim><b><toolOutput>bold</toolOutput></b><dim>**</dim><toolOutput>.</toolOutput>",
		"<mdListBullet>- </mdListBullet><toolOutput>item</toolOutput>",
		"<mdQuoteBorder>> </mdQuoteBorder><i><mdQuote>quote</mdQuote></i>",
		"<mdCodeBlockBorder>```</mdCodeBlockBorder>",
		"<mdCodeBlock># not a heading</mdCodeBlock>",
		"<mdCodeBlockBorder>```</mdCodeBlockBorder>",
	]);
	assert.deepEqual(rendered.map((line) => line.replace(/<\/?[\w]+>/gu, "")), source);
});

test("highlights a fenced block with its declared language and survives an unclosed fence", () => {
	const theme = fakeTheme({ fg: (_color: string, text: string) => text, bold: (text: string) => text, italic: (text: string) => text });
	const rendered = highlightMarkdown(["```ts", "const a = 1;"], theme).map(stripTerminalSequences);
	assert.deepEqual(rendered, ["```ts", "const a = 1;"]);
});

test("separates a read's continuation notice from the file contents", () => {
	assert.deepEqual(splitReadFooter("a\nb\n\n[3 more lines in file. Use offset=3 to continue.]"), {
		body: "a\nb",
		footer: "[3 more lines in file. Use offset=3 to continue.]",
	});
	assert.deepEqual(splitReadFooter("a\n\n[not a footer]"), { body: "a\n\n[not a footer]" });
});

test("drops distant context so a collapsed edit preview still reaches the change", () => {
	const patch = [
		"--- file.ts",
		"+++ file.ts",
		"@@ -1,7 +1,7 @@",
		" one",
		" two",
		" three",
		"-four",
		"+FOUR",
		" five",
		" six",
		" seven",
	].join("\n");
	assert.deepEqual(
		trimDiffContext(parseCodeDiff(patch), 1).map(({ kind, content }) => ({ kind, content })),
		[
			{ kind: "context", content: "three" },
			{ kind: "remove", content: "four" },
			{ kind: "add", content: "FOUR" },
			{ kind: "context", content: "five" },
		],
	);
});

test("parses unified edit patches into numbered code-diff rows", () => {
	const patch = [
		"--- file.ts",
		"+++ file.ts",
		"@@ -8,3 +8,3 @@",
		" keep",
		"-old",
		"+new",
		" tail",
		"@@ -20 +20 @@",
		"-before",
		"+after",
	].join("\n");
	assert.deepEqual(
		parseCodeDiff(patch).map(({ kind, lineNumber, content }) => ({ kind, lineNumber, content })),
		[
			{ kind: "context", lineNumber: 8, content: "keep" },
			{ kind: "remove", lineNumber: 9, content: "old" },
			{ kind: "add", lineNumber: 9, content: "new" },
			{ kind: "context", lineNumber: 10, content: "tail" },
			{ kind: "separator", lineNumber: undefined, content: "⋮" },
			{ kind: "remove", lineNumber: 20, content: "before" },
			{ kind: "add", lineNumber: 20, content: "after" },
		],
	);
});

test("reapplies ANSI styling to every logical line", () => {
	const styled = styleMultiline("first\nsecond", (line) => `\x1b[90m${line}\x1b[39m`);
	assert.deepEqual(styled.split("\n"), ["\x1b[90mfirst\x1b[39m", "\x1b[90msecond\x1b[39m"]);
});

test("uses hidden, preview, and expanded result states with Pi's host toggle", () => {
	const runtime = new ToolRuntime();
	runtime.configure(DEFAULT_CONFIG);
	const read: RowState = {};
	const edit: RowState = {};
	assert.equal(runtime.syncExpansion(read, false, "read"), false);
	assert.equal(read.preview, false);
	assert.equal(runtime.syncExpansion(edit, false, "edit"), false);
	assert.equal(edit.preview, true);
	assert.equal(runtime.syncExpansion(edit, true, "edit"), true);
	assert.equal(edit.preview, false);
	assert.equal(runtime.syncExpansion(edit, false, "edit"), false);
	assert.equal(edit.preview, true);
	assert.equal(runtime.syncExpansion(edit, true, "edit"), true);
	assert.equal(edit.preview, false);
	assert.equal(runtime.syncExpansion(read, true, "read"), true);
	assert.equal(runtime.syncExpansion(read, false, "read"), false);
	assert.equal(read.preview, false);
	runtime.reset(true);
});

test("merges trusted project configuration over the global configuration", () => {
	const agentDirVariable = "PI_CODING_AGENT_DIR";
	const previousAgentDir = process.env[agentDirVariable];
	const agentDir = mkdtempSync(join(tmpdir(), "compact-tools-agent-"));
	const projectDir = mkdtempSync(join(tmpdir(), "compact-tools-project-"));
	process.env[agentDirVariable] = agentDir;
	writeFileSync(join(agentDir, "compact-tools.json"), JSON.stringify({ tools: ["read"], previewLines: 5 }));
	mkdirSync(join(projectDir, ".pi"), { recursive: true });
	writeFileSync(join(projectDir, ".pi", "compact-tools.json"), JSON.stringify({ tools: ["edit"], previewLines: 7 }));
	assert.deepEqual(loadConfig(projectDir, false).tools, ["read"]);
	assert.equal(loadConfig(projectDir, false).previewLines, 5);
	assert.deepEqual(loadConfig(projectDir, true).tools, ["edit"]);
	assert.equal(loadConfig(projectDir, true).previewLines, 7);
	if (previousAgentDir === undefined) delete process.env[agentDirVariable];
	else process.env[agentDirVariable] = previousAgentDir;
});

test("forwards Pi's complete execution context through the timing wrapper", async () => {
	const runtime = new ToolRuntime();
	const executionContext = {
		model: { inputLimits: { images: { resize: { maxPixels: 1_000_000 } } } },
	} as unknown as ExtensionContext;
	let received: unknown[] | undefined;
	const definition = {
		async execute(...args: unknown[]) {
			received = args;
			return { content: [{ type: "text", text: "ok" }], details: undefined };
		},
	} as unknown as BuiltInDefinition;
	const signal = new AbortController().signal;
	const onUpdate = () => {};

	await runtime.createTimedExecute(definition)("read-context", { path: "image.png" }, signal, onUpdate, executionContext);
	assert.equal(received?.[0], "read-context");
	assert.equal(received?.[2], signal);
	assert.equal(received?.[3], onUpdate);
	assert.equal(received?.[4], executionContext);
	runtime.reset(true);
});

test("stops the shared indicator timer and keeps parallel tools independent", async () => {
	const runtime = new ToolRuntime();
	let firstInvalidations = 0;
	let secondInvalidations = 0;
	runtime.syncIndicator("first", true, () => firstInvalidations++);
	runtime.syncIndicator("second", true, () => secondInvalidations++);
	await new Promise((resolve) => setTimeout(resolve, 270));
	assert.ok(firstInvalidations > 0);
	assert.ok(secondInvalidations > 0);

	runtime.syncIndicator("first", false, () => {});
	const firstAtCompletion = firstInvalidations;
	const secondBeforeNextFrame = secondInvalidations;
	await new Promise((resolve) => setTimeout(resolve, 270));
	assert.equal(firstInvalidations, firstAtCompletion);
	assert.ok(secondInvalidations > secondBeforeNextFrame);

	runtime.reset(true);
	const secondAtShutdown = secondInvalidations;
	await new Promise((resolve) => setTimeout(resolve, 270));
	assert.equal(secondInvalidations, secondAtShutdown);
});

test("classifies calls and smoothly fades one shared tool indicator glyph", () => {
	assert.equal(classifyCallStatus(false, false, false), "pending");
	assert.equal(classifyCallStatus(false, true, false), "running");
	assert.equal(classifyCallStatus(false, true, true), "success");
	assert.equal(classifyCallStatus(true, true, true), "error");
	assert.equal(indicatorGlyph("pending"), "⦁");
	const strengths = Array.from(
		{ length: RUNNING_INDICATOR_FRAME_COUNT },
		(_, frame) => indicatorStrength("running", frame),
	);
	assert.equal(strengths[0], 1);
	assert.ok(Math.abs(strengths[7]! - 0.08) < 1e-12);
	assert.ok(strengths.slice(0, 8).every((strength, index, values) => index === 0 || strength < values[index - 1]!));
	assert.ok(strengths.slice(7).every((strength, index, values) => index === 0 || strength > values[index - 1]!));
	assert.ok(Math.abs(strengths[1]! - strengths[13]!) < 1e-12);
	assert.equal(indicatorTone("running", 0), "muted");
	assert.equal(indicatorTone("running", 7), "borderMuted");
	assert.ok(Array.from(
		{ length: RUNNING_INDICATOR_FRAME_COUNT },
		(_, frame) => indicatorGlyph("running", frame),
	).every((glyph) => glyph === "⦁"));
	assert.equal(indicatorGlyph("success"), "⦁");
	assert.equal(indicatorGlyph("error"), "⦁");
});

test("frames every rail in one chrome tone, quieter than the theme's own dim", () => {
	const theme = fakeTheme({
		fg: (color: string, text: string) => `${THEME_RAMP_ANSI[color] ?? ""}${text}\x1b[39m`,
		getFgAnsi: (color: string) => THEME_RAMP_ANSI[color] ?? "",
		getColorMode: () => "truecolor",
	});
	const railColor = (line: string) => line.match(/38;2;\d+;\d+;\d+/u)?.[0];
	const chrome = railColor(paintChrome(theme, " │ "));
	const patch = ["@@ -1,2 +1,2 @@", "-const value = old();", "+const value = next();"].join("\n");
	const overflowing: Component = { render: () => ["one", "two"], invalidate() {} };

	// Every surface that draws the frame resolves to the same tone, so a row reads as one object.
	assert.deepEqual([
		railColor(renderToolCall("read", "a path long enough to wrap onto a second line", theme).render(24)[1]!),
		railColor(renderOutput("hello", theme, false)!.render(80)[0]!),
		railColor(renderCodeDiff(patch, "", "a.ts", theme)!.render(80)[0]!),
		railColor(renderCodeView("const a = 1;", "a.ts", theme)!.render(80)[0]!),
		railColor(renderArguments({ path: "a.ts" }, theme).render(80)[0]!),
		railColor(limitComponentLines(overflowing, 1, theme).render(80)[1]!),
	], Array.from({ length: 6 }, () => chrome));

	// The truncation notice rides a chrome rail but reads at the weight of the tool's own
	// arguments, so hidden output stays noticeable without the frame competing with it.
	const truncated = limitComponentLines(overflowing, 1, theme).render(80)[1]!;
	assert.match(stripTerminalSequences(truncated), /^ │ … 1 more line$/u);
	assert.deepEqual([...new Set([...truncated.matchAll(/38;2;\d+;\d+;\d+/gu)].map((match) => match[0]))], [
		chrome,
		THEME_RAMP_ANSI.toolOutput!.match(/38;2;\d+;\d+;\d+/u)![0],
	]);

	// `dim` is the quietest name a theme offers, but it is still sized for body text.
	const luminance = (ansi: string) => {
		const [r, g, b] = ansi.match(/(\d+);(\d+);(\d+)m?$/u)!.slice(1).map(Number);
		return r! * 0.299 + g! * 0.587 + b! * 0.114;
	};
	assert.ok(luminance(chrome!) < luminance(THEME_RAMP_ANSI.dim!));
});

test("limits previews without modifying the full result component", () => {
	const source: Component = {
		render: () => ["one", "two", "three", "four"],
		invalidate() {},
	};
	const theme = fakeTheme({ fg: (_color: string, text: string) => text });
	assert.deepEqual(limitComponentLines(source, 2, theme).render(80), ["one", "two", " │ … 2 more lines"]);
	assert.deepEqual(source.render(80), ["one", "two", "three", "four"]);
});

test("animates every built-in, restores reload renderers, and reuses unchanged large results", async () => {
	const agentDirVariable = "PI_CODING_AGENT_DIR";
	const previousAgentDir = process.env[agentDirVariable];
	process.env[agentDirVariable] = mkdtempSync(join(tmpdir(), "compact-tools-test-"));
	writeFileSync(
		join(process.env[agentDirVariable]!, "compact-tools.json"),
		JSON.stringify({ tools: SUPPORTED_TOOLS }),
	);
	const compactTools = (await import("../extensions/compact-tools.ts")).default;
	const registered: Array<{ name: string; renderCall?: unknown; renderResult?: unknown }> = [];
	const handlers = new Map<string, (event: any, ctx: any) => void>();
	const pi = {
		on: (name: string, handler: (event: any, ctx: any) => void) => handlers.set(name, handler),
		registerTool: (definition: { name: string; renderCall?: unknown; renderResult?: unknown }) =>
			registered.push(definition),
		registerMarkdownTransformer: () => {},
		registerCommand: () => {},
		registerShortcut: () => {},
	} as unknown as ExtensionAPI;
	const ctx = {
		cwd: process.cwd(),
		mode: "print",
		isProjectTrusted: () => false,
	} as unknown as ExtensionContext;

	compactTools(pi);
	assert.equal(registered.length, 0, "UI must not register model-facing tools");
	registered.push(...uiRenderers());

	const renderTheme = fakeTheme({
		fg: (_color: string, text: string) => text,
		bg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		italic: (text: string) => text,
		getFgAnsi: (color: string) => THEME_RAMP_ANSI[color] ?? "\x1b[38;2;20;30;40m",
		getColorMode: () => "truecolor",
	});
	const callArguments: Record<string, Record<string, unknown>> = {
		read: { path: "file.ts" },
		write: { path: "file.ts", content: "streaming content" },
		edit: { path: "file.ts", edits: [{ oldText: "old", newText: "new" }] },
		bash: { command: "sleep 10" },
		powershell: { command: "Start-Sleep -Seconds 10" },
		grep: { path: "src", pattern: "TODO" },
		find: { path: "src", pattern: "*.ts" },
		ls: { path: "src" },
	};
	for (const definition of registered) {
		const args = callArguments[definition.name]!;
		const renderBuiltInCall = definition.renderCall as (
			args: Record<string, unknown>,
			theme: Theme,
			ctx: any,
		) => Component;
		for (const phase of [
			{ name: "streaming", argsComplete: false, executionStarted: false },
			{ name: "executing", argsComplete: true, executionStarted: true },
		]) {
			const lines = renderBuiltInCall(args, renderTheme, {
				args,
				argsComplete: phase.argsComplete,
				cwd: process.cwd(),
				executionStarted: phase.executionStarted,
				expanded: false,
				invalidate: () => {},
				isError: false,
				isPartial: true,
				lastComponent: undefined,
				showImages: false,
				state: {},
				toolCallId: `${phase.name}-${definition.name}`,
			}).render(80);
			assert.match(
				lines[0]!,
				/\x1b\[38;2;\d+;\d+;\d+m⦁\x1b\[39m/u,
				`${phase.name} ${definition.name}`,
			);
			assert.match(
				stripTerminalSequences(lines[0]!),
				new RegExp(`⦁ ${definition.name}\\b`, "u"),
				`${phase.name} ${definition.name}`,
			);
		}
	}

	const readDefinition = registered.find(({ name }) => name === "read");
	const renderCall = readDefinition?.renderCall as (args: { path: string }, theme: Theme, ctx: any) => Component;
	const renderResult = readDefinition?.renderResult as (
		result: { content: Array<{ type: "text"; text: string }>; details?: unknown },
		options: { expanded: boolean; isPartial: boolean },
		theme: Theme,
		ctx: any,
	) => Component;
	const content = [{
		type: "text" as const,
		text: Array.from({ length: 2_000 }, (_, index) => `line ${index}`).join("\n"),
	}];
	const rowState: RowState = {};
	const resultContext = {
		args: { path: "file.ts" },
		argsComplete: true,
		cwd: process.cwd(),
		executionStarted: true,
		expanded: true,
		invalidate: () => {},
		isError: false,
		isPartial: true,
		lastComponent: undefined,
		showImages: false,
		state: rowState,
		toolCallId: "cached-result",
	};
	const callLines = renderCall({ path: "file.ts" }, renderTheme, resultContext).render(80);
	// Fully lit frame: the indicator sits on the pulse's bright endpoint, derived from `muted`.
	assert.match(callLines[0]!, /\x1b\[38;2;143;147;151m⦁\x1b\[39m read file\.ts/u);
	assert.doesNotMatch(stripTerminalSequences(callLines[0]!), /⦁ {2}read/u);

	const firstResult = renderResult({ content }, { expanded: true, isPartial: true }, renderTheme, resultContext);
	const firstResultText = firstResult.render(80).map(stripTerminalSequences).join("\n");
	assert.doesNotMatch(firstResultText, /ctrl\+o|toggle all|click/iu);
	const reusedResult = renderResult(
		{ content },
		{ expanded: true, isPartial: true },
		renderTheme,
		{ ...resultContext, lastComponent: firstResult },
	);
	assert.equal(reusedResult, firstResult);
	const changedResult = renderResult(
		{ content: [...content] },
		{ expanded: true, isPartial: true },
		renderTheme,
		{ ...resultContext, lastComponent: firstResult },
	);
	assert.notEqual(changedResult, firstResult);

	// The connector keeps quiet chrome; completed duration/count metadata is one step brighter.
	const finished = renderResult(
		{ content },
		{ expanded: true, isPartial: false },
		renderTheme,
		{ ...resultContext, state: {}, toolCallId: "finished-result", lastComponent: undefined },
	).render(80);
	const controls = finished.at(-1)!;
	assert.match(stripTerminalSequences(controls), /└ Done/u);
	assert.deepEqual([...new Set([...controls.matchAll(/38;2;\d+;\d+;\d+/gu)].map((match) => match[0]))], [
		paintChrome(renderTheme, "x").match(/38;2;\d+;\d+;\d+/u)![0],
		completionPainter(renderTheme)("x").match(/38;2;\d+;\d+;\d+/u)![0],
	]);

	const failedResult = renderResult(
		{ content: [{ type: "text", text: "ENOENT: missing file\nstack frame" }] },
		{ expanded: false, isPartial: false },
		renderTheme,
		{ ...resultContext, expanded: false, isError: true, state: {}, toolCallId: "failed-read", lastComponent: undefined },
	).render(80).map(stripTerminalSequences).join("\n");
	assert.match(failedResult, /Failed.*ENOENT: missing file/u);
	assert.doesNotMatch(failedResult, /stack frame/u);

	// An edit starts with its preview showing, so the error is already on screen:
	// the status line must not repeat it.
	const editDefinition = registered.find(({ name }) => name === "edit");
	const renderEditResult = editDefinition?.renderResult as typeof renderResult;
	const editError = "Could not find the exact text in file.ts. The old text must match exactly.";
	const failedEdit = renderEditResult(
		{ content: [{ type: "text", text: editError }] },
		{ expanded: false, isPartial: false },
		renderTheme,
		{ ...resultContext, args: { path: "file.ts" }, expanded: false, isError: true, state: {}, toolCallId: "failed-edit", lastComponent: undefined },
	).render(200).map(stripTerminalSequences);
	assert.equal(failedEdit.filter((line) => line.includes("Could not find the exact text")).length, 1, "the error appears once");
	assert.match(failedEdit.at(-1)!, /^ └ Failed( in \S+)?$/u);

	// A successful edit reports its change like a diff: lines added and removed,
	// each in the theme's diff color.
	const diffTheme = fakeTheme({ ...renderTheme, fg: (color: string, text: string) => `<${color}>${text}</${color}>` });
	const editDiff = "     ...\n  57 context\n- 58 old line\n+ 58 new line\n+ 59 added line\n  60 context";
	const editedStatus = renderEditResult(
		{ content: [{ type: "text", text: "Successfully replaced 1 block(s) in file.ts." }], details: { diff: editDiff, patch: "" } },
		{ expanded: false, isPartial: false },
		diffTheme,
		{ ...resultContext, args: { path: "file.ts" }, expanded: false, isError: false, state: {}, toolCallId: "counted-edit", lastComponent: undefined },
	).render(200).at(-1)!;
	assert.match(stripTerminalSequences(editedStatus).replace(/<\/?[a-zA-Z]+>/gu, ""), /└ Done.*\(\+2 -1\)$/u);
	assert.ok(editedStatus.includes("<toolDiffAdded>+2</toolDiffAdded>"), "additions use the added color");
	assert.ok(editedStatus.includes("<toolDiffRemoved>-1</toolDiffRemoved>"), "removals use the removed color");

	registered.length = 0;
	handlers.get("session_start")?.({ reason: "startup" }, ctx);
	assert.deepEqual(registered, []);

	// /reload tears the session down and re-invokes the cached factory, exactly like
	// the session replacements covered below. Firing the events alone would not
	// reproduce that, so drive the factory the way Pi does.
	handlers.get("session_shutdown")?.({ reason: "reload" }, ctx);
	compactTools(pi);
	handlers.get("session_start")?.({ reason: "reload" }, ctx);
	assert.deepEqual(registered, [], "reload must not register tools");
	assert.deepEqual(uiRenderers().map(({ name }) => name), [...SUPPORTED_TOOLS]);

	registered.length = 0;
	writeFileSync(join(process.env[agentDirVariable]!, "compact-tools.json"), JSON.stringify({ tools: ["read"] }));
	handlers.get("session_start")?.({ reason: "startup" }, ctx);
	assert.deepEqual(registered, []);
	assert.deepEqual(uiRenderers().map(({ name }) => name), ["read"]);

	registered.length = 0;
	writeFileSync(join(process.env[agentDirVariable]!, "compact-tools.json"), JSON.stringify({ tools: ["read", "edit"] }));
	handlers.get("session_start")?.({ reason: "startup" }, ctx);
	assert.deepEqual(registered, []);
	assert.deepEqual(uiRenderers().map(({ name }) => name), ["read", "edit"]);

	handlers.get("session_shutdown")?.({ reason: "quit" }, ctx);
	if (previousAgentDir === undefined) delete process.env[agentDirVariable];
	else process.env[agentDirVariable] = previousAgentDir;
});

test("registers renderers again after every session replacement", async () => {
	const agentDirVariable = "PI_CODING_AGENT_DIR";
	const previousAgentDir = process.env[agentDirVariable];
	process.env[agentDirVariable] = mkdtempSync(join(tmpdir(), "compact-tools-replace-"));
	writeFileSync(
		join(process.env[agentDirVariable]!, "compact-tools.json"),
		JSON.stringify({ tools: SUPPORTED_TOOLS }),
	);
	const compactTools = (await import("../extensions/compact-tools.ts")).default;
	const ctx = {
		cwd: process.cwd(),
		mode: "print",
		isProjectTrusted: () => false,
	} as unknown as ExtensionContext;

	// Pi caches the extension factory and re-invokes it with a fresh `pi` whose
	// tool registry starts empty. Each host here stands in for one such invocation.
	const createHost = () => {
		const registered: string[] = [];
		const handlers = new Map<string, (event: any, ctx: any) => void>();
		const pi = {
			on: (name: string, handler: (event: any, ctx: any) => void) => handlers.set(name, handler),
			registerTool: (definition: { name: string }) => registered.push(definition.name),
			registerMarkdownTransformer: () => {},
			registerCommand: () => {},
			registerShortcut: () => {},
		} as unknown as ExtensionAPI;
		return { registered, handlers, pi };
	};

	let host = createHost();
	compactTools(host.pi);
	assert.deepEqual(host.registered, [], "startup must not register tools");
	assert.deepEqual(uiRenderers().map(({ name }) => name), [...SUPPORTED_TOOLS]);

	// /resume, /new, and /fork all tear the session down and replace it. Each one
	// must leave the replacement session rendering compactly without a manual /reload.
	for (const reason of ["resume", "new", "fork", "reload"] as const) {
		host.handlers.get("session_shutdown")?.({ reason }, ctx);
		const replacement = createHost();
		compactTools(replacement.pi);
		assert.deepEqual(replacement.registered, [], `/${reason} must not register tools`);
		assert.deepEqual(uiRenderers().map(({ name }) => name), [...SUPPORTED_TOOLS]);

		const afterFactory = replacement.registered.length;
		replacement.handlers.get("session_start")?.({ reason }, ctx);
		assert.equal(
			replacement.registered.length,
			afterFactory,
			`session_start after /${reason} must not register the same tools twice`,
		);
		host = replacement;
	}

	host.handlers.get("session_shutdown")?.({ reason: "quit" }, ctx);
	if (previousAgentDir === undefined) delete process.env[agentDirVariable];
	else process.env[agentDirVariable] = previousAgentDir;
});

test("resolves languages Pi's extension table misses, without guessing", () => {
	// Pi's own mapping still wins where it applies.
	assert.equal(languageFromPath("src/index.ts"), "typescript");
	assert.equal(languageFromPath("a/b/notes.md"), "markdown");

	// Named files that carry no extension.
	assert.equal(languageFromPath("Dockerfile"), "dockerfile");
	assert.equal(languageFromPath("deploy/Containerfile"), "dockerfile");
	assert.equal(languageFromPath("Makefile"), "makefile");
	assert.equal(languageFromPath("CMakeLists.txt"), "cmake");
	assert.equal(languageFromPath("Gemfile"), "ruby");
	assert.equal(languageFromPath("ci/Jenkinsfile"), "groovy");
	assert.equal(languageFromPath("/home/me/.bashrc"), "bash");
	assert.equal(languageFromPath(".editorconfig"), "ini");
	assert.equal(languageFromPath(".env"), "ini");
	assert.equal(languageFromPath(".env.production"), "ini");

	// Extensions Pi does not list.
	assert.equal(languageFromPath("build.mts"), "typescript");
	assert.equal(languageFromPath("tsconfig.jsonc"), "json");
	assert.equal(languageFromPath("run.bat"), "dos");
	assert.equal(languageFromPath("fix.patch"), "diff");
	assert.equal(languageFromPath("logo.svg"), "xml");
	assert.equal(languageFromPath("build.gradle"), "groovy");

	// Case and directory separators must not matter.
	assert.equal(languageFromPath("infra\\DOCKERFILE"), "dockerfile");
	assert.equal(languageFromPath("./Rakefile"), "ruby");

	// Content types that auto-detection reliably gets wrong stay unhighlighted.
	for (const path of ["notes.txt", "server.log", "rows.csv", "data.bin", "LICENSE", "README"]) {
		assert.equal(languageFromPath(path), undefined, path);
	}
});

test("reads the interpreter a shebang declares and ignores anything else", () => {
	assert.equal(languageFromShebang("#!/bin/bash"), "bash");
	assert.equal(languageFromShebang("#!/usr/bin/env python3"), "python");
	assert.equal(languageFromShebang("#!/usr/bin/env -S node --enable-source-maps"), "javascript");
	assert.equal(languageFromShebang("#!/usr/bin/ruby2.7"), "ruby");
	assert.equal(languageFromShebang("#! /usr/bin/env  deno"), "typescript");
	assert.equal(languageFromShebang("#!/usr/bin/env FOO=1 perl"), "perl");

	assert.equal(languageFromShebang("#!/usr/bin/env unknown-thing"), undefined);
	assert.equal(languageFromShebang("# not a shebang"), undefined);
	assert.equal(languageFromShebang("const x = 1;"), undefined);
	assert.equal(languageFromShebang(""), undefined);
});

test("prefers the path over a shebang and only consults a real first line", () => {
	// An extension Pi already knows wins over the interpreter line.
	assert.equal(resolveLanguage("script.py", "#!/bin/bash"), "python");
	// Extensionless script: the shebang is the only declaration available.
	assert.equal(resolveLanguage("bin/release", "#!/usr/bin/env bash"), "bash");
	// No first line supplied (a diff hunk, or a read starting past line 1).
	assert.equal(resolveLanguage("bin/release"), undefined);
	assert.equal(resolveLanguage("bin/release", "  echo hello"), undefined);
});

/**
 * Pi's system theme leaves tokens to the terminal's own colors, whose escape sequence
 * names no color at all. Pi 0.99 still resolves them in `theme.colors`, and the theme's
 * appearance, not a guess from its text color, says which way contrast runs.
 */
test("chrome derives from a token the terminal colors, and follows the theme's appearance", { skip: !hostResolvesColors && "Pi 0.99 and later" }, () => {
	const brightness = (painted: string) => {
		const [r, g, b] = painted.match(/38;2;(\d+);(\d+);(\d+)m/u)!.slice(1).map(Number) as [number, number, number];
		return (r * 0.299 + g * 0.587 + b * 0.114) / 255;
	};
	const systemTheme = (appearance: "dark" | "light") => ({
		// What Pi writes for a token set to the terminal default.
		getFgAnsi: () => "\x1b[39m",
		getColorMode: () => "truecolor",
		fg: (_color: string, text: string) => `<default>${text}`,
		// Neither text nor dim has a color of its own; Pi fills them from the terminal.
		colors: { text: rgb(128, 128, 128), dim: rgb(128, 128, 128) },
		appearance,
	}) as unknown as Theme;
	const dark = paintChrome(systemTheme("dark"), "x");
	const light = paintChrome(systemTheme("light"), "x");
	assert.doesNotMatch(dark, /<default>/u, "the chrome tone is derived, not left to the terminal");
	assert.ok(brightness(dark) >= 0.21 && brightness(dark) <= 0.29, `dark: ${brightness(dark)}`);
	assert.ok(brightness(light) >= 0.71 && brightness(light) <= 0.79, `light: ${brightness(light)}`);
});

/**
 * Pi before 0.99 has no `theme.colors`, `theme.appearance`, or `theme.style()`: its
 * theme only writes escape sequences. The same palette must derive the same colors
 * there, and a palette swapped behind the same Theme, as `/theme` does, must show.
 */
test("a theme from Pi before 0.99 derives the same colors and follows a theme switch", () => {
	let palette: Record<string, string> = { ...THEME_RAMP_ANSI, thinkingHigh: "\x1b[38;2;210;168;255m" };
	const legacy = {
		fg: (color: string, text: string) => `<${color}>${text}`,
		getFgAnsi: (color: string) => palette[color] ?? "",
		getColorMode: () => "truecolor",
	} as unknown as Theme;
	const modern = fakeTheme({ ...legacy as unknown as Record<string, unknown> });
	const drawings = (theme: Theme) => [
		paintChrome(theme, " │ "),
	];
	const before = drawings(legacy);
	assert.deepEqual(before, drawings(modern), "the same palette draws the same, with or without theme.colors");
	assert.ok(before.every((drawn) => /38;2;/u.test(drawn!)), "every drawing is derived, none falls back");

	palette = { ...palette, dim: "\x1b[38;2;200;60;60m", thinkingHigh: "\x1b[38;2;30;200;90m" };
	const after = drawings(legacy);
	assert.notDeepEqual(after, before, "a palette swapped behind the same Theme repaints");
});

test("derived colors are written as Pi 0.99 writes colors, for the terminal's color mode", () => {
	const truecolor = fakeTheme({ getColorMode: () => "truecolor" });
	const palette256 = fakeTheme({ getColorMode: () => "256color" });
	assert.equal(colorizeRgb(truecolor, { r: 10, g: 20, b: 30 }, "x"), "\x1b[38;2;10;20;30mx\x1b[39m");
	assert.equal(fillRgb(truecolor, { r: 10, g: 20, b: 30 }, "x"), "\x1b[48;2;10;20;30mx\x1b[49m");
	// Recorded from Pi 0.99's own conversion: the nearest cube or gray step, never the
	// first sixteen entries, which are whatever the terminal makes of them.
	const recorded = [[128, 0, 0, 88], [10, 20, 30, 16], [200, 200, 205, 251], [255, 128, 0, 208],
		[74, 74, 74, 239], [0, 0, 0, 16], [255, 255, 255, 231], [95, 135, 175, 67]] as const;
	for (const [r, g, b, index] of recorded) {
		assert.equal(colorizeRgb(palette256, { r, g, b }, "x"), `\x1b[38;5;${index}mx\x1b[39m`, `fg rgb(${r},${g},${b})`);
		assert.equal(fillRgb(palette256, { r, g, b }, "x"), `\x1b[48;5;${index}mx\x1b[49m`, `bg rgb(${r},${g},${b})`);
	}
	// Where Pi can write colors itself, every color agrees with it.
	const pi = tui as unknown as { foregroundAnsi?: (color: object, mode: string) => string; rgbColor?: (r: number, g: number, b: number) => object };
	if (!pi.foregroundAnsi || !pi.rgbColor) return;
	for (const [mode, theme] of [["truecolor", truecolor], ["256color", palette256]] as const) {
		for (let r = 0; r < 256; r += 37) {
			for (let g = 0; g < 256; g += 41) {
				for (let b = 0; b < 256; b += 43) {
					assert.equal(colorizeRgb(theme, { r, g, b }, "x"), `${pi.foregroundAnsi(pi.rgbColor(r, g, b), mode)}x\x1b[39m`, `rgb(${r},${g},${b}) ${mode}`);
				}
			}
		}
	}
});

test("caches expanded container lines by width", () => {
	let renders = 0;
	const child: Component = {
		render: (width) => {
			renders++;
			return ["x".repeat(width)];
		},
		invalidate() {},
	};
	const container = new CachedContainer();
	container.addChild(child);
	const first = container.render(80);
	assert.equal(container.render(80), first);
	assert.equal(renders, 1);
	container.render(79);
	assert.equal(renders, 2);
	container.invalidate();
	container.render(79);
	assert.equal(renders, 3);
});

test("reads a thinking duration as a short sentence", () => {
	assert.equal(formatThinkingDuration(300), "under a second");
	assert.equal(formatThinkingDuration(1000), "1 second");
	assert.equal(formatThinkingDuration(12000), "12 seconds");
	assert.equal(formatThinkingDuration(80000), "1m 20s");
	assert.equal(formatThinkingDuration(185000), "3m 5s");
	assert.equal(formatThinkingDuration(120000), "2m");
});

test("measures a finished thinking run and finds it by its text", () => {
	clearThinkingTimings();
	const message = {
		id: "msg-1",
		content: [
			{ type: "thinking", thinking: "## Plan\n\nStep one" },
			{ type: "text", text: "Answer" },
		],
	};
	noteThinkingEvent(message, { type: "thinking_start", contentIndex: 0 }, 1000);
	assert.equal(thinkingDurationFor("## Plan\n\nStep one"), undefined, "a run without its end has no duration");
	noteThinkingEvent(message, { type: "thinking_end", contentIndex: 0 }, 4000);
	assert.equal(thinkingDurationFor("## Plan\n\nStep one"), 3000);
	assert.equal(thinkingDurationFor("Unrelated"), undefined);
});

test("sums a run of several thinking blocks into one duration", () => {
	clearThinkingTimings();
	const message = {
		id: "msg-2",
		content: [
			{ type: "thinking", thinking: "First" },
			{ type: "thinking", thinking: "Second" },
			{ type: "text", text: "Answer" },
		],
	};
	noteThinkingEvent(message, { type: "thinking_start", contentIndex: 0 }, 0);
	noteThinkingEvent(message, { type: "thinking_end", contentIndex: 0 }, 2000);
	noteThinkingEvent(message, { type: "thinking_start", contentIndex: 1 }, 2000);
	noteThinkingEvent(message, { type: "thinking_end", contentIndex: 1 }, 2500);
	assert.equal(thinkingDurationFor("First\n\nSecond"), 2500);
});

test("collapses a finished thinking run and expands it on click", () => {
	clearThinkingTimings();
	assert.ok(installThinkingCollapse(), "the host still has the expected shape");
	const message = {
		id: "msg-3",
		content: [
			{ type: "thinking", thinking: "## Plan\n\nInspect the renderer.\nKeep the cache." },
			{ type: "text", text: "Answer" },
		],
	};
	noteThinkingEvent(message, { type: "thinking_start", contentIndex: 0 }, 0);
	noteThinkingEvent(message, { type: "thinking_end", contentIndex: 0 }, 5000);
	setCollapseTheme(fakeTheme({
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		italic: (text: string) => text,
	}));
	const component = new AssistantMessageComponent(message as never);
	const plain = (lines: string[]) => lines.map((line) => stripTerminalSequences(line).trim()).filter(Boolean);
	assert.deepEqual(plain(component.render(80)), ["Thought for 5 seconds", "Answer"],
		"a finished run reads as one line");
	// Expand: the click region now owns the collapse, so dispatch a click.
	const region = (component as unknown as { contentContainer: { children: unknown[] } }).contentContainer.children
		.find((child) => child instanceof MouseRegion) as { handleMouse(event: unknown): unknown };
	assert.ok(region, "the one-liner sits in a click region");
	region.handleMouse({ type: "click", button: "left", x: 0, y: 0, screenX: 0, screenY: 0, width: 80, height: 1, shift: false, alt: false, ctrl: false });
	const expanded = plain(component.render(80)).join("\n");
	assert.ok(expanded.includes("Plan"), "the full text returns");
	assert.ok(expanded.includes("Inspect the renderer."), "detail included");
	region.handleMouse({ type: "click", button: "left", x: 0, y: 0, screenX: 0, screenY: 0, width: 80, height: 1, shift: false, alt: false, ctrl: false });
	assert.deepEqual(plain(component.render(80)), ["Thought for 5 seconds", "Answer"],
		"a second click compacts again");
	assert.equal(message.content[0]!.thinking, "## Plan\n\nInspect the renderer.\nKeep the cache.",
		"the session's thinking text is never modified");
});

test("leaves streaming and unmeasured thinking runs to the host", () => {
	clearThinkingTimings();
	const message = {
		id: "msg-4",
		content: [
			{ type: "thinking", thinking: "## Plan\n\nStep one" },
			{ type: "text", text: "Answer" },
		],
	};
	const component = new AssistantMessageComponent(message as never);
	const rendered = component.render(80).map((line) => stripTerminalSequences(line).trim()).filter(Boolean).join("\n");
	assert.ok(rendered.includes("Plan"), "the summary shows");
	assert.ok(rendered.includes("Step one"), "the full text shows");
	assert.ok(!rendered.includes("Thought for"), "nothing collapses without a duration");
});


test("renders streaming thinking as summary lines only", () => {
	let transform: ((markdown: string, context: { messageType: string; isStreaming: boolean; availableWidth: number }) => string) | undefined;
	const pi = {
		on: () => {},
		registerMarkdownTransformer: (handler: typeof transform) => {
			transform = handler;
		},
	} as unknown as ExtensionAPI;
	const theme = fakeTheme({
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		italic: (text: string) => text,
	});
	const controller = new ThinkingViewController(pi);
	controller.bind({ ui: { theme, setHiddenThinkingLabel: () => {} } } as unknown as ExtensionContext);
	const context = { messageType: "assistant-thinking", isStreaming: true, availableWidth: 80 };
	assert.equal(transform!("**Planning**\n\nDetailed reasoning", context), "Planning",
		"only the summary line renders while streaming");
	assert.equal(transform!("First\n**Second**", context), "First\n\nSecond",
		"each heading becomes its own summary section");
	assert.equal(transform!("plain", { messageType: "user", isStreaming: false, availableWidth: 80 }), "plain",
		"user markdown passes through untouched");
	controller.dispose();
});

test("summarizes custom tool arguments on one line", () => {
	assert.equal(summarizeCustomArguments({ numResults: 10, queries: ["IREN news", "IREN earnings"] }), "IREN news, IREN earnings");
	assert.equal(summarizeCustomArguments({ mode: "readable", url: "https://example.com" }), "https://example.com");
	assert.equal(summarizeCustomArguments({ note: "first\nsecond" }), "first second");
	assert.equal(summarizeCustomArguments({ options: { deep: true } }), "");
	assert.equal(summarizeCustomArguments({ query: "x".repeat(400) }).length, 160);
});

test("parses custom_tools as a switch or a policy object", () => {
	assert.deepEqual(DEFAULT_CONFIG.custom_tools, { enabled: true, auto_compact: true, exclude: [] });
	assert.equal(mergeConfig(DEFAULT_CONFIG, { custom_tools: false }, "test").custom_tools.enabled, false);
	const merged = mergeConfig(DEFAULT_CONFIG, { custom_tools: { auto_compact: false, exclude: ["web_search"] } }, "test");
	assert.deepEqual(merged.custom_tools, { enabled: true, auto_compact: false, exclude: ["web_search"] });
	assert.deepEqual(mergeConfig(merged, { custom_tools: { exclude: "web_search" } }, "test").custom_tools.exclude, ["web_search"]);
	assert.equal(mergeConfig(merged, { custom_tools: "yes" }, "test").custom_tools.auto_compact, false);
});

class FakeToolRow {
	constructor(
		readonly toolName: string,
		readonly toolDefinition?: { renderCall?: unknown; renderResult?: unknown; renderShell?: "default" | "self" },
	) {}
	getCallRenderer(): unknown {
		return this.toolDefinition?.renderCall;
	}
	getResultRenderer(): unknown {
		return this.toolDefinition?.renderResult;
	}
	getRenderShell(): string {
		return this.toolDefinition?.renderShell ?? "default";
	}
	hasRendererDefinition(): boolean {
		return this.toolDefinition !== undefined;
	}
}

test("routes tool rows through the resolver once per row", () => {
	class Row extends FakeToolRow {}
	const resolverKey = Symbol.for("pi-compact-tools.custom.resolver.v2");
	const holder = globalThis as Record<symbol, unknown>;
	const previous = holder[resolverKey];
	let calls = 0;
	const renderers = { renderCall: () => undefined, renderResult: () => undefined };
	holder[resolverKey] = (row: FakeToolRow) => {
		calls++;
		return row.toolName === "custom" ? renderers : undefined;
	};
	try {
		assert.equal(patchToolRows(Row.prototype), true);
		assert.equal(patchToolRows(Row.prototype), true);
		const custom = new Row("custom");
		assert.equal(custom.hasRendererDefinition(), true);
		assert.equal(custom.getRenderShell(), "self");
		assert.equal(custom.getCallRenderer(), renderers.renderCall);
		assert.equal(custom.getResultRenderer(), renderers.renderResult);
		const own = () => undefined;
		const other = new Row("other", { renderCall: own });
		assert.equal(other.getCallRenderer(), own);
		assert.equal(other.getRenderShell(), "default");
		assert.equal(new Row("other").hasRendererDefinition(), false);
		// One decision per row, however often Pi asks.
		assert.equal(calls, 3);
		holder[resolverKey] = () => undefined;
		assert.equal(custom.getRenderShell(), "default", "a new resolver invalidates provisional cached decisions");
		assert.equal(patchToolRows(undefined), false);
		assert.equal(patchToolRows({ getCallRenderer() {} }), false);
	} finally {
		holder[resolverKey] = previous;
	}
});

test("renders custom tools compactly and expands into the author's renderer", async () => {
	const agentDirVariable = "PI_CODING_AGENT_DIR";
	const previousAgentDir = process.env[agentDirVariable];
	process.env[agentDirVariable] = mkdtempSync(join(tmpdir(), "compact-tools-custom-"));
	writeFileSync(
		join(process.env[agentDirVariable]!, "compact-tools.json"),
		JSON.stringify({ custom_tools: { exclude: ["keep_me"] } }),
	);
	try {
		const compactTools = (await import("../extensions/compact-tools.ts")).default;
		compactTools({
			on: () => {},
			registerTool: () => {},
			registerMarkdownTransformer: () => {},
			registerCommand: () => {},
			registerShortcut: () => {},
		} as unknown as ExtensionAPI);
		class Row extends FakeToolRow {}
		assert.equal(patchToolRows(Row.prototype), true);

		const theme = fakeTheme({
			fg: (_color: string, text: string) => text,
			bg: (_color: string, text: string) => text,
			bold: (text: string) => text,
			italic: (text: string) => text,
			getFgAnsi: () => "\x1b[38;2;20;30;40m",
			getColorMode: () => "truecolor",
		});
		const authorState = { author: true };
		const authorCalls: Array<{ expanded: boolean; state: unknown }> = [];
		const renderAuthorResult = (_result: unknown, options: { expanded: boolean }, _theme: Theme, ctx: any) => {
			authorCalls.push({ expanded: options.expanded, state: ctx.state });
			return { render: () => ["AUTHOR CARD"], invalidate: () => {} };
		};
		const row = new Row("web_search", { renderResult: renderAuthorResult, renderShell: "default" });
		assert.equal(row.getRenderShell(), "self");
		const args = { queries: ["IREN news"], numResults: 10 };
		const context = (expanded: boolean) => ({
			args,
			argsComplete: true,
			cwd: process.cwd(),
			executionStarted: true,
			expanded,
			invalidate: () => {},
			isError: false,
			isPartial: false,
			lastComponent: undefined,
			showImages: false,
			state: authorState,
			toolCallId: `custom-${expanded}`,
		});
		const renderCall = row.getCallRenderer() as (args: unknown, theme: Theme, ctx: unknown) => Component;
		const renderResult = row.getResultRenderer() as (
			result: unknown,
			options: { expanded: boolean; isPartial: boolean },
			theme: Theme,
			ctx: unknown,
		) => Component;
		const call = renderCall(args, theme, context(false)).render(80).map((line) => stripTerminalSequences(line));
		assert.match(call[0]!, /⦁ web_search IREN news$/u);
		const result = { content: [{ type: "text", text: "one\ntwo" }] };

		const collapsed = renderResult(result, { expanded: false, isPartial: false }, theme, context(false))
			.render(80).map((line) => stripTerminalSequences(line));
		assert.equal(collapsed.length, 1);
		assert.match(collapsed[0]!, /^ └ Done.*\(2 lines\)$/u);
		assert.equal(authorCalls.length, 0, "a collapsed row does not ask the author to render");

		const expanded = renderResult(result, { expanded: true, isPartial: false }, theme, context(true))
			.render(80).map((line) => stripTerminalSequences(line));
		assert.deepEqual(expanded.slice(0, 1), [" │ AUTHOR CARD"]);
		assert.deepEqual(authorCalls, [{ expanded: true, state: authorState }]);
		assert.deepEqual(authorState, { author: true }, "compact bookkeeping stays out of the author's state");

		const kept = () => undefined;
		assert.equal(new Row("keep_me", { renderCall: kept }).getCallRenderer(), kept);
		assert.notEqual(new Row("read", { renderCall: kept }).getCallRenderer(), kept, "enabled built-ins are routed only at the UI layer");
	} finally {
		if (previousAgentDir === undefined) delete process.env[agentDirVariable];
		else process.env[agentDirVariable] = previousAgentDir;
	}
});

test("finds where the reader's text moved after rows above it resized", () => {
	const before = ["a1", "a2", "TOOL", "", "b1", "b2", "b3", "c1"];
	// A row above the viewport expanded by three lines.
	const expanded = ["a1", "a2", "TOOL", "x", "y", "z", "", "b1", "b2", "b3", "c1"];
	assert.equal(findAnchorTop(before, 4, 3, expanded), 7);
	// Collapsing it again brings the same text back to its old offset.
	assert.equal(findAnchorTop(expanded, 7, 3, before), 4);
	// When the top line vanished (a hidden tool row), the next surviving text keeps its screen row.
	const hidden = ["a1", "a2", "", "b1", "b2", "b3", "c1"];
	assert.equal(findAnchorTop(["a1", "a2", "TOOL", "DONE", "b1", "b2"], 2, 4, hidden), 1);
	// Blank windows never anchor, and nothing surviving yields no move.
	assert.equal(findAnchorTop(["", "", "q"], 0, 2, ["", "", ""]), undefined);
	// A repeated window picks the occurrence nearest the old position.
	assert.equal(findAnchorTop(["r", "s", "r", "s", "t"], 2, 2, ["n", "r", "s", "r", "s", "t"]), 3);
});

test("keeps the reader's place across a relayout key and ignores a view that follows the end", async () => {
	const { TuiAltScreen } = await import("@earendil-works/pi-tui");
	let content = ["a1", "a2", "TOOL", "", "b1", "b2", "b3", "c1", "c2", "c3"];
	const scrollView = {
		scrollTop: 4,
		isFollowingEnd: false,
		viewportHeight: 3,
		child: { render: () => content },
		getContentWidth: (width: number) => width,
		updateLayout(height: number) { this.height = height; },
		height: content.length,
		scrollTo(top: number) { this.scrollTop = top; },
	};
	const layout = () => ({ root: { children: [{ scrollView, scrollContentLines: content, rect: { width: 40 }, children: [] }] } });
	// Extensions only see a proxy to Pi's current renderer, so the restore hooks the
	// fullscreen renderer's class. Its real doRender returns at once for a renderer
	// that is not on the alternate screen, like this stand-in.
	const tui = {
		terminal: { columns: 40 },
		currentLayout: layout(),
		getPrimaryScrollView: () => scrollView,
	};
	const render = () => (TuiAltScreen.prototype as unknown as { doRender(): void }).doRender.call(tui);
	let input: ((data: string) => unknown) | undefined;
	const ctx = {
		ui: {
			setWidget: (_key: string, factory: unknown) => {
				if (typeof factory === "function") factory(tui, {});
			},
			onTerminalInput: (handler: (data: string) => unknown) => {
				input = handler;
				return () => { input = undefined; };
			},
		},
	} as unknown as ExtensionContext;
	const keeper = new ViewportKeeper();
	keeper.bind(ctx);
	assert.equal(input!("\x0f"), undefined, "the key is observed, never consumed");
	// Pi expands every row: three lines appear above the viewport.
	content = ["a1", "a2", "TOOL", "x", "y", "z", "", "b1", "b2", "b3", "c1", "c2", "c3"];
	render();
	assert.equal(scrollView.scrollTop, 7, "b1 stays on the first screen row");

	// The Kitty release of the same key must not snapshot again: the reader's next
	// scroll would otherwise be pulled back to the old place.
	tui.currentLayout = layout();
	input!("\x1b[111;5:3u");
	scrollView.scrollTop = 2;
	render();
	assert.equal(scrollView.scrollTop, 2, "a released key leaves the reader's scroll alone");

	// Nor may a snapshot undo a scroll that happened before the relayout was drawn.
	scrollView.scrollTop = 7;
	tui.currentLayout = layout();
	input!("\x0f");
	scrollView.scrollTop = 5;
	content = ["a1"];
	render();
	assert.equal(scrollView.scrollTop, 5);

	// Following the end needs no help, so nothing is captured.
	scrollView.isFollowingEnd = true;
	input!("\x0f");
	render();
	assert.equal(scrollView.scrollTop, 5);
	keeper.dispose();
	assert.equal(input, undefined);
});

test("hooks a method once and lets every later load replace only its behavior", () => {
	const legacy = Symbol.for("pi-compact-tools.test.legacyRender");
	class Box {
		render(width: number): string[] {
			return [`box ${width}`];
		}
	}
	// An older version wrapped render and kept the original under its own marker.
	const original = Box.prototype.render;
	Box.prototype.render = function (width: number) {
		return ["OLD", ...original.call(this, width)];
	};
	Object.defineProperty(Box.prototype, legacy, { value: original });
	const name = `test.box.${Math.random()}`;
	assert.equal(hookMethod(Box.prototype, "render", name, (_self, args, render) => ["v1", ...render(...args)], [legacy]), true);
	assert.deepEqual(new Box().render(5), ["v1", "box 5"], "the legacy wrapper is dropped, not stacked");
	// A /reload loads the module again: the same hook now runs the new behavior.
	const wrapper = Box.prototype.render;
	assert.equal(hookMethod(Box.prototype, "render", name, (_self, args, render) => ["v2", ...render(...args)], [legacy]), true);
	assert.equal(Box.prototype.render, wrapper, "installed once per process");
	assert.deepEqual(new Box().render(7), ["v2", "box 7"]);
	assert.equal(hookMethod({}, "render", `${name}.missing`, () => []), false);
});

test("hides Pi's own notice lines from the chat and restores its children", () => {
	const line = (text: string) => ({ render: () => [text], invalidate: () => {} });
	const user = line("PROMPT");
	const answer = line("ANSWER");
	const children: unknown[] = [
		user,
		new Spacer(1),
		new Text("Warning: Wait for the current response to finish before reloading.", 1, 0),
		answer,
		new Spacer(1),
		new Text("Reloaded keybindings, extensions, skills, prompts, themes, and context files", 1, 0),
	];
	const chat = { children };
	const render = () => (chat.children as Array<{ render(width: number): string[] }>).flatMap((child) => child.render(80));
	assert.deepEqual(renderWithoutNotices(chat, 80, render), ["PROMPT", "ANSWER"]);
	assert.equal(chat.children, children, "the chat keeps its own children");
	assert.deepEqual(renderWithoutNotices({ children: [user, answer] }, 80, () => ["unchanged"]), ["unchanged"]);
});

test("counts the lines an edit added and removed from Pi's diff", () => {
	const result = (diff: unknown) => ({ content: [], details: { diff } });
	assert.deepEqual(countEditChanges(result("     ...\n  1 a\n- 2 b\n+ 2 c\n+ 3 d")), { added: 2, removed: 1 });
	assert.deepEqual(countEditChanges(result("+ 1 only added")), { added: 1, removed: 0 });
	assert.equal(countEditChanges(result(undefined)), undefined);
});

test("marks a finished custom tool's row as done before its result is drawn", async () => {
	const compactTools = (await import("../extensions/compact-tools.ts")).default;
	const handlers = new Map<string, (event: any) => void>();
	compactTools({
		on: (name: string, handler: (event: any) => void) => handlers.set(name, handler),
		registerTool: () => {},
		registerMarkdownTransformer: () => {},
		registerCommand: () => {},
		registerShortcut: () => {},
	} as unknown as ExtensionAPI);
	class Row extends FakeToolRow {}
	assert.equal(patchToolRows(Row.prototype), true);
	const theme = fakeTheme({ fg: (color: string, text: string) => `<${color}>${text}</${color}>`, bold: (text: string) => text });
	const row = new Row("web_search", {});
	const renderCall = row.getCallRenderer() as (args: unknown, theme: Theme, ctx: unknown) => Component;
	const context = {
		args: { query: "pi" }, argsComplete: true, cwd: process.cwd(), executionStarted: true, expanded: false,
		invalidate: () => {}, isError: false, isPartial: false, lastComponent: undefined, showImages: false,
		state: {}, toolCallId: "custom-finished",
	};
	handlers.get("tool_execution_start")?.({ toolCallId: "custom-finished", toolName: "web_search", args: {} });
	// Pi tells extensions a tool ended, then redraws the row call first, result second.
	handlers.get("tool_execution_end")?.({ toolCallId: "custom-finished", toolName: "web_search", result: {}, isError: false });
	const call = renderCall({ query: "pi" }, theme, context).render(80)[0]!;
	assert.match(call, /<success>⦁<\/success>/u, "the dot turns green without waiting for another redraw");
});

test("lets auto_compact name a custom tool, overriding the custom_tools default for it", () => {
	const warnings: string[] = [];
	const originalError = console.error;
	console.error = (message: string) => warnings.push(message);
	try {
		const merged = mergeConfig(DEFAULT_CONFIG, { auto_compact: { web_search: false, fetch_content: "no" } }, "test");
		assert.equal(merged.auto_compact.web_search, false);
		assert.equal(merged.auto_compact.fetch_content, undefined, "a non-boolean value is ignored");
		assert.deepEqual(warnings, ["[compact-tools] test: auto_compact.fetch_content must be true or false; using previous value"]);
		assert.equal(merged.auto_compact.read, true, "built-ins keep their defaults");

		const runtime = new ToolRuntime();
		runtime.configure(merged);
		const listed: RowState = {};
		runtime.syncExpansion(listed, false, "web_search");
		assert.equal(listed.preview, true, "web_search: false starts with a preview");
		const unlisted: RowState = {};
		runtime.syncExpansion(unlisted, false, "other_tool");
		assert.equal(unlisted.preview, false, "other custom tools follow custom_tools.auto_compact");
		runtime.reset(true);
	} finally {
		console.error = originalError;
	}
});

// Named like Pi's class: grouping recognizes a second copy of Pi's classes by name.
class ToolExecutionComponent {
	expanded = false;
	isPartial: boolean;
	result?: { content: Array<{ type: "text"; text: string }>; isError?: boolean };
	constructor(
		readonly toolName: string,
		readonly args: Record<string, unknown>,
		output?: string,
		isError = false,
		readonly toolCallId = `${toolName}-${Math.random()}`,
	) {
		this.isPartial = output === undefined;
		if (output !== undefined) this.result = { content: [{ type: "text", text: output }], isError };
	}
	render(): string[] {
		return ["", `ROW ${this.toolName}`];
	}
	invalidate(): void {}
}

const toolRow = (name: string, args: Record<string, unknown>, output?: string, isError = false) =>
	new ToolExecutionComponent(name, args, output, isError) as unknown as ToolRowLike;

test("claude mode words a group the way Claude Code does, in progress or done", () => {
	const done = [
		toolRow("read", { path: "a.ts" }, "a"),
		toolRow("grep", { pattern: "x" }, "hit"),
		toolRow("read", { path: "b.ts" }, "b"),
		toolRow("read", { path: "a.ts" }, "a"),
		toolRow("find", { pattern: "*.ts" }, "a.ts"),
		toolRow("ls", {}, "a.ts"),
		toolRow("bash", { command: "rg TODO src | head -5" }, "x"),
	];
	assert.equal(summarizeGroup(done), "Searched for 3 patterns, read 2 files, listed 1 directory",
		"searches first, then reads by distinct file, then listings");
	assert.equal(summarizeGroup(done, (count) => `*${count}*`), "Searched for *3* patterns, read *2* files, listed *1* directory");
	const running = [toolRow("read", { path: "a.ts" }, "a"), toolRow("grep", { pattern: "x" })];
	assert.equal(summarizeGroup(running), "Searching for 1 pattern, reading 1 file");
	assert.deepEqual(countGroup([toolRow("bash", { command: "cat a | wc -l" }, "1")]), { search: 0, read: 1, list: 0 },
		"a read by command counts when no file was read");
	assert.equal(EXPAND_HINT, "(click to expand)", "a click opens one group; Ctrl+O would open every row");
});

test("only commands that look around fold into a group", () => {
	assert.equal(classifyShellCommand("rg -n TODO src | head -20"), "search");
	assert.equal(classifyShellCommand("cat a.ts && wc -l b.ts"), "read");
	assert.equal(classifyShellCommand("ls -la; echo done"), "list");
	assert.equal(classifyShellCommand("grep x a | sort | uniq"), "search");
	assert.equal(classifyShellCommand("echo hi"), undefined, "a command that only prints looks at nothing");
	assert.equal(classifyShellCommand("npm test"), undefined);
	assert.equal(classifyShellCommand("cat a.ts && npm test"), undefined, "one step that runs something is enough to keep it apart");
	assert.equal(classifyShellCommand("rg 'a|b' src"), "search", "a pipe inside quotes is part of the pattern");
	assert.equal(classifyShellCommand("find . -delete"), undefined, "a find that deletes is no search");
	assert.equal(classifyShellCommand("cat a.ts > b.ts"), undefined, "a read that writes a file is no read");
	assert.equal(classifyShellCommand("rg x src 2>/dev/null"), "search", "output thrown away writes nothing");
	// Claude Code's own lists, every command in each.
	const lists = {
		search: ["find", "grep", "rg", "ag", "ack", "locate", "which", "whereis"],
		read: ["cat", "head", "tail", "less", "more", "wc", "stat", "file", "strings", "jq", "awk", "cut", "sort", "uniq", "tr"],
		list: ["ls", "tree", "du"],
	} as const;
	for (const [kind, programs] of Object.entries(lists)) {
		for (const program of programs) assert.equal(classifyShellCommand(`${program} x`), kind, program);
	}
	for (const neutral of ["echo", "printf", "true", "false", ":"]) {
		assert.equal(classifyShellCommand(neutral), undefined, `${neutral} alone looks at nothing`);
		assert.equal(classifyShellCommand(`${neutral} x && cat y`), "read", `${neutral} does not change what cat does`);
	}
	for (const other of ["npm", "node", "git", "sed", "mkdir", "rm", "python3", "curl"]) {
		assert.equal(classifyShellCommand(`${other} x`), undefined, other);
	}
});

test("a group's second line names the running call, and failures stay in view", () => {
	const read = toolRow("read", { path: "a.ts" }, "one\ntwo");
	assert.equal(groupHint([read, toolRow("grep", { pattern: "x", path: "src" })]), '"x"');
	assert.equal(groupHint([toolRow("bash", { command: "cat a.ts" })]), "$ cat a.ts");
	assert.equal(groupHint([read]), undefined, "a finished group needs no second line");
	assert.equal(groupHint([toolRow("grep", {})]), undefined, "nothing to name while the arguments stream in");
	const failed = toolRow("read", { path: "gone.ts" }, "ENOENT: no such file", true);
	assert.deepEqual(groupFailures([read, failed]), ["Error: ENOENT: no such file"]);
});

test("a collapsed command is cut only past Claude Code's two lines or 160 characters", () => {
	const long = "x".repeat(200);
	assert.equal(claudeCommand("npm test", false), "npm test");
	assert.equal(claudeCommand("a\nb", false), "a\nb");
	assert.equal(claudeCommand("a\nb\nc", false), "a\nb…", "a third line is cut");
	assert.equal(claudeCommand(long, false), `${"x".repeat(160)}…`, "past 160 characters is cut");
	assert.equal(claudeCommand("x".repeat(160), false), "x".repeat(160), "exactly 160 is whole");
	assert.equal(claudeCommand(`a\nb\nc ${long}`, true), `a\nb\nc ${long}`, "opened, the whole command shows");
	// The title wraps to the width instead: a command within the limits is never cut to the row.
	const title = claudeTitle("bash", { command: "echo " + "word ".repeat(20) });
	assert.equal(title.argument, "echo " + "word ".repeat(20).trim());
});

test("titles and outcomes read like Claude Code's", () => {
	assert.deepEqual(claudeTitle("bash", { command: "npm test\nnpm run lint" }), { label: "Bash", argument: "npm test\nnpm run lint" },
		"two lines fit Claude Code's limit and show whole");
	assert.deepEqual(claudeTitle("edit", { path: "src/app.ts" }), { label: "Update", argument: "src/app.ts" });
	assert.deepEqual(claudeTitle("web_search", { query: "pi tui", limit: 5, domains: ["a", "b"] }),
		{ label: "web_search", argument: 'query: "pi tui", limit: 5, domains: ["a", "b"]' });
	assert.equal(claudeArgument("grep", { pattern: "TODO" }), 'pattern: "TODO"');
	const text = (value: string, details?: unknown) => ({ content: [{ type: "text" as const, text: value }], details });
	const bold = (value: string) => `*${value}*`;
	assert.equal(claudeOutcome("read", { path: "a" }, text("1\n2\n3"), "1\n2\n3", bold), "Read *3* lines");
	assert.equal(claudeOutcome("write", { path: "a.md", content: "x\ny" }, text(""), "x\ny", bold), "Wrote *2* lines to *a.md*");
	assert.equal(claudeOutcome("edit", { path: "a.ts" }, text("", { diff: "+1 new\n-1 old\n+2 more" }), ""),
		"Added 2 lines, removed 1 line");
	assert.equal(claudeOutcome("edit", { path: "a.ts" }, text("", { diff: "-1 old" }), ""), "Removed 1 line");
	assert.equal(claudeOutcome("bash", { command: "ls" }, text("a"), "a"), undefined, "a command shows its output instead");
	assert.deepEqual(claudeFailure("bash", "boom\nCommand exited with code 2"), { headline: "Error: Exit code 2", detail: "boom" });
	assert.deepEqual(claudeFailure("edit", "Could not find the text to replace"),
		{ headline: "Error: Could not find the text to replace", detail: "" });
});

test("output previews in rows the way Claude Code does", () => {
	const more = (hidden: number) => `+${hidden}`;
	const rows = (lines: string[], width: number) => claudeRows(lines, "> ", "  ", 3, more).render(width);
	assert.deepEqual(rows(["1", "2", "3", "4", "5"], 20), ["> 1", "  2", "  3", "  +2"]);
	assert.deepEqual(rows(["1", "2", "3", "4"], 20), ["> 1", "  2", "  3", "  4"], "one more row shows rather than a count of one");
	// Rows wrap ten columns short of the width, and a wrapped line counts as its rows.
	assert.deepEqual(rows(["x".repeat(25), "y"], 20), ["> xxxxxxxxxx", "  xxxxxxxxxx", "  xxxxx", "  y"]);
	assert.deepEqual(claudeRows(["1", "2", "3", "4", "5"], "> ", "  ", undefined, more).render(20).length, 5, "opened, all of it");
});

test("folds reads, searches, and the thinking between them; commands and answers stay apart", () => {
	const text = (label: string) => ({ render: () => [label], invalidate() {} });
	const thinking = new AssistantMessageComponent({
		content: [{ type: "thinking", thinking: "Plan" }, { type: "toolCall", id: "d", name: "read", arguments: {} }],
		stopReason: "toolUse",
	} as never);
	const said = new AssistantMessageComponent({
		content: [{ type: "text", text: "Checking" }, { type: "toolCall", id: "e", name: "read", arguments: {} }],
		stopReason: "toolUse",
	} as never);
	const status = new Text("Tool output: collapsed", 1, 0);
	const read = toolRow("read", { path: "a" }, "a");
	const grep = toolRow("grep", { pattern: "x" }, "x");
	const bash = toolRow("bash", { command: "npm test" }, "a");
	const ls = toolRow("ls", {}, "a");
	const find = toolRow("find", { pattern: "*" }, "a");
	const answer = text("ANSWER");
	const groups: Array<{ rows: ToolRowLike[]; members: unknown[] }> = [];
	const result = groupChildren([thinking, read, thinking, status, grep, bash, ls, said, find, thinking, answer], (rows, members) => {
		groups.push({ rows, members });
		return text(`GROUP ${rows.length}`);
	});
	assert.deepEqual(groups.map((group) => group.rows), [[read, grep], [ls], [find]]);
	assert.deepEqual(groups[0]!.members, [read, thinking, status, grep], "what sat between the calls opens with the group");
	const label = (child: unknown) => (child as { render(width: number): string[] }).render(80).find(Boolean);
	assert.deepEqual(result.map(label), [
		label(thinking), "GROUP 2", "ROW bash", "GROUP 1", label(said), "GROUP 1", label(thinking), "ANSWER",
	], "a thinking turn before a run, or after it with nothing to fold into, stays where it was");
});

test("a group opens on click and follows Ctrl+O both ways", () => {
	const rows = [toolRow("read", { path: "a" }, "a"), toolRow("grep", { pattern: "x" }, "b")];
	const state = { expanded: false, lastHostExpanded: false };
	let toggles = 0;
	const draw = (_rows: readonly ToolRowLike[], _width: number, expanded: boolean) => ["", expanded ? "OPEN" : "SUMMARY"];
	const group = (onToggle = () => {}) => new ToolGroupComponent(rows, rows, state, draw, onToggle);
	const collapsed = group(() => toggles++);
	assert.deepEqual(collapsed.render(80), ["", "SUMMARY"]);
	assert.ok(collapsed.handleMouse({ type: "click", button: "left", x: 1, y: 1, width: 80, height: 2 } as never));
	assert.equal(toggles, 1);
	assert.deepEqual(group().render(80), ["", "OPEN", "", "ROW read", "", "ROW grep"]);
	// Ctrl+O collapses every row in Pi, then expands them again.
	for (const row of rows) row.expanded = true;
	assert.equal(group().render(80).length, 6);
	for (const row of rows) row.expanded = false;
	assert.deepEqual(group().render(80), ["", "SUMMARY"]);
});

test("collapsed Claude rows keep each line to one row and keep output indentation", () => {
	const text = "      70 README.md\n" + "x".repeat(30);
	assert.deepEqual(prefixedLines(text, " └ ", "   ", true).render(20).map(stripTerminalSequences),
		[" └       70 README.…", "   xxxxxxxxxxxxxxxx…"]);
	assert.deepEqual(prefixedLines("abcdefgh", " └ ", "   ", false).render(8), [" └ abcde", "   fgh"]);
});

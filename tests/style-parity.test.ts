/**
 * A custom tool's row is drawn in the same style as a built-in's, in every style
 * and every phase; tools left to Pi keep Pi's rows; and silent mode hides every
 * row in either style, then shows each exactly as it was, without rebuilding one.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { timerClock } from "./indicator-harness.ts";
import { AssistantMessageComponent } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import {
	announce, CASES, CUSTOM_CASES, INDICATOR_INTERVAL_MS, loadExtension, makeRow, restoreClocks, shutdown, text, type Harness,
} from "./indicator-harness.ts";

type Row = ReturnType<typeof makeRow>;
const ESCAPE = /\x1b\[[0-9;]*m/gu;
const plain = (line: string) => line.replace(ESCAPE, "");
/** The escape sequence a line opens with: the color its chrome is drawn in. */
const leadingColor = (line: string) => line.match(/^\s*(\x1b\[[0-9;]*m)/u)?.[1];
const dotOf = (lines: string[]) => lines.join("\n").match(/\x1b\[[0-9;]*m[⦁•]/u)?.[0];

/** One run of silent mode's activity line: 26 frames on the shared 80 ms clock. */
const ANIMATION_WINDOW_MS = 26 * 80;
const STYLES = { compact: { style: "compact" }, claude: { style: "claude" }, codex: { style: "codex" } } as const;
let sequence = 0;

/** A built-in and a custom tool run side by side, drawn at the same moments. */
function pair(harness: Harness, failed: boolean, expanded: boolean) {
	const make = (name: string, definition: object | undefined) => {
		const id = `${name}-${++sequence}`;
		announce(harness, id, name);
		const row = makeRow(name, id, name === "bash" ? CASES.bash!.args : CUSTOM_CASES.web_search!.args, definition);
		row.setExpanded(expanded);
		row.setArgsComplete();
		harness.handlers.get("tool_execution_start")!({ toolCallId: id, toolName: name, args: {} });
		row.markExecutionStarted();
		return { id, row };
	};
	const builtIn = make("bash", harness.definitions.get("bash"));
	const custom = make("web_search", undefined);
	const finish = () => {
		for (const [{ id, row }, outcome] of [[builtIn, CASES.bash!], [custom, CUSTOM_CASES.web_search!]] as const) {
			harness.handlers.get("tool_execution_end")!({ toolCallId: id, isError: failed });
			row.updateResult({ ...(failed ? outcome.failure : outcome.success), isError: failed } as never, false);
		}
	};
	return { builtIn: builtIn.row, custom: custom.row, finish };
}

function tick(frames = 1): void {
	for (let frame = 0; frame < frames; frame++) timerClock.tick(INDICATOR_INTERVAL_MS);
}

for (const [styleName, config] of Object.entries(STYLES)) {
	for (const preview of [false, true]) {
		const settings = preview
			? { ...config, auto_compact: { bash: false }, custom_tools: { auto_compact: false } }
			: config;
		const label = `${styleName}${preview ? " with previews" : ""}`;

		if (styleName === "codex") test(`a custom tool's row wears Codex's chrome while it runs and once it ends (${label})`, async () => {
			for (const failed of [false, true]) {
				for (const expanded of [false, true]) {
					const harness = await loadExtension(settings, { tui: true, idle: false });
					const { builtIn, custom, finish } = pair(harness, failed, expanded);
					const at = `${label}, ${failed ? "failed" : "done"}, ${expanded ? "open" : "closed"}`;
					// Running, with nothing yet to open: Codex's "Calling" and "Running", behind the same bullet on the same frame.
					for (let frame = 0; frame < 16; frame++) {
						const [b, c] = [builtIn.render(100), custom.render(100)];
						assert.match(plain(c[1]!), /^ • Calling web_search/u, at);
						assert.equal(dotOf(c), dotOf(b), `${at}: frame ${frame} dot`);
						assert.match(plain(b[1]!), /^ • Running cd \/project/u, at);
						tick();
					}
					finish();
					const [b, c] = [builtIn.render(100), custom.render(100)];
					// Opened, a command with more than its preview reads `$ cmd` as Codex's transcript does, with no bullet;
					// a one-line failure has nothing more and keeps its preview.
					const commandOpened = expanded && !failed;
					if (!commandOpened) assert.equal(dotOf(c), dotOf(b), `${at}: settled dot`);
					assert.match(plain(c[1]!), failed ? /^ • Failed web_search/u : /^ • Called web_search/u, at);
					assert.match(plain(b[1]!), commandOpened ? /^ \$ cd \/project/u : failed ? /^ • Failed \(exit 1\) cd/u : /^ • Ran cd/u, at);
					// Collapsed, what follows the call hangs from "└" four columns in, and the control reads the same way.
					if (!expanded) {
						for (const lines of [b, c]) {
							assert.match(plain(lines[2]!), /^ {3}└ /u, `${at}: ${JSON.stringify(plain(lines[2]!))}`);
							for (const line of lines.slice(3)) assert.match(plain(line), /^ {5}\S/u, `${at}: ${JSON.stringify(plain(line))}`);
						}
					}
					assert.equal(plain(c.at(-1)!), expanded ? "     − Show less" : "     + Show details", at);
					if (commandOpened) assert.equal(plain(b.at(-1)!), "     − Show less", at);
					// The tail under "└" is dim, in the same color for both.
					const chrome = (lines: string[]) => new Set(lines.slice(2).filter((line) => plain(line).startsWith("   └ ")).map(leadingColor));
					for (const color of chrome(c)) assert.ok(chrome(b).has(color) || chrome(b).size === 0, `${at}: chrome ${JSON.stringify(color)}`);
					shutdown(harness);
				}
			}
		});
		else test(`a custom tool's row wears the built-in style while it runs and once it ends (${label})`, async () => {
			for (const failed of [false, true]) {
				for (const expanded of [false, true]) {
					const harness = await loadExtension(settings, { tui: true, idle: false });
					const { builtIn, custom, finish } = pair(harness, failed, expanded);
					const at = `${label}, ${failed ? "failed" : "done"}, ${expanded ? "open" : "closed"}`;
					// Running: the same dot, pulsing on the same frame, on a call line of the same shape.
					for (let frame = 0; frame < 16; frame++) {
						const [b, c] = [builtIn.render(100), custom.render(100)];
						assert.equal(dotOf(c), dotOf(b), `${at}: frame ${frame} dot`);
						assert.match(plain(c[1]!), /^ ⦁ web_search/u, at);
						assert.equal(plain(b[1]!).slice(0, 3), plain(c[1]!).slice(0, 3), `${at}: call line`);
						tick();
					}
					finish();
					const [b, c] = [builtIn.render(100), custom.render(100)];
					assert.equal(dotOf(c), dotOf(b), `${at}: settled dot`);
					// Every line under the call starts with the same chrome, in the same color.
					for (const lines of [b, c]) {
						for (const line of lines.slice(2)) {
							assert.match(plain(line), /^( [└│] |   ⎿  |   )/u, `${at}: ${JSON.stringify(plain(line))}`);
						}
					}
					const chrome = (lines: string[]) => new Set(lines.slice(2).filter((line) => /^\s*\x1b\[[0-9;]*m\s*[└│]/u.test(line)).map(leadingColor));
					const builtInChrome = chrome(b);
					for (const color of chrome(c)) assert.ok(builtInChrome.has(color) || builtInChrome.size === 0, `${at}: chrome ${JSON.stringify(color)}`);
					if (styleName === "compact") {
						// The status line reads the same way.
						const status = (lines: string[]) => plain(lines.at(-1)!).replace(/\d+\.\d{3}s/u, "T").replace(/\(\d+ lines?\)/u, "(N)").replace(/ · .*$/u, " · reason");
						assert.equal(status(c), status(b), `${at}: status line`);
					} else {
						assert.match(plain(c[1]!), /^ ⦁ web_search\(query: "pi tui", limit: 3\)$/u, `${at}: Claude Code's call line`);
						assert.match(plain(b[1]!), /^ ⦁ Bash\(/u, at);
						assert.match(plain(c[2]!), /^   ⎿  /u, `${at}: an outcome under the call`);
					}
					shutdown(harness);
				}
			}
		});
	}

	test(`custom tools switched off, or excluded, keep Pi's own rows (${styleName})`, async () => {
		for (const custom_tools of [false, { exclude: ["web_search"] }]) {
			const harness = await loadExtension({ ...config, custom_tools }, { tui: true, idle: false });
			announce(harness, "left", "web_search");
			const left = makeRow("web_search", "left", CUSTOM_CASES.web_search!.args, undefined);
			announce(harness, "kept", "other_tool");
			const kept = makeRow("other_tool", "kept", { query: "x" }, undefined);
			for (const row of [left, kept]) row.updateResult({ ...text("out"), isError: false } as never);
			const leftLines = left.render(100).map(plain);
			assert.ok(!leftLines.some((line) => /[⦁•]/u.test(line)), `${JSON.stringify(custom_tools)}: Pi draws it`);
			assert.ok(leftLines.some((line) => line.includes("web_search")), JSON.stringify(custom_tools));
			const keptLines = kept.render(100).map(plain);
			assert.equal(keptLines.some((line) => /[⦁•]/u.test(line)), custom_tools !== false,
				`${JSON.stringify(custom_tools)}: another custom tool follows the policy`);
			shutdown(harness);
		}
	});
}

/** Pi's transcript: a turn that only hands off, the calls it made, and the answer after them. */
function transcript(harness: Harness) {
	const rows: Row[] = [];
	const call = (name: string, args: object, definition: object | undefined, result?: object) => {
		const id = `silent-${name}-${++sequence}`;
		announce(harness, id, name);
		const row = makeRow(name, id, args, definition);
		row.setArgsComplete();
		harness.handlers.get("tool_execution_start")!({ toolCallId: id, toolName: name, args });
		row.markExecutionStarted();
		if (result) {
			harness.handlers.get("tool_execution_end")!({ toolCallId: id, isError: false });
			row.updateResult({ ...result, isError: false } as never, false);
		}
		rows.push(row);
		return row;
	};
	const handoff = new AssistantMessageComponent({
		content: [{ type: "thinking", thinking: "Looking" }, { type: "toolCall", id: "t", name: "read", arguments: {} }],
		stopReason: "toolUse",
	} as never);
	const children: unknown[] = [handoff];
	children.push(call("read", CASES.read!.args, harness.definitions.get("read"), CASES.read!.success));
	children.push(call("grep", CASES.grep!.args, harness.definitions.get("grep"), CASES.grep!.success));
	children.push(call("web_search", CUSTOM_CASES.web_search!.args, undefined, CUSTOM_CASES.web_search!.success));
	const runningBash = call("bash", CASES.bash!.args, harness.definitions.get("bash"));
	children.push(runningBash);
	const answer = new AssistantMessageComponent({ content: [{ type: "text", text: "The answer." }], stopReason: "stop" } as never);
	children.push(answer);
	harness.chat.children = children as Component[];
	return { rows, runningBash };
}

const silentState = () =>
	(globalThis as Record<symbol, { active: boolean; enabled: boolean }>)[Symbol.for("pi-compact-tools.silent.state")]!;

for (const [styleName, config] of Object.entries(STYLES)) {
	test(`silent mode hides every row and shows each again as it was (${styleName})`, async () => {
		// Starting in silent mode installs the hiding, as a user's configuration would.
		const harness = await loadExtension({ ...config, mode: "silent" }, { tui: true, idle: false });
		try {
			// Silent mode hides every row while the agent works, and asks for no
			// frames of its own: Pi's untouched working label carries the progress.
			const { rows } = transcript(harness);
			const state = silentState();
			assert.equal(state.enabled && state.active, true, "silent from the start");
			const hidden = harness.chat.render(100).map(plain);
			assert.deepEqual(hidden.filter((line) => /[⦁•]/u.test(line)), [], "no tool row, custom or built-in, and no group");
			assert.ok(hidden.some((line) => line.includes("The answer.")), "the answer stays");
			assert.ok(!hidden.some((line) => line.includes("Looking")), "the hand-off turn goes");
			for (const row of rows) assert.deepEqual(row.render(100), [], "each row draws nothing");

			// Hidden rows ask for no frames of their own, however long the call runs.
			const before = harness.requestRenders();
			timerClock.tick(ANIMATION_WINDOW_MS);
			assert.equal(harness.requestRenders() - before, 0, "hidden rows ask for no frames");

			// Shown again: every row, in the style, with the running call pulsing again.
			state.enabled = false;
			const shown = harness.chat.render(100).map(plain);
			const calls = shown.filter((line) => line.includes("⦁"));
			if (styleName === "compact") {
				assert.deepEqual(calls.map((line) => line.split(" ").slice(0, 3).join(" ")), [" ⦁ read", " ⦁ grep", " ⦁ web_search", " ⦁ bash"]);
			} else if (styleName === "codex") {
				assert.deepEqual(shown.filter((line) => line.includes("•")).map((line) => line.split(" ").slice(0, 4).join(" ")),
					[" • Explored", " • Called web_search", " • Running cd"]);
			} else {
				assert.deepEqual(calls.map((line) => line.replace(/\(.*$/u, "(")),
					[" ⦁ Searched for 1 pattern, read 1 file (", " ⦁ web_search(", " ⦁ Bash("]);
			}
			const asked = harness.requestRenders();
			for (let frame = 0; frame < 3; frame++) {
				tick();
				harness.chat.render(100);
			}
			assert.ok(harness.requestRenders() > asked, "the running call animates once shown");

			// Hidden and shown again with nothing changed, it draws exactly the same.
			state.enabled = true;
			assert.deepEqual(harness.chat.render(100).map(plain).filter((line) => /[⦁•]/u.test(line)), []);
			state.enabled = false;
			const again = harness.chat.render(100);
			state.enabled = true;
			state.enabled = false;
			assert.deepEqual(harness.chat.render(100), again);
		} finally {
			silentState().enabled = false;
			shutdown(harness);
		}
	});

	test(`silent mode rebuilds no row to hide or show it (${styleName})`, async () => {
		const harness = await loadExtension({ ...config, mode: "silent" }, { tui: true, idle: false });
		try {
			let rebuilds = 0;
			const count = (name: string) => {
				const definition = harness.definitions.get(name) as Record<string, any>;
				return { ...definition, renderCall: (...args: unknown[]) => { rebuilds++; return definition.renderCall(...args); } };
			};
			announce(harness, "counted", "read");
			const row = makeRow("read", "counted", CASES.read!.args, count("read"));
			row.updateResult({ ...CASES.read!.success, isError: false } as never);
			harness.chat.children = [row];
			const made = rebuilds;
			const state = silentState();
			for (let toggle = 0; toggle < 5; toggle++) {
				state.enabled = !state.enabled;
				harness.chat.render(100);
			}
			assert.equal(rebuilds, made);
		} finally {
			silentState().enabled = false;
			shutdown(harness);
		}
	});
}

test.after(restoreClocks);

import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import {
	indicatorGlyph,
	indicatorStrength,
	indicatorTone,
	RUNNING_INDICATOR_FRAME_COUNT,
	type RowStatus,
} from "./compact-tools-core.ts";
import {
	colorizeRgb,
	interpolateRgb,
	neutralizeRgb,
	paletteOf,
	rgbPainter,
	themeColorRgb,
	withContrast,
	type Rgb,
} from "./compact-tools-color.ts";

/**
 * Colors this extension draws with, derived from the active theme rather than named on it.
 *
 * Naming a color does not travel. `borderAccent` is a quiet gray in github-dark-pro and
 * electric cyan in Pi's own dark theme; `dim` is the dimmest name a theme offers yet is
 * still sized for body text, a step louder than a rail should be; and a hard-coded white
 * highlight disappears entirely on a light background. So each value here takes a theme
 * color for its hue and then places it: chrome and the indicator give up most of their
 * saturation and are pulled into a fixed contrast band. Everything is measured against the theme
 * background, so the same code reads the same way on light and dark alike: against a light
 * background the moves invert, and standing out means going darker.
 */

type ContrastBand = { color: ThemeColor; keepHue: number; minimum: number; maximum: number };

/**
 * A quiet frame tone for rails, connectors, and separators. Completion metadata
 * sits one small brightness step above it so duration and line counts remain legible.
 */
const CHROME: ContrastBand = { color: "dim", keepHue: 0.35, minimum: 0.22, maximum: 0.28 };
const COMPLETION: ContrastBand = { ...CHROME, minimum: 0.26, maximum: 0.32 };
/** The indicator breathes either side of the chrome tone, dipping below it and peaking above. */
const PULSE_LOW: ContrastBand = { color: "dim", keepHue: 0.4, minimum: 0.18, maximum: 0.3 };
const PULSE_HIGH: ContrastBand = { color: "muted", keepHue: 0.4, minimum: 0.4, maximum: 0.6 };

/**
 * Derived colors, kept for as long as the palette they came from. `/theme` swaps the
 * palette behind the same Theme, so the palette rather than the Theme is the key: a
 * switch misses the cache by itself, and every frame in between is a lookup.
 */
const derivedByPalette = new WeakMap<object, Map<string, unknown>>();

export function perPalette<T>(theme: Theme, key: string, derive: () => T): T {
	const palette = paletteOf(theme);
	let cache = derivedByPalette.get(palette);
	if (!cache) derivedByPalette.set(palette, cache = new Map());
	if (!cache.has(key)) cache.set(key, derive());
	return cache.get(key) as T;
}

function bandedRgb(theme: Theme, band: ContrastBand): Rgb | undefined {
	const rgb = themeColorRgb(theme, band.color);
	if (!rgb) return undefined;
	return withContrast(theme, neutralizeRgb(rgb, band.keepHue), band.minimum, band.maximum);
}

/** A painter for the chrome tone, derived once per palette however many rails a frame draws. */
export function chromePainter(theme: Theme): (text: string) => string {
	return perPalette(theme, "chrome", () => {
		const chrome = bandedRgb(theme, CHROME);
		return chrome ? rgbPainter(theme, chrome) : (text: string) => theme.fg("dim", text);
	});
}

/** Duration and line-count metadata is slightly brighter than rails and separators. */
export function completionPainter(theme: Theme): (text: string) => string {
	return perPalette(theme, "completion-metadata", () => {
		const color = bandedRgb(theme, COMPLETION);
		return color ? rgbPainter(theme, color) : (text: string) => theme.fg("dim", text);
	});
}

/** Nested names keep the title hue, slightly darker than ordinary titles, without bold. */
export function nestedTitlePainter(theme: Theme): (text: string) => string {
	return perPalette(theme, "nested-title", () => {
		const title = themeColorRgb(theme, "toolTitle");
		const paint = title ? rgbPainter(theme, interpolateRgb(title, { r: 0, g: 0, b: 0 }, 0.25))
			: (text: string) => theme.fg("toolTitle", text);
		return paint;
	});
}

/** Quiet summary numbers retain outcome hues at 80% brightness. */
export function nestedCountPainter(theme: Theme, color: "success" | "error" | "warning"): (text: string) => string {
	return perPalette(theme, `nested-count:${color}`, () => {
		const rgb = themeColorRgb(theme, color);
		return rgb ? rgbPainter(theme, interpolateRgb(rgb, { r: 0, g: 0, b: 0 }, 0.20))
			: (text: string) => theme.fg(color, text);
	});
}

/** Paint frame rails, connectors, separators, or running status in the quiet chrome tone. */
export function paintChrome(theme: Theme, text: string): string {
	return chromePainter(theme)(text);
}

export type ColorRamp = { from: Rgb; to: Rgb };

function ramp(theme: Theme, low: ContrastBand, high: ContrastBand): ColorRamp | undefined {
	const from = bandedRgb(theme, low);
	const to = bandedRgb(theme, high);
	return from && to ? { from, to } : undefined;
}

/**
 * A row's status dot; a running one pulses between the theme's endpoints as frames advance.
 * Every running row repaints its dot on every frame, so the pulse is painted once per palette.
 */
export function paintIndicator(theme: Theme, status: RowStatus, frame: number, glyph = indicatorGlyph(status)): string {
	if (status !== "running") return theme.fg(indicatorTone(status), glyph);
	const pulse = runningPulse(theme, glyph);
	return pulse[((frame % pulse.length) + pulse.length) % pulse.length]!;
}

/** Every step of the running dot's pulse, painted once per palette and glyph. */
function runningPulse(theme: Theme, glyph: string): readonly string[] {
	return perPalette(theme, `running-pulse:${glyph}`, () => {
		const pulse = ramp(theme, PULSE_LOW, PULSE_HIGH);
		return Array.from({ length: RUNNING_INDICATOR_FRAME_COUNT }, (_, step) => {
			return pulse
				? colorizeRgb(theme, interpolateRgb(pulse.from, pulse.to, indicatorStrength("running", step)), glyph)
				: theme.fg(indicatorTone("running", step), glyph);
		});
	});
}

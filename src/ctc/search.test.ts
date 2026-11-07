import { describe, expect, test } from "bun:test";
import {
	chapterSpans,
	DEFAULT_BOUNDARY_SEARCH_OPTIONS,
	locateChapters,
	type SearchDecode,
	trackFrame,
} from "./search";
import type { ConditionedText } from "./text";

/** Deterministic pseudo-random tokens so every 6-gram is unique. */
function randomTokens(count: number, seed: number): number[] {
	let state = seed;
	return Array.from({ length: count }, () => {
		state = (state * 1_103_515_245 + 12_345) % 2 ** 31;
		return state % 400;
	});
}

function textOf(chapters: number[][]): { text: ConditionedText; spans: ReturnType<typeof chapterSpans> } {
	const tokens = chapters.flat();
	const sentence = chapters.flatMap((chapter, index) => chapter.map(() => index));
	const text = {
		tokens: Int32Array.from(tokens),
		sentence: Int32Array.from(sentence),
	} as ConditionedText;
	return { text, spans: chapterSpans(text, (index) => `chapter-${index}`) };
}

/** Narrates chapters in the given order at 7 frames per token. */
function narrate(chapters: number[][], order: number[], options: { gapFrames?: number; noise?: number } = {}) {
	const tokens: number[] = [];
	const frames: number[] = [];
	let frame = 500;
	const startFrames = new Map<number, number>();
	for (const chapter of order) {
		startFrames.set(chapter, frame);
		for (const [position, token] of (chapters[chapter] ?? []).entries()) {
			// Drop and garble some tokens, like a greedy decode does.
			if (options.noise && position % options.noise === 3) {
				frame += 7;
				continue;
			}
			tokens.push(options.noise && position % options.noise === 5 ? 399 - token : token);
			frames.push(frame);
			frame += 7;
		}
		frame += options.gapFrames ?? 300;
	}
	const decode: SearchDecode = {
		tokens: Int32Array.from(tokens),
		frames: Int32Array.from(frames),
		trackStartFrames: [0, frame + 500],
	};
	return { decode, startFrames };
}

describe("locateChapters", () => {
	test("finds chapters narrated in a different order, with a noisy decode", () => {
		const chapters = [randomTokens(600, 1), randomTokens(800, 2), randomTokens(500, 3)];
		const { text, spans } = textOf(chapters);
		// Two errors every 13 tokens (about 15 %): one dropped, one misheard.
		const { decode, startFrames } = narrate(chapters, [2, 0, 1], { noise: 13 });
		const locations = locateChapters(text, spans, decode);
		for (const location of locations) {
			expect(location.status).toBe("found");
			// The window contains the narration and stays within its neighbours.
			const expected = startFrames.get(location.chapter) ?? 0;
			expect(location.startFrame ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(expected);
			expect(expected - (location.startFrame ?? 0)).toBeLessThanOrEqual(
				DEFAULT_BOUNDARY_SEARCH_OPTIONS.edgeSearchFrames + 30,
			);
			expect(location.coverage).toBeGreaterThan(0.95);
			const anchors = location.anchors;
			for (let i = 1; i < anchors.length; i += 1) {
				expect((anchors[i]?.token ?? 0) > (anchors[i - 1]?.token ?? 0)).toBe(true);
				expect((anchors[i]?.frame ?? 0) > (anchors[i - 1]?.frame ?? 0)).toBe(true);
			}
		}
		// Windows never reach past the neighbouring chapters' anchors.
		const byStart = [...locations].sort((a, b) => (a.startFrame ?? 0) - (b.startFrame ?? 0));
		for (let i = 1; i < byStart.length; i += 1) {
			const previousLast = byStart[i - 1]?.anchors.at(-1)?.frame ?? 0;
			expect(byStart[i]?.startFrame ?? 0).toBeGreaterThan(previousLast);
		}
	});

	test("reports chapters that are not narrated", () => {
		const chapters = [randomTokens(400, 4), randomTokens(400, 5), randomTokens(400, 6)];
		const { text, spans } = textOf(chapters);
		const { decode } = narrate(chapters, [0, 2]);
		const locations = locateChapters(text, spans, decode);
		expect(locations.map((location) => location.status)).toEqual(["found", "not-found", "found"]);
		expect(locations[1]?.anchors).toEqual([]);
	});

	test("ignores a stray match far from the narration", () => {
		const chapters = [randomTokens(600, 7)];
		const { text, spans } = textOf(chapters);
		const { decode } = narrate(chapters, [0]);
		// Move one decoded 6-gram an hour later; it must not stretch the chain.
		const frames = Int32Array.from(decode.frames);
		for (let i = 300; i < 306; i += 1) frames[i] = (frames[i] ?? 0) + 180_000;
		const located = locateChapters(text, spans, { ...decode, frames, trackStartFrames: [0, 400_000] });
		expect(located[0]?.status).toBe("found");
		expect(located[0]?.anchors.every((anchor) => anchor.frame < 100_000)).toBe(true);
	});
});

describe("trackFrame", () => {
	test("maps global frames to tracks", () => {
		const decode = { trackStartFrames: [0, 1_000, 2_500, 4_000] };
		expect(trackFrame(decode, 0)).toEqual({ track: 0, frame: 0 });
		expect(trackFrame(decode, 999)).toEqual({ track: 0, frame: 999 });
		expect(trackFrame(decode, 1_000)).toEqual({ track: 1, frame: 0 });
		expect(trackFrame(decode, 3_000)).toEqual({ track: 2, frame: 500 });
	});
});

import { expect, test } from "bun:test";
import { balancedGroups, freeAudioWindows, matchingChapter, supportedRecovery } from "./recovery";
import { type CtcAlignedCue, snapBoundaryTokens } from "./align";
import { STAR } from "./text";

function rows(count: number): CtcAlignedCue[] {
	return Array.from({length: count}, (_, i) => ({
		cue: { id: String(i), text: {kind: "text-quote", sectionRef: "a", exact: "本文中"}, audioFileIndex: 0, startMs: i*1000, endMs: (i+1)*1000 },
		evidence: {kind: "direct"}, text: "本文中", words: [],
	}));
}

test("short or one-sided evidence cannot recover a section", () => {
	expect(supportedRecovery(rows(23), () => true)).toHaveLength(0);
	expect(supportedRecovery(rows(24), row => Number(row.cue.id)%8 < 4)).toHaveLength(0);
});

test("only supported blocks survive the section gate", () => {
	const cues = rows(80);
	expect(supportedRecovery(cues, row => Number(row.cue.id) >= 8)).toEqual(cues.slice(8));
	expect(supportedRecovery(cues, row => Number(row.cue.id) >= 16)).toHaveLength(0);
});

test("chapter recovery requires a unique matching title in both sources", () => {
	const headings = new Map([["s", "秋風のこころよさに"]]);
	const mark = { index: 0, startMs: 1000, endMs: 9000, title: "秋風の こころよさに" };
	expect(matchingChapter("s", headings, [mark])).toBe(mark);
	expect(matchingChapter("s", headings, [mark,mark])).toBeUndefined();
	expect(matchingChapter("s", headings, [{...mark,title:"別のタイトル"}])).toBeUndefined();
	headings.set("other", mark.title);
	expect(matchingChapter("s", headings, [mark])).toBeUndefined();
});

test("balancedGroups keeps every group above the 24-sentence evidence threshold", () => {
	expect(balancedGroups(Array.from({ length: 23 }))).toEqual([]);
	for (const n of [24, 32, 50, 143, 155, 306, 750]) {
		const groups = balancedGroups(Array.from({ length: n }, (_, i) => i), 32);
		expect(groups.reduce((s, g) => s + g.length, 0)).toBe(n);
		for (const g of groups) expect(g.length).toBeGreaterThanOrEqual(24);
	}
});

test("freeAudioWindows skips covered chapters and falls back to overlapping free gaps", () => {
	const chapters = [
		{ index: 0, startMs: 0, endMs: 1_000_000, title: "ch0" },
		{ index: 1, startMs: 1_000_000, endMs: 2_000_000, title: "ch1" },
	];
	const wins = freeAudioWindows(2_000_000, [{ startMs: 0, endMs: 950_000 }], chapters);
	expect(wins).toEqual([{ startMs: 940_000, endMs: 2_000_000 }]);

	const noChapWins = freeAudioWindows(4_000_000, [{ startMs: 0, endMs: 500_000 }], []);
	expect(noChapWins.length).toBe(3);
	expect(noChapWins[0]!.startMs).toBe(500_000);
	expect(noChapWins.at(-1)!.endMs).toBe(4_000_000);
});

test("snapBoundaryTokens pulls leading/trailing tokens across long silence next to real speech", () => {
	// Leading STAR token 100 frames before real tokens
	const tokens = Int32Array.from([STAR, 1, 2, 3]);
	const first = Int32Array.from([10, 120, 125, 130]);
	const last = Int32Array.from([11, 122, 127, 132]);
	const score = Float32Array.from([-3, -0.5, -0.4, -0.3]);
	snapBoundaryTokens(tokens, { start: 0, end: 4 }, first, last, score);
	expect(first[0]).toBe(115);
	expect(first[1]).toBe(120);

	// Leading rare non-STAR token in silence (< -6.0) > 1.6 s (80 frames) before real speech
	const tokens2 = Int32Array.from([7, 1, 2]);
	const first2 = Int32Array.from([10, 120, 125]);
	const last2 = Int32Array.from([11, 122, 127]);
	const score2 = Float32Array.from([-8.5, -0.5, -0.4]);
	snapBoundaryTokens(tokens2, { start: 0, end: 3 }, first2, last2, score2);
	expect(first2[0]).toBe(115);

	// Normal short pause (< 25 frames) stays untouched
	const tokens3 = Int32Array.from([STAR, 1, 2]);
	const first3 = Int32Array.from([100, 110, 115]);
	const last3 = Int32Array.from([101, 112, 117]);
	const score3 = Float32Array.from([-3, -0.5, -0.4]);
	snapBoundaryTokens(tokens3, { start: 0, end: 3 }, first3, last3, score3);
	expect(first3[0]).toBe(100);

	// Genuinely spoken leading kanji/number (-5.2) across an intentional pause (> 2 s) stays untouched
	const tokens4 = Int32Array.from([5, 1, 2]);
	const first4 = Int32Array.from([10, 130, 135]);
	const last4 = Int32Array.from([14, 132, 137]);
	const score4 = Float32Array.from([-5.2, -0.5, -0.4]);
	snapBoundaryTokens(tokens4, { start: 0, end: 3 }, first4, last4, score4);
	expect(first4[0]).toBe(10);
});

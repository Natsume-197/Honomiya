import { describe, expect, test } from "bun:test";
import { padCueEnds, tileWords } from "../ctc/align";
import {
	parseAnyHonomiyaManifest,
	parseHonomiyaManifest,
	parseHonomiyaManifestV2,
} from "./manifest";

const SHA = "a".repeat(64);

function manifest(words: unknown[]) {
	return {
		schema: "honomiya.read-listen.v2",
		createdAt: "2026-11-06T00:00:00.000Z",
		generator: { name: "honomiya", version: "test" },
		granularity: "word",
		sources: { ebook: { sha256: SHA }, audioFiles: [{ index: 0, sha256: SHA }] },
		cues: [
			{
				id: "s-1-1-1",
				text: { kind: "text-quote", sectionRef: "c1", exact: "吾輩は猫である。" },
				audioFileIndex: 0,
				startMs: 1_000,
				endMs: 3_000,
				words,
			},
		],
	};
}

describe("read-listen.v2 manifests", () => {
	test("accepts ordered words inside their cue", () => {
		const parsed = parseHonomiyaManifestV2(
			manifest([
				{ start: 0, end: 2, text: "吾輩", startMs: 1_000, endMs: 1_600 },
				{ start: 2, end: 3, text: "は", startMs: 1_600, endMs: 1_900 },
				{ start: 3, end: 4, text: "猫", startMs: 1_900, endMs: 3_000 },
			]),
		);
		expect(parsed.cues[0]?.words).toHaveLength(3);
		expect(parseAnyHonomiyaManifest(manifest([])).schema).toBe("honomiya.read-listen.v2");
	});

	test("rejects words outside the cue or out of order", () => {
		expect(() =>
			parseHonomiyaManifestV2(manifest([{ start: 0, end: 2, text: "吾輩", startMs: 500, endMs: 1_600 }])),
		).toThrow(/inside their cue/);
		expect(() =>
			parseHonomiyaManifestV2(
				manifest([
					{ start: 2, end: 3, text: "は", startMs: 1_600, endMs: 1_900 },
					{ start: 0, end: 2, text: "吾輩", startMs: 1_900, endMs: 2_000 },
				]),
			),
		).toThrow(/ordered/);
	});

	test("keeps the v1 parser strict", () => {
		expect(() => parseHonomiyaManifest(manifest([]))).toThrow();
	});
});

describe("tileWords", () => {
	test("lays words end to end over the cue and merges words without room", () => {
		const words = tileWords(
			[
				{ start: 0, end: 2, startMs: 900 },
				{ start: 2, end: 3, startMs: 1_500 },
				{ start: 3, end: 4, startMs: 1_500 },
				{ start: 4, end: 6, startMs: 3_500 },
			],
			1_000,
			3_000,
			"吾輩は猫である。",
		);
		expect(words).toEqual([
			{ start: 0, end: 2, text: "吾輩", startMs: 1_000, endMs: 1_500 },
			{ start: 2, end: 3, text: "は", startMs: 1_500, endMs: 1_501 },
			{ start: 3, end: 6, text: "猫であ", startMs: 1_501, endMs: 3_000 },
		]);
	});
});

describe("padCueEnds", () => {
	const cue = (id: string, audioFileIndex: number, startMs: number, endMs: number, wordEnd?: number) => ({
		cue: { id, text: { kind: "fragment" as const, sectionRef: "c", fragmentId: id }, audioFileIndex, startMs, endMs },
		evidence: { kind: "direct" as const },
		text: id,
		words: wordEnd === undefined ? [] : [{ start: 0, end: 1, text: id, startMs, endMs: wordEnd }],
	});

	test("extends into silence without reaching the next cue or the end of the file", () => {
		const cues = [
			cue("a", 0, 0, 1_000, 1_000),
			cue("b", 0, 1_200, 2_000),
			cue("c", 0, 5_000, 6_000),
			cue("d", 0, 9_800, 9_900),
			cue("e", 1, 0, 500),
		];
		padCueEnds(cues, 400, (track) => (track === 0 ? 10_000 : 600));
		expect(cues.map(({ cue: c }) => c.endMs)).toEqual([1_200, 2_400, 6_400, 10_000, 600]);
		expect(cues[0]?.words[0]?.endMs).toBe(1_200);
	});
});

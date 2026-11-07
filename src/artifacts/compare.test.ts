import { describe, expect, test } from "bun:test";
import { compareManifests } from "./compare";
import type { HonomiyaManifestV1, ReadListenCue } from "./manifest";

const EBOOK = "a".repeat(64);
const AUDIO = "b".repeat(64);

function cue(
	id: string,
	startMs: number,
	endMs: number,
	audioFileIndex = 0,
): ReadListenCue {
	return {
		id,
		text: { kind: "fragment", sectionRef: "s1", fragmentId: id },
		audioFileIndex,
		startMs,
		endMs,
	};
}

function manifest(cues: ReadListenCue[], ebook = EBOOK): HonomiyaManifestV1 {
	return {
		schema: "honomiya.read-listen.v1",
		createdAt: "2026-11-06T00:00:00.000Z",
		generator: { name: "honomiya", version: "test" },
		granularity: "sentence",
		sources: {
			ebook: { sha256: ebook },
			audioFiles: [
				{ index: 0, sha256: AUDIO },
				{ index: 1, sha256: AUDIO },
			],
		},
		cues,
	};
}

describe("compareManifests", () => {
	test("reports a perfect match", () => {
		const reference = manifest([cue("a", 0, 1_000), cue("b", 1_000, 2_000)]);
		const result = compareManifests(reference, reference);
		expect(result.recall).toBe(1);
		expect(result.startErrorMs?.max).toBe(0);
		expect(result.meanIou).toBe(1);
		expect(result.withinTolerance.every(({ share }) => share === 1)).toBe(
			true,
		);
		expect(result.sameEbook).toBe(true);
		expect(result.sameAudio).toBe(true);
	});

	test("measures timing error, missing, extra and misplaced cues", () => {
		const reference = manifest([
			cue("a", 0, 1_000),
			cue("b", 1_000, 2_000),
			cue("c", 2_000, 3_000),
			cue("d", 3_000, 4_000),
		]);
		const candidate = manifest(
			[
				cue("a", 200, 1_000),
				cue("b", 1_000, 2_600),
				cue("d", 3_000, 4_000, 1),
				cue("z", 5_000, 6_000),
			],
			"c".repeat(64),
		);
		const result = compareManifests(candidate, reference, [250, 1_000]);
		expect(result.sameEbook).toBe(false);
		expect(result.matchedCues).toBe(2);
		expect(result.missingCues).toBe(1);
		expect(result.wrongAudioFileCues).toBe(1);
		expect(result.extraCues).toBe(1);
		expect(result.recall).toBe(0.5);
		expect(result.startErrorMs).toMatchObject({ p50: 0, max: 200 });
		expect(result.endErrorMs).toMatchObject({ p50: 0, max: 600 });
		expect(result.withinTolerance).toEqual([
			{ toleranceMs: 250, share: 0.25 },
			{ toleranceMs: 1_000, share: 0.5 },
		]);
		expect(result.meanIou).toBeCloseTo((0.8 + 1 / 1.6) / 2);
	});

	test("handles an empty candidate", () => {
		const result = compareManifests(
			manifest([]),
			manifest([cue("a", 0, 1_000)]),
		);
		expect(result.recall).toBe(0);
		expect(result.startErrorMs).toBeNull();
		expect(result.meanIou).toBeNull();
	});
});

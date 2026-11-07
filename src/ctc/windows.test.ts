import { describe, expect, test } from "bun:test";
import { planInferenceWindows, planTechnicalChunks } from "./windows";

describe("planTechnicalChunks", () => {
	test("covers every frame once with context on both sides", () => {
		const chunks = planTechnicalChunks(1_000, 300, 10);
		expect(chunks.map((c) => [c.ownedStartFrame, c.ownedEndFrame])).toEqual([
			[0, 250],
			[250, 500],
			[500, 750],
			[750, 1_000],
		]);
		expect(chunks[0]).toMatchObject({ decodeStartFrame: 0, decodeEndFrame: 260 });
		expect(chunks[1]).toMatchObject({ decodeStartFrame: 240, decodeEndFrame: 510 });
		expect(chunks.at(-1)).toMatchObject({ decodeEndFrame: 1_000 });
	});

	test("returns nothing for empty audio", () => {
		expect(planTechnicalChunks(0, 300, 10)).toEqual([]);
	});
});

describe("planInferenceWindows", () => {
	const base = { samplesPerFrame: 4, windowFrames: 20, contextFrames: 3 };

	test("owns every frame exactly once and keeps windows on the frame grid", () => {
		const windows = planInferenceWindows({
			...base,
			spanStartFrame: 90,
			spanSamples: 70 * 4,
			ownedStartFrame: 93,
			ownedEndFrame: 157,
		});
		const owned = windows.flatMap((w) =>
			Array.from(
				{ length: w.ownedEndFrame - w.ownedStartFrame },
				(_, i) => w.ownedStartFrame + i,
			),
		);
		expect(owned).toEqual(Array.from({ length: 64 }, (_, i) => 93 + i));
		for (const window of windows) {
			expect(window.startSample % 4).toBe(0);
			const startFrame = 90 + window.startSample / 4;
			const endFrame = 90 + window.endSample / 4;
			expect(endFrame - startFrame).toBeLessThanOrEqual(20);
			expect(window.ownedStartFrame).toBeGreaterThanOrEqual(startFrame);
			expect(window.ownedEndFrame).toBeLessThanOrEqual(endFrame);
		}
		// Interior windows see context before their owned frames.
		const second = windows[1];
		expect(second && 90 + second.startSample / 4).toBe(
			(second?.ownedStartFrame ?? 0) - 3,
		);
	});

	test("rejects owned frames outside the span", () => {
		expect(() =>
			planInferenceWindows({
				...base,
				spanStartFrame: 0,
				spanSamples: 40,
				ownedStartFrame: 0,
				ownedEndFrame: 11,
			}),
		).toThrow(/inside the decoded span/);
	});
});

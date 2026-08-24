import { describe, expect, test } from "bun:test";
import { HONOMIYA_MANIFEST_SCHEMA, parseHonomiyaManifest } from "./manifest";

function validManifest() {
	return {
		schema: HONOMIYA_MANIFEST_SCHEMA,
		createdAt: "2026-08-08T15:00:00.000Z",
		generator: { name: "honomiya", version: "0.2.0" },
		transcription: { origin: "honomiya" as const },
		granularity: "sentence",
		sources: {
			ebook: { sha256: "a".repeat(64), filename: "book.epub" },
			audioFiles: [
				{
					index: 0,
					sha256: "b".repeat(64),
					filename: "chapter-01.mp3",
					durationMs: 10_000,
				},
			],
		},
		cues: [
			{
				id: "chapter-1-sentence-1",
				text: {
					kind: "fragment",
					sectionRef: "OEBPS/chapter-01.xhtml",
					fragmentId: "sentence-1",
				},
				audioFileIndex: 0,
				startMs: 1_000,
				endMs: 2_500,
			},
			{
				id: "chapter-1-sentence-2",
				text: {
					kind: "text-quote",
					sectionRef: "OEBPS/chapter-01.xhtml",
					exact: "The second sentence.",
					prefix: "sentence. ",
				},
				audioFileIndex: 0,
				startMs: 2_500,
				endMs: 4_000,
			},
		],
	};
}

function cueAt(input: ReturnType<typeof validManifest>, index: number) {
	const cue = input.cues[index];
	if (!cue) throw new Error(`Missing cue fixture at index ${index}`);
	return cue;
}

describe("Honomiya manifest v1", () => {
	test("accepts an ordered sentence-level manifest", () => {
		const manifest = parseHonomiyaManifest(validManifest());

		expect(manifest.schema).toBe(HONOMIYA_MANIFEST_SCHEMA);
		expect(manifest.transcription?.origin).toBe("honomiya");
		expect(manifest.cues).toHaveLength(2);
	});

	test("keeps manifests created before embedded provenance compatible", () => {
		const input = validManifest();
		const { transcription: _transcription, ...legacyManifest } = input;

		const manifest = parseHonomiyaManifest(legacyManifest);

		expect(manifest.transcription).toBeUndefined();
	});

	test("rejects an unknown transcription origin", () => {
		const input = validManifest() as Record<string, unknown>;
		input.transcription = { origin: "guessed" };

		expect(() => parseHonomiyaManifest(input)).toThrow();
	});

	test("rejects cues that reference a missing audio file", () => {
		const input = validManifest();
		cueAt(input, 0).audioFileIndex = 9;

		expect(() => parseHonomiyaManifest(input)).toThrow(
			"Unknown audio file index 9",
		);
	});

	test("rejects overlapping cues in the same audio file", () => {
		const input = validManifest();
		cueAt(input, 1).startMs = 2_000;

		expect(() => parseHonomiyaManifest(input)).toThrow(
			"Cues in the same audio file must not overlap",
		);
	});

	test("rejects cues beyond a known track duration", () => {
		const input = validManifest();
		cueAt(input, 1).endMs = 12_000;

		expect(() => parseHonomiyaManifest(input)).toThrow(
			"Cue ends after audio file 0",
		);
	});
});

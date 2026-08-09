import { describe, expect, test } from "bun:test";
import {
	HONOMIYA_TRANSCRIPT_SCHEMA,
	parseHonomiyaTranscript,
} from "./transcript";

function validTranscript() {
	return {
		schema: HONOMIYA_TRANSCRIPT_SCHEMA,
		engine: {
			provider: "modal",
			model: "large-v3",
			revision: "modal-v1",
			timestampBackend: "faster-whisper" as const,
		},
		source: { sha256: "a".repeat(64), filename: "track.mp3" },
		language: "es",
		languageProbability: 0.99,
		offsetMs: 0,
		durationMs: 2_000,
		speechTimeline: [
			{ startMs: 80, endMs: 600 },
			{ startMs: 900, endMs: 1_700 },
		],
		segments: [
			{
				id: 0,
				startMs: 100,
				endMs: 1_500,
				text: "Hola mundo.",
				words: [
					{
						startMs: 100,
						endMs: 500,
						text: "Hola",
						probability: 0.98,
					},
				],
			},
		],
	};
}

describe("Honomiya transcript v1", () => {
	test("parses a normalized transcript", () => {
		expect(parseHonomiyaTranscript(validTranscript()).language).toBe("es");
		expect(parseHonomiyaTranscript(validTranscript()).engine.revision).toBe(
			"modal-v1",
		);
	});

	test("rejects overlapping or out-of-range speech regions", () => {
		const overlapping = validTranscript();
		overlapping.speechTimeline[1] = { startMs: 500, endMs: 1_700 };
		expect(() => parseHonomiyaTranscript(overlapping)).toThrow(
			"Speech regions must be ordered and must not overlap",
		);

		const outOfRange = validTranscript();
		outOfRange.speechTimeline[1] = { startMs: 900, endMs: 2_100 };
		expect(() => parseHonomiyaTranscript(outOfRange)).toThrow(
			"Speech region ends after the audio duration",
		);
	});

	test("rejects a word outside its segment", () => {
		const input = validTranscript();
		const segment = input.segments[0];
		const word = segment?.words[0];
		if (!word) throw new Error("Test fixture must contain a word");
		word.startMs = 50;

		expect(() => parseHonomiyaTranscript(input)).toThrow(
			"Word must be contained by its segment",
		);
	});

	test("rejects overlapping segments", () => {
		const input = validTranscript();
		input.segments.push({
			id: 1,
			startMs: 1_400,
			endMs: 1_800,
			text: "Otra frase.",
			words: [],
		});

		expect(() => parseHonomiyaTranscript(input)).toThrow(
			"Segments must be ordered and must not overlap",
		);
	});

	test("validates chunk timestamps against their track offset", () => {
		const input = validTranscript();
		const segment = input.segments[0];
		const word = segment?.words[0];
		if (!segment || !word) throw new Error("Test fixture must contain a word");
		input.offsetMs = 10_000;
		input.speechTimeline = input.speechTimeline.map((region) => ({
			startMs: region.startMs + 10_000,
			endMs: region.endMs + 10_000,
		}));
		segment.startMs = 10_100;
		segment.endMs = 11_500;
		word.startMs = 10_100;
		word.endMs = 10_500;

		expect(parseHonomiyaTranscript(input).offsetMs).toBe(10_000);
	});
});

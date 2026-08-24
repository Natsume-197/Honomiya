import { describe, expect, test } from "bun:test";
import type { TranscriptionProvider } from "../transcription/provider";
import {
	HONOMIYA_TRANSCRIPT_SCHEMA,
	parseHonomiyaTranscript,
} from "../transcription/transcript";
import {
	planTimedTextVerificationSamples,
	timedTextSampleScore,
	verifyTimedTextAgainstAudio,
} from "./verify";

function transcript(texts: string[]) {
	return parseHonomiyaTranscript({
		schema: HONOMIYA_TRANSCRIPT_SCHEMA,
		engine: { provider: "timed-text", model: "srt" },
		language: "en",
		offsetMs: 0,
		durationMs: texts.length * 5_000,
		segments: texts.map((text, index) => ({
			id: index,
			startMs: index * 5_000,
			endMs: (index + 1) * 5_000,
			text,
			words: [],
		})),
	});
}

describe("timed-text audio verification", () => {
	test("samples the beginning, middle and end of a transcript", () => {
		const samples = planTimedTextVerificationSamples(
			transcript(["one", "two", "three", "four", "five", "six"]),
			3,
		);
		expect(samples).toHaveLength(3);
		expect(samples.map((sample) => sample.expectedText)).toEqual([
			"one two three",
			"three four five",
			"five six",
		]);
	});

	test("scores reordered recognition more generously than unrelated text", () => {
		expect(
			timedTextSampleScore("alpha beta gamma", "alpha gamma beta", "en"),
		).toBeGreaterThan(0.9);
		expect(
			timedTextSampleScore("alpha beta gamma", "unrelated words", "en"),
		).toBe(0);
	});

	test("reports low confidence when acoustic samples do not match", async () => {
		const provider: TranscriptionProvider = {
			name: "local",
			revision: "fixture-v1",
			transcribe: async () => transcript(["completely unrelated"]),
		};
		const removed: string[] = [];
		const report = await verifyTimedTextAgainstAudio(
			{
				transcript: transcript(["alpha beta gamma"]),
				audioPath: "/audio/book.m4b",
				provider,
				samples: 1,
			},
			{
				makeTemporaryDirectory: async () => "/tmp/verification-fixture",
				removeTemporaryDirectory: async (path) => {
					removed.push(path);
				},
				extract: async () => undefined,
			},
		);

		expect(report.status).toBe("failed");
		expect(report.confidence).toBe("low");
		expect(removed).toEqual(["/tmp/verification-fixture"]);
	});
});

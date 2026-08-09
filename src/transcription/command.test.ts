import { describe, expect, test } from "bun:test";
import { executeTranscribeCommand } from "./command";
import { HONOMIYA_TRANSCRIPT_SCHEMA } from "./transcript";

describe("transcribe command", () => {
	test("transcribes one track and writes the normalized artifact", async () => {
		let request:
			| {
					audioPath: string;
					language?: string;
					cacheDir: string;
					parallelChunks?: number;
			  }
			| undefined;
		let written: { path: string; value: unknown } | undefined;
		let timestampBackend: string | undefined;
		const transcript = {
			schema: HONOMIYA_TRANSCRIPT_SCHEMA,
			engine: {
				provider: "modal",
				model: "large-v3",
				revision: "fixture-v1",
			},
			language: "es",
			offsetMs: 0,
			durationMs: 1_000,
			segments: [],
		};
		const result = await executeTranscribeCommand(
			{
				audioPath: "track.mp3",
				outputPath: "track.json",
				provider: "modal",
				language: "es",
				parallelChunks: 2,
			},
			{
				createProvider: (_name, backend) => {
					timestampBackend = backend;
					return {
						name: "modal",
						revision: "fixture-v1",
						transcribe: async () => transcript,
					};
				},
				hashFile: async () => "a".repeat(64),
				transcribeAudio: async (value) => {
					request = {
						audioPath: value.audioPath,
						language: value.language,
						cacheDir: value.cacheDir,
						parallelChunks: value.parallelChunks,
					};
					return {
						transcript: {
							...transcript,
							source: {
								sha256: "a".repeat(64),
								filename: "track.mp3",
							},
						},
						probe: { durationMs: 1_000, chapters: [] },
						chunks: 1,
						cacheHits: 0,
						resumedJobs: 0,
						retries: 0,
					};
				},
				writeJson: async (path, value) => {
					written = { path, value };
				},
			},
		);

		expect(request).toEqual({
			audioPath: "track.mp3",
			language: "es",
			cacheDir: "track.json.cache",
			parallelChunks: 2,
		});
		expect(written).toEqual({
			path: "track.json",
			value: {
				...transcript,
				source: { sha256: "a".repeat(64), filename: "track.mp3" },
			},
		});
		expect(result.provider.revision).toBe("fixture-v1");
		expect(timestampBackend).toBe("stable-ts");
		expect(result.chunks).toBe(1);
	});
});

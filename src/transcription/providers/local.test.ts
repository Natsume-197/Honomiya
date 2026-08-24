import { describe, expect, test } from "bun:test";
import { HONOMIYA_TRANSCRIPT_SCHEMA } from "../transcript";
import type { LocalTranscriptionInput } from "./local";
import {
	LocalTranscriptionProvider,
	resolveLocalProviderConfig,
} from "./local";

function transcriptResult() {
	return {
		schema: HONOMIYA_TRANSCRIPT_SCHEMA,
		engine: { provider: "local", model: "large-v3" },
		language: "es",
		offsetMs: 2_000,
		durationMs: 1_000,
		segments: [],
	};
}

describe("local transcription provider", () => {
	test("uses portable runtime defaults", () => {
		const config = resolveLocalProviderConfig(
			{},
			{ workerPath: "/project/local-worker.py" },
		);
		expect(config).toEqual({
			python: "python3",
			workerPath: "/project/local-worker.py",
			model: "large-v3",
			device: "auto",
			computeType: "auto",
			downloadRoot: undefined,
		});
	});

	test("reads local inference overrides from the environment", () => {
		const config = resolveLocalProviderConfig(
			{
				HONOMIYA_LOCAL_PYTHON: "/project/.venv/bin/python",
				HONOMIYA_LOCAL_MODEL: "small",
				HONOMIYA_LOCAL_DEVICE: "cpu",
				HONOMIYA_LOCAL_COMPUTE_TYPE: "int8",
				HONOMIYA_LOCAL_MODEL_CACHE: "/models",
			},
			{ workerPath: "/project/local-worker.py" },
		);
		expect(config).toEqual({
			python: "/project/.venv/bin/python",
			workerPath: "/project/local-worker.py",
			model: "small",
			device: "cpu",
			computeType: "int8",
			downloadRoot: "/models",
		});
	});

	test("passes local settings to the worker and normalizes provenance", async () => {
		let received: LocalTranscriptionInput | undefined;
		const provider = new LocalTranscriptionProvider({
			timestampBackend: "stable-ts",
			config: {
				python: "/project/.venv/bin/python",
				workerPath: "/project/local-worker.py",
				model: "small",
				device: "cpu",
				computeType: "int8",
			},
			runWorker: async (input) => {
				received = input;
				return transcriptResult();
			},
		});

		const transcript = await provider.transcribe({
			audioPath: "/books/track.mp3",
			language: "es",
			offsetMs: 2_000,
		});

		expect(received).toMatchObject({
			audioPath: "/books/track.mp3",
			language: "es",
			offsetMs: 2_000,
			timestampBackend: "stable-ts",
		});
		expect(transcript.engine).toEqual({
			provider: "local",
			model: "small",
			revision: provider.revision,
			timestampBackend: "stable-ts",
		});
	});

	test("rejects malformed worker output", async () => {
		const provider = new LocalTranscriptionProvider({
			runWorker: async () => ({}),
		});
		await expect(
			provider.transcribe({ audioPath: "track.mp3" }),
		).rejects.toThrow();
	});
});

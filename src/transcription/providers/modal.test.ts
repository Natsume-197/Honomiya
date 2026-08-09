import { describe, expect, test } from "bun:test";
import { HONOMIYA_TRANSCRIPT_SCHEMA } from "../transcript";
import type { ModalTranscriptionInput } from "./modal";
import {
	ModalTranscriptionProvider,
	resolveModalProviderConfig,
} from "./modal";

function transcriptResult() {
	return {
		schema: HONOMIYA_TRANSCRIPT_SCHEMA,
		engine: { provider: "modal", model: "large-v3" },
		language: "es",
		offsetMs: 0,
		durationMs: 1_000,
		segments: [],
	};
}

describe("Modal transcription provider", () => {
	test("uses stable deployment defaults", () => {
		expect(resolveModalProviderConfig({})).toEqual({
			appName: "honomiya-transcriber",
			className: "HonomiyaTranscriber",
			methodName: "transcribe",
			environment: undefined,
		});
	});

	test("reads deployment overrides from the environment", () => {
		expect(
			resolveModalProviderConfig({
				HONOMIYA_MODAL_APP: "my-app",
				HONOMIYA_MODAL_CLASS: "MyTranscriber",
				HONOMIYA_MODAL_METHOD: "run",
				HONOMIYA_MODAL_ENVIRONMENT: "staging",
			}),
		).toEqual({
			appName: "my-app",
			className: "MyTranscriber",
			methodName: "run",
			environment: "staging",
		});
	});

	test("sends bytes and metadata through the gateway", async () => {
		let received: ModalTranscriptionInput | undefined;
		let startedJob: { provider: "modal"; id: string } | undefined;
		const provider = new ModalTranscriptionProvider({
			readBytes: async () => new Uint8Array([1, 2, 3]),
			createGateway: () => ({
				transcribe: async (input, onStarted) => {
					received = input;
					await onStarted?.("fc-123");
					return transcriptResult();
				},
				resume: async () => transcriptResult(),
				cancel: async () => undefined,
			}),
		});

		const transcript = await provider.transcribe({
			audioPath: "/books/track-01.mp3",
			language: "es",
			onJobStarted: (job) => {
				startedJob = job;
			},
		});

		expect(received).toEqual({
			audioBytes: new Uint8Array([1, 2, 3]),
			filename: "track-01.mp3",
			language: "es",
			offsetMs: 0,
			timestampBackend: "faster-whisper",
		});
		expect(transcript.engine.provider).toBe("modal");
		expect(transcript.engine.revision).toBe(provider.revision);
		expect(startedJob).toEqual({ provider: "modal", id: "fc-123" });
	});

	test("uses an isolated revision and request for stable-ts", async () => {
		let received: ModalTranscriptionInput | undefined;
		const provider = new ModalTranscriptionProvider({
			timestampBackend: "stable-ts",
			readBytes: async () => new Uint8Array([1]),
			createGateway: () => ({
				transcribe: async (input) => {
					received = input;
					return transcriptResult();
				},
				resume: async () => transcriptResult(),
				cancel: async () => undefined,
			}),
		});

		await provider.transcribe({ audioPath: "track.mp3" });
		expect(received?.timestampBackend).toBe("stable-ts");
		expect(provider.revision).toContain("stable-ts");
	});

	test("rejects malformed remote output", async () => {
		const provider = new ModalTranscriptionProvider({
			readBytes: async () => new Uint8Array(),
			createGateway: () => ({
				transcribe: async () => ({}),
				resume: async () => ({}),
				cancel: async () => undefined,
			}),
		});

		await expect(
			provider.transcribe({ audioPath: "track.mp3" }),
		).rejects.toThrow();
	});

	test("reattaches and cancels calls through their persistent Modal id", async () => {
		let resumed = "";
		let cancelled = "";
		const provider = new ModalTranscriptionProvider({
			createGateway: () => ({
				transcribe: async () => transcriptResult(),
				resume: async (id) => {
					resumed = id;
					return transcriptResult();
				},
				cancel: async (id) => {
					cancelled = id;
				},
			}),
		});

		await provider.resume?.({ provider: "modal", id: "fc-resume" });
		await provider.cancel?.({ provider: "modal", id: "fc-cancel" });

		expect(resumed).toBe("fc-resume");
		expect(cancelled).toBe("fc-cancel");
	});
});

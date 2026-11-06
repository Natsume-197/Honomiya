import { describe, expect, test } from "bun:test";
import type { AcousticModel } from "./acoustic-model";
import { type EmitAudioDependencies, emitAudio, padFrames } from "./emit";
import { emissionScore } from "./emissions";
import type { InstalledCtcModel } from "./model-store";
import { CTC_MODELS } from "./models";

const SAMPLES_PER_FRAME = 320;
const CLASSES = 4;
const BLANK = 3;

const installed: InstalledCtcModel = {
	descriptor: {
		...CTC_MODELS["quartznet15x5-ja"],
		windowSeconds: 2,
		contextSeconds: 0.2,
	},
	directory: "/models",
	modelPath: "/models/model.onnx",
	vocabularyPath: "/models/vocab.txt",
};

/**
 * The fake model's best class for a frame encodes the frame's global index
 * (read back from the PCM sample value), so stitching errors are visible.
 */
function fakeModel(calls: number[]): AcousticModel {
	return {
		async run(samples) {
			const frames = Math.floor(samples.length / SAMPLES_PER_FRAME);
			calls.push(frames);
			const logProbabilities = new Float32Array(frames * CLASSES).fill(-9);
			for (let frame = 0; frame < frames; frame += 1) {
				const globalFrame = samples[frame * SAMPLES_PER_FRAME] ?? 0;
				logProbabilities[frame * CLASSES + (globalFrame % 3)] = -0.5;
				logProbabilities[frame * CLASSES + BLANK] = -1;
			}
			return { frames, classes: CLASSES, logProbabilities };
		},
		async close() {},
	};
}

function dependencies(cache: Map<string, Uint8Array>, calls: number[], decodes: number[]) {
	const deps: EmitAudioDependencies = {
		probe: async () => ({ durationMs: 30_000, chapters: [] }),
		async decode(_path, options) {
			decodes.push(options.startMs);
			const firstFrame = Math.round(options.startMs / 20);
			const frames = Math.round(options.durationMs / 20);
			const pcm = new Float32Array(frames * SAMPLES_PER_FRAME);
			for (let frame = 0; frame < frames; frame += 1) {
				pcm.fill(firstFrame + frame, frame * SAMPLES_PER_FRAME, (frame + 1) * SAMPLES_PER_FRAME);
			}
			return pcm;
		},
		openModel: async () => fakeModel(calls),
		readVocabulary: async () => "あ 0\nい 1\nう 2\n<blk> 3\n",
		readCache: async (path) => cache.get(path),
		writeCache: async (path, bytes) => {
			cache.set(path, bytes);
		},
	};
	return deps;
}

describe("padFrames", () => {
	test("repeats the last row for a small trailing shortfall only", () => {
		const output = { frames: 2, classes: 2, logProbabilities: Float32Array.from([1, 2, 3, 4]) };
		expect(Array.from(padFrames(output, 3).logProbabilities)).toEqual([1, 2, 3, 4, 3, 4]);
		expect(padFrames(output, 2)).toBe(output);
		expect(padFrames(output, 5)).toBe(output);
	});
});

describe("emitAudio", () => {
	test("stitches windows and chunks into one contiguous frame sequence", async () => {
		const cache = new Map<string, Uint8Array>();
		const calls: number[] = [];
		const decodes: number[] = [];
		const progress: string[] = [];
		const result = await emitAudio(
			{
				audioPath: "/audio/book.m4b",
				audioSha256: "b".repeat(64),
				model: installed,
				cacheDir: "/cache",
				topK: 1,
				chunkMinutes: 0.2,
				onProgress: (p) => progress.push(`${p.chunk}:${p.state}`),
			},
			dependencies(cache, calls, decodes),
		);
		const { emissions } = result;
		expect(emissions.header.frames).toBe(1_500);
		expect(emissions.header.startFrame).toBe(0);
		for (let frame = 0; frame < emissions.header.frames; frame += 1) {
			expect(emissions.classes[frame]).toBe(frame % 3);
		}
		expect(emissionScore(emissions, 10, BLANK)).toBeCloseTo(-1);
		expect(result.chunks).toBe(3);
		expect(result.cacheHits).toBe(0);
		expect(calls.every((frames) => frames <= 100)).toBe(true);
		expect(progress).toEqual([
			"1:starting",
			"1:completed",
			"2:starting",
			"2:completed",
			"3:starting",
			"3:completed",
		]);

		// A second run is served from the cache without opening the model.
		const secondCalls: number[] = [];
		const cached = await emitAudio(
			{
				audioPath: "/audio/book.m4b",
				audioSha256: "b".repeat(64),
				model: installed,
				cacheDir: "/cache",
				topK: 1,
				chunkMinutes: 0.2,
			},
			dependencies(cache, secondCalls, []),
		);
		expect(cached.cacheHits).toBe(3);
		expect(secondCalls).toEqual([]);
		expect(Array.from(cached.emissions.classes)).toEqual(Array.from(emissions.classes));
	});

	test("stops when cancelled", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(
			emitAudio(
				{
					audioPath: "/audio/book.m4b",
					audioSha256: "b".repeat(64),
					model: installed,
					cacheDir: "/cache",
					signal: controller.signal,
				},
				dependencies(new Map(), [], []),
			),
		).rejects.toMatchObject({ name: "AbortError" });
	});
});

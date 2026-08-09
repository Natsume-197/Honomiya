import { describe, expect, test } from "bun:test";
import { chunkExtension, parseFfprobeOutput, planAudioChunks } from "./chunks";

describe("audio chunk planning", () => {
	test("parses duration and embedded chapters from ffprobe", () => {
		expect(
			parseFfprobeOutput({
				format: { duration: "120.125" },
				chapters: [
					{
						start_time: "0.000",
						end_time: "30.500",
						tags: { title: " Introduction " },
					},
				],
			}),
		).toEqual({
			durationMs: 120_125,
			chapters: [
				{
					index: 0,
					startMs: 0,
					endMs: 30_500,
					title: "Introduction",
				},
			],
		});
	});

	test("uses chapter boundaries and balances chapters longer than the limit", () => {
		const chunks = planAudioChunks(
			{
				durationMs: 65_000,
				chapters: [
					{ index: 0, startMs: 0, endMs: 5_000 },
					{ index: 1, startMs: 5_000, endMs: 65_000 },
				],
			},
			30_000,
		);

		expect(chunks).toEqual([
			{
				index: 0,
				startMs: 0,
				endMs: 6_250,
				ownedStartMs: 0,
				ownedEndMs: 5_000,
				chapterIndexes: [0],
			},
			{
				index: 1,
				startMs: 3_750,
				endMs: 40_000,
				ownedStartMs: 5_000,
				ownedEndMs: 35_000,
				chapterIndexes: [1],
			},
			{
				index: 2,
				startMs: 30_000,
				endMs: 65_000,
				ownedStartMs: 35_000,
				ownedEndMs: 65_000,
				chapterIndexes: [1],
			},
		]);
	});

	test("splits a chapterless track into balanced ranges", () => {
		expect(
			planAudioChunks({ durationMs: 61_000, chapters: [] }, 30_000).map(
				({ ownedStartMs, ownedEndMs }) => ({
					startMs: ownedStartMs,
					endMs: ownedEndMs,
				}),
			),
		).toEqual([
			{ startMs: 0, endMs: 20_333 },
			{ startMs: 20_333, endMs: 40_666 },
			{ startMs: 40_666, endMs: 61_000 },
		]);
	});

	test("adds context on both sides while assigning every timestamp once", () => {
		const chunks = planAudioChunks(
			{ durationMs: 60_000, chapters: [] },
			30_000,
			4_000,
		);

		expect(chunks).toEqual([
			{
				index: 0,
				startMs: 0,
				endMs: 34_000,
				ownedStartMs: 0,
				ownedEndMs: 30_000,
				chapterIndexes: [],
			},
			{
				index: 1,
				startMs: 26_000,
				endMs: 60_000,
				ownedStartMs: 30_000,
				ownedEndMs: 60_000,
				chapterIndexes: [],
			},
		]);
	});

	test("does not create a residual chunk for container rounding noise", () => {
		const chunks = planAudioChunks(
			{ durationMs: 180_002, chapters: [] },
			60_000,
		);

		expect(chunks).toHaveLength(3);
		expect(chunks.at(-1)?.endMs).toBe(180_002);
	});

	test("chooses a container compatible with MPEG-4 audiobook audio", () => {
		expect(chunkExtension("book.m4b")).toBe(".m4a");
		expect(chunkExtension("track.mp3")).toBe(".mp3");
	});
});

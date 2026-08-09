import { describe, expect, test } from "bun:test";
import { renderSrt, srtOutputPath, writeSrtArtifacts } from "./srt";

describe("SubRip output", () => {
	test("renders aligned EPUB text with SubRip timestamps", () => {
		expect(
			renderSrt([
				{
					audioFileIndex: 0,
					startMs: 3_723_004,
					endMs: 3_725_120,
					text: "比企谷\n八幡。",
				},
			]),
		).toBe("1\n01:02:03,004 --> 01:02:05,120\n比企谷 八幡。\n");
	});

	test("places one SRT per original audio beside the alignment", async () => {
		const written: Array<{ path: string; value: string }> = [];
		const paths = await writeSrtArtifacts(
			"/books/book.honomiya.alignment.json",
			["/audio/part-1.m4b", "/audio/part-2.mp3"],
			[
				{ audioFileIndex: 0, startMs: 0, endMs: 1_000, text: "One." },
				{ audioFileIndex: 1, startMs: 0, endMs: 1_000, text: "Two." },
			],
			async (path, value) => {
				written.push({ path, value });
			},
		);

		expect(paths).toEqual([
			"/books/part-1.honomiya.srt",
			"/books/part-2.honomiya.srt",
		]);
		expect(written[1]?.value).toContain("Two.");
	});

	test("derives the filename without retaining the audio extension", () => {
		expect(srtOutputPath("/books/alignment.json", "/audio/story.m4b")).toBe(
			"/books/story.honomiya.srt",
		);
	});
});

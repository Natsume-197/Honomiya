import { describe, expect, test } from "bun:test";
import { parseSrt, srtToTranscript } from "./srt";

const SHA = "a".repeat(64);

describe("SRT timed-text adapter", () => {
	test("parses BOM, CRLF, multiline text, markup and practical timestamps", () => {
		const parsed = parseSrt(
			"\uFEFF1\r\n00:00:01,000 --> 00:00:02,500\r\n<i>Hello</i>\r\nworld &amp; friends\r\n\r\n2\r\n00:00:03.000 --> 00:00:04.000\r\n{\\an8}Again\r\n",
		);
		expect(parsed).toEqual({
			totalCues: 2,
			issues: [],
			cues: [
				{
					index: 1,
					startMs: 1_000,
					endMs: 2_500,
					text: "Hello world & friends",
				},
				{ index: 2, startMs: 3_000, endMs: 4_000, text: "Again" },
			],
		});
	});

	test("recovers consecutive cues when blank separators are missing", () => {
		const parsed = parseSrt(
			"10\n00:00:01,000 --> 00:00:02,000\nFirst\n11\n00:00:03,000 --> 00:00:04,000\nSecond\n",
		);

		expect(parsed.totalCues).toBe(2);
		expect(parsed.issues).toEqual([]);
		expect(parsed.cues).toEqual([
			{ index: 10, startMs: 1_000, endMs: 2_000, text: "First" },
			{ index: 11, startMs: 3_000, endMs: 4_000, text: "Second" },
		]);
	});

	test("recovers a valid cue after a malformed cue without a blank separator", () => {
		const parsed = parseSrt(
			"1\nnot a timestamp --> here\nBroken\n2\n00:00:03,000 --> 00:00:04,000\nRecovered\n",
		);

		expect(parsed.totalCues).toBe(2);
		expect(parsed.issues).toEqual([{ cue: 1, reason: "malformed-cue" }]);
		expect(parsed.cues).toEqual([
			{ index: 2, startMs: 3_000, endMs: 4_000, text: "Recovered" },
		]);
	});

	test("reports malformed, empty and non-positive cues without hiding valid cues", () => {
		const parsed = parseSrt(
			"broken\n\n2\n00:00:01,000 --> 00:00:01,000\nNo time\n\n3\n00:00:02,000 --> 00:00:03,000\n<i></i>\n\n4\n00:00:04,000 --> 00:00:05,000\nValid\n",
		);
		expect(parsed.totalCues).toBe(4);
		expect(parsed.cues).toEqual([
			{ index: 4, startMs: 4_000, endMs: 5_000, text: "Valid" },
		]);
		expect(parsed.issues.map((issue) => issue.reason)).toEqual([
			"malformed-cue",
			"non-positive-duration",
			"empty-text",
		]);
	});

	test("builds a source-verified transcript and excludes unsafe cues", () => {
		const denseText = "日".repeat(300);
		const result = srtToTranscript({
			text: `1\n00:00:01,000 --> 00:00:03,000\n正常な文章です。\n\n2\n00:00:02,000 --> 00:00:04,000\noverlap\n\n3\n00:00:05,000 --> 00:00:06,000\n${denseText}\n\n4\n00:00:11,000 --> 00:00:12,000\nafter audio\n`,
			path: "/subs/book.srt",
			sha256: SHA,
			audioPath: "/audio/book.m4b",
			audioSha256: "b".repeat(64),
			audioDurationMs: 10_000,
			language: "ja",
		});

		expect(result.transcript.segments).toHaveLength(1);
		expect(result.transcript.source?.sha256).toBe("b".repeat(64));
		expect(result.report).toMatchObject({
			filename: "book.srt",
			totalCues: 4,
			usedCues: 1,
			excludedCues: 3,
			issueCounts: {
				overlap: 1,
				"implausible-density": 1,
				"after-audio": 1,
			},
		});
	});
});

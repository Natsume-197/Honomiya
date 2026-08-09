import { describe, expect, test } from "bun:test";
import {
	HONOMIYA_TRANSCRIPT_SCHEMA,
	type HonomiyaTranscript,
} from "../transcription/transcript";
import type { AddressableSentence } from "./ebook-text";
import {
	alignSentencesToTranscripts,
	planFineAlignmentWindows,
} from "./sentences";
import { alignmentTokens } from "./text";

function sentence(
	id: string,
	sectionRef: string,
	text: string,
): AddressableSentence {
	return {
		id,
		sectionRef,
		blockIndex: 0,
		sourceRange: { startUtf16: 0, endUtf16: text.length },
		text,
		tokens: alignmentTokens(text, "en"),
		normalizedText: alignmentTokens(text, "en").join(" "),
		anchor: { kind: "text-quote", sectionRef, exact: text },
	};
}

function transcript(words: string[]): HonomiyaTranscript {
	return {
		schema: HONOMIYA_TRANSCRIPT_SCHEMA,
		engine: { provider: "fixture", model: "fixture" },
		language: "en",
		offsetMs: 0,
		durationMs: words.length * 500,
		segments: [
			{
				id: 0,
				startMs: 0,
				endMs: words.length * 500,
				text: words.join(" "),
				words: words.map((word, index) => ({
					text: word,
					startMs: index * 500,
					endMs: (index + 1) * 500,
				})),
			},
		],
	};
}

function sentenceWithTokens(
	id: string,
	sectionRef: string,
	tokens: string[],
): AddressableSentence {
	const text = tokens.join(" ");
	return {
		id,
		sectionRef,
		blockIndex: 0,
		sourceRange: { startUtf16: 0, endUtf16: text.length },
		text,
		tokens,
		normalizedText: text,
		anchor: { kind: "text-quote", sectionRef, exact: text },
	};
}

function alphabeticIndex(index: number): string {
	let value = index;
	let suffix = "";
	do {
		suffix = String.fromCharCode(97 + (value % 26)) + suffix;
		value = Math.floor(value / 26) - 1;
	} while (value >= 0);
	return `word${suffix}`;
}

describe("sentence-to-audio alignment", () => {
	test("splits fine alignment at sentence boundaries", () => {
		expect(
			planFineAlignmentWindows(
				[
					{ start: 0, end: 4 },
					{ start: 4, end: 9 },
					{ start: 9, end: 15 },
				],
				15,
				10,
			),
		).toEqual([
			{ bookStart: 0, bookEnd: 9 },
			{ bookStart: 9, bookEnd: 15 },
		]);
	});

	test("maps chapters by content instead of assuming track order", () => {
		const sentences = [
			sentence("s-1", "chapter-one", "The cat sat on the mat."),
			sentence("s-2", "chapter-one", "It watched the rain."),
			sentence("s-3", "chapter-two", "A spaceship crossed the silent sky."),
			sentence("s-4", "chapter-two", "Engines burned brightly."),
		];
		const result = alignSentencesToTranscripts(sentences, [
			transcript([
				"a",
				"spaceship",
				"crossed",
				"the",
				"silent",
				"sky",
				"engines",
				"burned",
				"brightly",
			]),
			transcript([
				"publisher",
				"the",
				"cat",
				"sat",
				"on",
				"the",
				"mat",
				"it",
				"watched",
				"the",
				"storm",
			]),
		]);

		expect(result.cues).toHaveLength(4);
		expect(
			result.cues.find(({ cue }) => cue.id === "s-1")?.cue.audioFileIndex,
		).toBe(1);
		expect(
			result.cues.find(({ cue }) => cue.id === "s-3")?.cue.audioFileIndex,
		).toBe(0);
		expect(result.report.bookCoverage).toBe(1);
	});

	test("bounds a long section before the next matched section", () => {
		const words = Array.from({ length: 600 }, (_, index) =>
			alphabeticIndex(index),
		);
		const result = alignSentencesToTranscripts(
			[
				sentenceWithTokens("long", "section-long", words.slice(0, 500)),
				sentenceWithTokens("nested", "section-next", words.slice(300, 400)),
			],
			[transcript(words)],
		);
		const long = result.cues.find(({ cue }) => cue.id === "long")?.cue;
		const next = result.cues.find(({ cue }) => cue.id === "nested")?.cue;

		expect(long).toBeDefined();
		expect(next).toBeDefined();
		expect(long?.endMs).toBeLessThanOrEqual(next?.startMs ?? 0);
	});

	test("anchors the next fine window from the last exact match", () => {
		const bookWords = Array.from({ length: 5_100 }, (_, index) =>
			alphabeticIndex(index),
		);
		const repeatedTail = bookWords.slice(5_000);
		const audioWords = [
			...bookWords,
			...Array.from(
				{ length: 2_600 },
				(_, index) => `filler${alphabeticIndex(index)}`,
			),
			...repeatedTail,
		];
		const result = alignSentencesToTranscripts(
			[
				sentenceWithTokens(
					"window-one",
					"long-section",
					bookWords.slice(0, 5_000),
				),
				sentenceWithTokens("window-two", "long-section", repeatedTail),
			],
			[transcript(audioWords)],
		);
		const first = result.cues.find(({ cue }) => cue.id === "window-one")?.cue;
		const second = result.cues.find(({ cue }) => cue.id === "window-two")?.cue;

		expect(first).toBeDefined();
		expect(second).toBeDefined();
		expect(second?.startMs).toBeLessThan(3_000_000);
	});

	test("maps multiple ebook sections onto one continuous audiobook", () => {
		const sentences = [
			sentence("s-1", "chapter-one", "Alpha opens the first section."),
			sentence("s-2", "chapter-one", "Morning follows quietly."),
			sentence("s-3", "chapter-two", "Beta opens the second section."),
			sentence("s-4", "chapter-two", "Evening follows quietly."),
		];
		const result = alignSentencesToTranscripts(sentences, [
			transcript([
				"alpha",
				"opens",
				"the",
				"first",
				"section",
				"morning",
				"follows",
				"quietly",
				"interlude",
				"beta",
				"opens",
				"the",
				"second",
				"section",
				"evening",
				"follows",
				"quietly",
			]),
		]);

		expect(result.cues).toHaveLength(4);
		expect(result.cues.every(({ cue }) => cue.audioFileIndex === 0)).toBe(true);
		expect(
			result.report.chapters.map((chapter) => chapter.audioFileIndex),
		).toEqual([0, 0]);
	});

	test("splits overlapping ASR word boundaries between adjacent cues", () => {
		const audio = transcript(["alpha", "begins", "omega", "ends"]);
		const words = audio.segments[0]?.words;
		if (!words?.[1] || !words[2]) {
			throw new Error("Test fixture must contain boundary words");
		}
		words[1].endMs = 1_200;
		words[2].startMs = 1_000;

		const result = alignSentencesToTranscripts(
			[
				sentence("s-1", "chapter", "Alpha begins."),
				sentence("s-2", "chapter", "Omega ends."),
			],
			[audio],
			"en",
			{ interpolationMode: "off" },
		);

		expect(result.cues.map(({ cue }) => cue)).toEqual([
			expect.objectContaining({ id: "s-1", startMs: 0, endMs: 1_100 }),
			expect.objectContaining({ id: "s-2", startMs: 1_100, endMs: 2_000 }),
		]);
	});

	test("interpolates only between trustworthy direct anchors", () => {
		const sentences = [
			sentence("s-1", "chapter", "Alpha begins."),
			sentence("s-2", "chapter", "Missing center words."),
			sentence("s-3", "chapter", "Omega ends."),
		];
		const audio = transcript(["alpha", "begins", "omega", "ends"]);
		const segment = audio.segments[0];
		const words = segment?.words;
		if (!segment || !words) throw new Error("Test fixture must contain words");
		const omega = words[2];
		const ends = words[3];
		if (!omega || !ends) throw new Error("Test fixture must contain omega");
		omega.startMs = 2_000;
		omega.endMs = 2_500;
		ends.startMs = 2_500;
		ends.endMs = 3_000;
		audio.durationMs = 3_000;
		segment.endMs = 3_000;
		const result = alignSentencesToTranscripts(sentences, [audio]);
		const middle = result.cues.find(({ cue }) => cue.id === "s-2");

		expect(middle?.evidence.kind).toBe("interpolated");
		expect(middle?.evidence.basis).toBe("wall-clock");
		expect(middle?.cue.startMs).toBe(1_000);
		expect(middle?.cue.endMs).toBe(2_000);
	});

	test("can disable interpolation completely", () => {
		const sentences = [
			sentence("s-1", "chapter", "Alpha begins."),
			sentence("s-2", "chapter", "Missing center words."),
			sentence("s-3", "chapter", "Omega ends."),
		];
		const result = alignSentencesToTranscripts(
			sentences,
			[transcript(["alpha", "begins", "omega", "ends"])],
			"en",
			{ interpolationMode: "off" },
		);

		expect(result.cues.some(({ cue }) => cue.id === "s-2")).toBe(false);
		expect(result.report.interpolatedCues).toBe(0);
	});

	test("complete interpolation allocates missing sentences over speech only", () => {
		const sentences = [
			sentence("s-1", "chapter", "Alpha begins."),
			sentence("s-2", "chapter", "Missing center one."),
			sentence("s-3", "chapter", "Missing center two."),
			sentence("s-4", "chapter", "Omega ends."),
		];
		const audio = transcript(["alpha", "begins", "omega", "ends"]);
		const segment = audio.segments[0];
		const omega = segment?.words[2];
		const ends = segment?.words[3];
		if (!segment || !omega || !ends) throw new Error("Invalid fixture");
		omega.startMs = 5_000;
		omega.endMs = 5_500;
		ends.startMs = 5_500;
		ends.endMs = 6_000;
		segment.endMs = 6_000;
		audio.durationMs = 6_000;
		audio.speechTimeline = [
			{ startMs: 0, endMs: 1_000 },
			{ startMs: 1_200, endMs: 2_200 },
			{ startMs: 4_000, endMs: 5_000 },
			{ startMs: 5_000, endMs: 6_000 },
		];
		const result = alignSentencesToTranscripts(sentences, [audio], "en", {
			interpolationMode: "complete",
		});
		const firstMissing = result.cues.find(({ cue }) => cue.id === "s-2");
		const secondMissing = result.cues.find(({ cue }) => cue.id === "s-3");

		expect(firstMissing?.cue).toMatchObject({ startMs: 1_200, endMs: 2_200 });
		expect(secondMissing?.cue).toMatchObject({ startMs: 4_000, endMs: 5_000 });
		expect(firstMissing?.evidence).toEqual({
			kind: "interpolated",
			basis: "speech",
		});
	});

	test("requires speech regions for complete interpolation", () => {
		expect(() =>
			alignSentencesToTranscripts(
				[sentence("s-1", "chapter", "Alpha begins.")],
				[transcript(["alpha", "begins"])],
				"en",
				{ interpolationMode: "complete" },
			),
		).toThrow(
			"Complete interpolation requires a speechTimeline in every transcript",
		);
	});
});

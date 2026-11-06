import type { AddressableSentence } from "../alignment/ebook-text";
import type {
	AlignedCue,
	AlignmentReport,
	ChapterAlignmentReport,
} from "../alignment/sentences";
import { type CtcEmissions, frameDurationMs } from "./emissions";
import {
	type Anchor,
	type ChapterLocation,
	chapterSpans,
	DEFAULT_BOUNDARY_SEARCH_OPTIONS,
	decodeForSearch,
	locateChapters,
	trackFrame,
} from "./search";
import { type ConditionedText, conditionText, VocabularyIndex } from "./text";
import { EmissionReader, forcedAlign, segmentScores } from "./viterbi";

export const CTC_ALIGNMENT_VERSION = "honomiya.ctc-align.v1" as const;

export interface CtcAlignmentOptions {
	/** Anchors kept as segment boundaries are at least this many tokens apart. */
	segmentTokens: number;
	/** Segments larger than this (frames × states) are left to interpolation. */
	maxSegmentCells: number;
	/** Not narrated: at least this many tokens squeezed into few frames... */
	droppedMinTokens: number;
	/** ...under this many frames per token... */
	droppedMaxFramesPerToken: number;
	/** ...with a mean token log probability below this. */
	droppedMaxScore: number;
	/**
	 * Extends every cue's end into the following silence, never past the next
	 * cue's start, so the fading last syllable is not cut off. Phase 6 audio
	 * measurements: 400 ms leaves about 2.5 % of sentences audible past
	 * their end, against 15 % with no extension.
	 */
	endPaddingMs: number;
}

export const DEFAULT_CTC_ALIGNMENT_OPTIONS: CtcAlignmentOptions = {
	segmentTokens: 150,
	maxSegmentCells: 80_000_000,
	droppedMinTokens: 8,
	droppedMaxFramesPerToken: 1.5,
	droppedMaxScore: -4,
	endPaddingMs: 400,
};

export interface TimedWord {
	/** UTF-16 range of the word in its sentence text. */
	start: number;
	end: number;
	text: string;
	/** Words tile their cue: each ends where the next starts. */
	startMs: number;
	endMs: number;
}

export interface CtcAlignedCue extends AlignedCue {
	words: TimedWord[];
}

export interface CtcAlignmentReport {
	algorithm: typeof CTC_ALIGNMENT_VERSION;
	chapters: Array<{
		sectionRef: string;
		status: ChapterLocation["status"];
		anchors: number;
		coverage: number;
		segments: number;
		oversizedSegments: number;
	}>;
	segments: number;
	oversizedSegments: number;
	droppedSentences: number;
	starTokens: number;
	performance: { conditionMs: number; searchMs: number; viterbiMs: number };
}

interface SentenceFrames {
	startFrame: number;
	endFrame: number;
	score: number;
}

function thinAnchors(anchors: Anchor[], spacing: number): Anchor[] {
	const kept: Anchor[] = [];
	for (const anchor of anchors) {
		const previous = kept.at(-1);
		if (!previous || anchor.token - previous.token >= spacing) kept.push(anchor);
	}
	return kept;
}

/**
 * Aligns ebook sentences to CTC emissions: conditions the text, places
 * chapters, runs Viterbi between anchors and turns token frames into cues.
 * Each track is one audio file, in manifest order.
 */
export function alignWithCtc(
	sentences: AddressableSentence[],
	tracks: CtcEmissions[],
	options: { locale?: string; alignment?: Partial<CtcAlignmentOptions> } = {},
): { cues: CtcAlignedCue[]; report: AlignmentReport; ctc: CtcAlignmentReport } {
	const settings = { ...DEFAULT_CTC_ALIGNMENT_OPTIONS, ...options.alignment };
	const first = tracks[0];
	if (!first) throw new Error("CTC alignment needs emissions for at least one track");
	const { header } = first;
	for (const track of tracks) {
		if (
			track.header.model.revision !== header.model.revision ||
			track.header.samplesPerFrame !== header.samplesPerFrame ||
			track.header.sampleRate !== header.sampleRate
		) {
			throw new Error("All tracks must use emissions from the same model");
		}
	}
	const frameMs = frameDurationMs(header);
	const correction = header.model.timingCorrectionMs;
	const index = new VocabularyIndex({ tokens: header.vocabulary, blank: header.blank });

	const conditionStarted = performance.now();
	const text: ConditionedText = conditionText(sentences, index, { locale: options.locale });
	const conditionMs = performance.now() - conditionStarted;

	const searchStarted = performance.now();
	const spans = chapterSpans(text, (sentence) => sentences[sentence]?.sectionRef ?? "");
	const decode = decodeForSearch(tracks, index);
	const locations = locateChapters(text, spans, decode, DEFAULT_BOUNDARY_SEARCH_OPTIONS);
	const searchMs = performance.now() - searchStarted;

	// Forced alignment, segment by segment.
	const reader = new EmissionReader(tracks);
	const tokenFirst = new Int32Array(text.tokens.length).fill(-1);
	const tokenLast = new Int32Array(text.tokens.length).fill(-1);
	const tokenScore = new Float32Array(text.tokens.length).fill(Number.NaN);
	const chapterReports: CtcAlignmentReport["chapters"] = [];
	let segmentCount = 0;
	let oversizedCount = 0;
	const viterbiStarted = performance.now();
	for (const location of locations) {
		const sectionRef =
			sentences[text.sentence[location.tokenStart] ?? 0]?.sectionRef ?? "";
		const chapterReport = {
			sectionRef,
			status: location.status,
			anchors: location.anchors.length,
			coverage: location.coverage,
			segments: 0,
			oversizedSegments: 0,
		};
		chapterReports.push(chapterReport);
		if (location.status !== "found" || location.startFrame === undefined || location.endFrame === undefined) {
			continue;
		}
		const chapterStartFrame = location.startFrame;
		const anchors = thinAnchors(location.anchors, settings.segmentTokens);
		const boundaries: Array<{ token: number; frame: number }> = [
			{ token: location.tokenStart, frame: location.startFrame },
			...anchors.filter(
				(anchor) => anchor.token > location.tokenStart && anchor.frame > chapterStartFrame,
			),
			{ token: location.tokenEnd, frame: location.endFrame },
		];
		for (let position = 0; position + 1 < boundaries.length; position += 1) {
			const from = boundaries[position] as { token: number; frame: number };
			const to = boundaries[position + 1] as { token: number; frame: number };
			if (to.token <= from.token || to.frame <= from.frame) continue;
			const tokens = text.tokens.subarray(from.token, to.token);
			const frames = to.frame - from.frame;
			chapterReport.segments += 1;
			segmentCount += 1;
			if (frames * (2 * tokens.length + 1) > settings.maxSegmentCells || frames < tokens.length) {
				chapterReport.oversizedSegments += 1;
				oversizedCount += 1;
				continue;
			}
			const scores = segmentScores(reader, text.classSets, tokens, from.frame, to.frame);
			const result = forcedAlign(scores, tokens, {
				freeStart: position === 0,
				freeEnd: position + 2 === boundaries.length,
			});
			if (result.score === Number.NEGATIVE_INFINITY) continue;
			for (let token = 0; token < tokens.length; token += 1) {
				const firstFrame = result.firstFrame[token] ?? -1;
				if (firstFrame < 0) continue;
				tokenFirst[from.token + token] = from.frame + firstFrame;
				tokenLast[from.token + token] = from.frame + (result.lastFrame[token] ?? firstFrame);
				tokenScore[from.token + token] = result.tokenScore[token] ?? Number.NaN;
			}
		}
	}
	const viterbiMs = performance.now() - viterbiStarted;

	// Sentence frames from token frames; flag text that was not narrated.
	const sentenceFrames: Array<SentenceFrames | undefined> = sentences.map(() => undefined);
	const sentenceTokens: Array<{ start: number; end: number } | undefined> = sentences.map(() => undefined);
	for (let token = 0; token < text.tokens.length; token += 1) {
		const sentence = text.sentence[token] ?? 0;
		const range = sentenceTokens[sentence];
		if (range) range.end = token + 1;
		else sentenceTokens[sentence] = { start: token, end: token + 1 };
	}
	let droppedSentences = 0;
	for (const [sentence, range] of sentenceTokens.entries()) {
		if (!range) continue;
		let startFrame = -1;
		let endFrame = -1;
		let scoreSum = 0;
		let scored = 0;
		for (let token = range.start; token < range.end; token += 1) {
			if ((tokenFirst[token] ?? -1) < 0) continue;
			if (startFrame < 0) startFrame = tokenFirst[token] ?? -1;
			endFrame = (tokenLast[token] ?? -1) + 1;
			const score = tokenScore[token] ?? Number.NaN;
			if (!Number.isNaN(score)) {
				scoreSum += score;
				scored += 1;
			}
		}
		if (startFrame < 0) continue;
		const count = range.end - range.start;
		const meanScore = scored > 0 ? scoreSum / scored : Number.NEGATIVE_INFINITY;
		if (
			count >= settings.droppedMinTokens &&
			(endFrame - startFrame) / count < settings.droppedMaxFramesPerToken &&
			meanScore < settings.droppedMaxScore
		) {
			droppedSentences += 1;
			continue;
		}
		sentenceFrames[sentence] = { startFrame, endFrame, score: meanScore };
	}

	// Frames to cues: apply the model's timing correction, keep cues ordered
	// and non-overlapping inside each audio file.
	const toTrackMs = (globalFrame: number, correctionMs: number) => {
		const { track, frame } = trackFrame(decode, globalFrame);
		const durationMs = (tracks[track]?.header.sourceDurationMs ?? Number.POSITIVE_INFINITY);
		return {
			track,
			ms: Math.round(Math.min(durationMs, Math.max(0, frame * frameMs + correctionMs))),
		};
	};
	const located = new Set(
		locations.filter((location) => location.status === "found").flatMap((location) => {
			const indexes: number[] = [];
			for (let token = location.tokenStart; token < location.tokenEnd; token += 1) {
				indexes.push(text.sentence[token] ?? 0);
			}
			return indexes;
		}),
	);

	interface Timing {
		sentence: number;
		track: number;
		startMs: number;
		endMs: number;
		kind: "direct" | "interpolated";
		score?: number;
	}
	const timings: Array<Timing | undefined> = sentences.map(() => undefined);
	for (const [sentence, frames] of sentenceFrames.entries()) {
		if (!frames) continue;
		const start = toTrackMs(frames.startFrame, correction.start);
		const end = toTrackMs(frames.endFrame, correction.end);
		timings[sentence] = {
			sentence,
			track: start.track,
			startMs: start.ms,
			endMs: end.track === start.track ? end.ms : (tracks[start.track]?.header.sourceDurationMs ?? end.ms),
			kind: "direct",
			score: Math.max(0, Math.min(1, Math.exp(frames.score))),
		};
	}

	// Interpolate sentences of placed chapters between timed neighbours of the
	// same track, weighted by their text length.
	let previous: number | undefined;
	for (let sentence = 0; sentence <= sentences.length; sentence += 1) {
		const timing = timings[sentence];
		if (sentence < sentences.length && !timing) continue;
		if (previous !== undefined && sentence - previous > 1) {
			const before = timings[previous] as Timing;
			const after = timing;
			const gap = Array.from({ length: sentence - previous - 1 }, (_, offset) => previous! + 1 + offset).filter(
				(index) => located.has(index) && sentences[index]?.sectionRef === sentences[previous!]?.sectionRef,
			);
			if (after && after.track === before.track && gap.length > 0 && after.startMs > before.endMs) {
				const weights = gap.map((index) => Math.max(1, sentences[index]?.text.length ?? 1));
				const total = weights.reduce((sum, weight) => sum + weight, 0);
				let cursor = before.endMs;
				const span = after.startMs - before.endMs;
				for (const [position, index] of gap.entries()) {
					const length = (span * (weights[position] ?? 1)) / total;
					const startMs = Math.round(cursor);
					const endMs = Math.max(startMs + 1, Math.round(cursor + length));
					cursor += length;
					timings[index] = { sentence: index, track: before.track, startMs, endMs, kind: "interpolated" };
				}
			}
		}
		if (timing) previous = sentence;
	}

	const ordered = timings
		.filter((timing): timing is Timing => Boolean(timing))
		.sort((a, b) => a.track - b.track || a.startMs - b.startMs || a.sentence - b.sentence);
	const cues: CtcAlignedCue[] = [];
	for (const timing of ordered) {
		const last = cues.at(-1);
		let startMs = timing.startMs;
		if (last && last.cue.audioFileIndex === timing.track) startMs = Math.max(startMs, last.cue.endMs);
		const endMs = Math.max(startMs + 1, timing.endMs);
		const durationMs = tracks[timing.track]?.header.sourceDurationMs ?? endMs;
		if (startMs >= durationMs) continue;
		const sentence = sentences[timing.sentence] as AddressableSentence;
		cues.push({
			cue: {
				id: sentence.id,
				text: sentence.anchor,
				audioFileIndex: timing.track,
				startMs,
				endMs: Math.min(durationMs, endMs),
			},
			evidence: {
				kind: timing.kind,
				...(timing.score === undefined ? {} : { score: Number(timing.score.toFixed(4)) }),
			},
			text: sentence.text,
			words:
				timing.kind === "direct"
					? tileWords(
							wordStarts(
								text,
								sentenceTokens[timing.sentence],
								tokenFirst,
								frameMs,
								correction.start,
								decode,
							),
							startMs,
							Math.min(durationMs, endMs),
							sentence.text,
						)
					: [],
		});
	}

	padCueEnds(cues, settings.endPaddingMs, (track) => tracks[track]?.header.sourceDurationMs);

	// Report in the same shape as the transcript aligner.
	const chapterOf = new Map<string, ChapterAlignmentReport>();
	for (const sentence of sentences) {
		const report = chapterOf.get(sentence.sectionRef) ?? {
			sectionRef: sentence.sectionRef,
			sentences: 0,
			directCues: 0,
			interpolatedCues: 0,
			unmatchedSentences: 0,
		};
		report.sentences += 1;
		chapterOf.set(sentence.sectionRef, report);
	}
	const sentenceIndex = new Map(sentences.map((sentence, index) => [sentence.id, index]));
	for (const { cue, evidence } of cues) {
		const sentence = sentences[sentenceIndex.get(cue.id) ?? 0] as AddressableSentence;
		const report = chapterOf.get(sentence.sectionRef);
		if (!report) continue;
		report.audioFileIndex ??= cue.audioFileIndex;
		if (evidence.kind === "direct") report.directCues += 1;
		else report.interpolatedCues += 1;
	}
	for (const report of chapterOf.values()) {
		report.unmatchedSentences = report.sentences - report.directCues - report.interpolatedCues;
		const location = locations.find(
			(candidate) => sentences[text.sentence[candidate.tokenStart] ?? 0]?.sectionRef === report.sectionRef,
		);
		if (location?.status === "found") report.chapterScore = Number(location.coverage.toFixed(4));
	}
	const directCues = cues.filter((cue) => cue.evidence.kind === "direct").length;
	const usedTracks = new Set(cues.map((cue) => cue.cue.audioFileIndex));
	return {
		cues,
		report: {
			bookSentences: sentences.length,
			directCues,
			interpolatedCues: cues.length - directCues,
			unmatchedSentences: sentences.length - cues.length,
			bookCoverage: sentences.length > 0 ? cues.length / sentences.length : 0,
			directCoverage: sentences.length > 0 ? directCues / sentences.length : 0,
			unmatchedAudioFiles: tracks.map((_, track) => track).filter((track) => !usedTracks.has(track)),
			chapters: [...chapterOf.values()],
		},
		ctc: {
			algorithm: CTC_ALIGNMENT_VERSION,
			chapters: chapterReports,
			segments: segmentCount,
			oversizedSegments: oversizedCount,
			droppedSentences,
			starTokens: text.stats.star,
			performance: {
				conditionMs: Math.round(conditionMs),
				searchMs: Math.round(searchMs),
				viterbiMs: Math.round(viterbiMs),
			},
		},
	};
}

interface WordStart {
	start: number;
	end: number;
	startMs: number;
}

/** Start time of every aligned word of a sentence, from its first token. */
function wordStarts(
	text: ConditionedText,
	range: { start: number; end: number } | undefined,
	tokenFirst: Int32Array,
	frameMs: number,
	startCorrectionMs: number,
	decode: { trackStartFrames: number[] },
): WordStart[] {
	const words: WordStart[] = [];
	let currentWord = Number.NaN;
	for (let token = range?.start ?? 0; token < (range?.end ?? 0); token += 1) {
		const firstFrame = tokenFirst[token] ?? -1;
		if (firstFrame < 0) continue;
		const word = text.word[token] ?? -1;
		const last = words.at(-1);
		if (last && word === currentWord) {
			last.end = text.sourceEnd[token] ?? last.end;
			continue;
		}
		currentWord = word;
		words.push({
			start: text.sourceStart[token] ?? 0,
			end: text.sourceEnd[token] ?? 0,
			startMs: Math.round(trackFrame(decode, firstFrame).frame * frameMs + startCorrectionMs),
		});
	}
	return words;
}

/**
 * Lays words end to end over their cue: the first starts with the cue, each
 * ends where the next starts, the last ends with the cue. A word with no room
 * left (at least 1 ms each) merges into the word before it.
 */
export function tileWords(
	starts: WordStart[],
	cueStartMs: number,
	cueEndMs: number,
	sentenceText: string,
): TimedWord[] {
	const placed: WordStart[] = [];
	for (const word of starts) {
		const previous = placed.at(-1);
		const startMs = previous
			? Math.max(word.startMs, previous.startMs + 1)
			: cueStartMs;
		if (startMs >= cueEndMs || (previous && word.start < previous.end)) {
			if (previous) previous.end = Math.max(previous.end, word.end);
			continue;
		}
		placed.push({ ...word, startMs });
	}
	return placed.map((word, index) => ({
		start: word.start,
		end: word.end,
		text: sentenceText.slice(word.start, word.end),
		startMs: word.startMs,
		endMs: placed[index + 1]?.startMs ?? cueEndMs,
	}));
}

/**
 * Extends each cue's end by up to `paddingMs`, stopping at the next cue of the
 * same audio file and at the end of the file. The last word of the cue, if
 * any, keeps ending with its cue. `cues` must be ordered by file and start.
 */
export function padCueEnds(
	cues: CtcAlignedCue[],
	paddingMs: number,
	durationOf: (audioFileIndex: number) => number | undefined,
): void {
	if (paddingMs <= 0) return;
	for (const [index, aligned] of cues.entries()) {
		const { cue } = aligned;
		const next = cues[index + 1]?.cue;
		const limit = Math.min(
			next && next.audioFileIndex === cue.audioFileIndex ? next.startMs : Number.POSITIVE_INFINITY,
			durationOf(cue.audioFileIndex) ?? Number.POSITIVE_INFINITY,
		);
		const endMs = Math.max(cue.endMs, Math.min(cue.endMs + paddingMs, limit));
		const lastWord = aligned.words.at(-1);
		if (lastWord && lastWord.endMs === cue.endMs) lastWord.endMs = endMs;
		cue.endMs = endMs;
	}
}

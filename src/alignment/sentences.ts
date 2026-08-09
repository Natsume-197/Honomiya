import type { ReadListenCue } from "../artifacts/manifest";
import type { InterpolationMode } from "../options/align";
import type { HonomiyaTranscript } from "../transcription/transcript";
import type { AddressableSentence } from "./ebook-text";
import { alignTokenSequences, tokenEditSimilarity } from "./sequence";
import { alignmentTokens } from "./text";

const CHAPTER_PREFIX_TOKENS = 256;
const MAX_AUDIO_INTRO_TOKENS = 64;
const CHAPTER_NGRAM_SIZE = 5;
const CHAPTER_VOTE_BIN_SIZE = 50;
const MIN_CHAPTER_TOKENS = 4;
const MIN_CHAPTER_SCORE = 0.4;
const FINE_WINDOW_RATIO = 1.5;
const FINE_WINDOW_PADDING_TOKENS = 256;
const MAX_FINE_WINDOW_TOKENS = 5_000;
const FINE_ANCHOR_BACKTRACK_TOKENS = 32;
const FINE_ANCHOR_SEARCH_TOKENS = 1_024;
const MAX_INTERPOLATION_GAP_MS = 60_000;

export const ALIGNMENT_PARAMETERS = {
	chapterPrefixTokens: CHAPTER_PREFIX_TOKENS,
	maxAudioIntroTokens: MAX_AUDIO_INTRO_TOKENS,
	chapterNgramSize: CHAPTER_NGRAM_SIZE,
	chapterVoteBinSize: CHAPTER_VOTE_BIN_SIZE,
	minChapterTokens: MIN_CHAPTER_TOKENS,
	minChapterScore: MIN_CHAPTER_SCORE,
	fineWindowRatio: FINE_WINDOW_RATIO,
	fineWindowPaddingTokens: FINE_WINDOW_PADDING_TOKENS,
	maxFineWindowTokens: MAX_FINE_WINDOW_TOKENS,
	fineAnchorBacktrackTokens: FINE_ANCHOR_BACKTRACK_TOKENS,
	fineAnchorSearchTokens: FINE_ANCHOR_SEARCH_TOKENS,
	maxInterpolationGapMs: MAX_INTERPOLATION_GAP_MS,
	sequenceGapModel: "affine",
	sequenceGapOpenScore: -0.8,
	sequenceGapExtensionScore: -0.5,
	overlapResolution: "midpoint",
} as const;

export interface TimedTranscriptToken {
	value: string;
	audioFileIndex: number;
	startMs: number;
	endMs: number;
}

export interface CueEvidence {
	kind: "direct" | "interpolated";
	score?: number;
	basis?: "wall-clock" | "speech";
}

export interface AlignedCue {
	cue: ReadListenCue;
	evidence: CueEvidence;
	text: string;
}

export interface ChapterAlignmentReport {
	sectionRef: string;
	audioFileIndex?: number;
	chapterScore?: number;
	sentences: number;
	directCues: number;
	interpolatedCues: number;
	unmatchedSentences: number;
}

export interface AlignmentReport {
	bookSentences: number;
	directCues: number;
	interpolatedCues: number;
	unmatchedSentences: number;
	bookCoverage: number;
	directCoverage: number;
	unmatchedAudioFiles: number[];
	chapters: ChapterAlignmentReport[];
}

export interface AlignmentResult {
	cues: AlignedCue[];
	report: AlignmentReport;
}

interface ChapterText {
	sectionRef: string;
	sentences: AddressableSentence[];
	tokens: string[];
	sentenceRanges: Array<{ start: number; end: number }>;
}

interface AudioTranscript {
	audioFileIndex: number;
	tokens: TimedTranscriptToken[];
	values: string[];
	ngramIndex: Map<string, number[]>;
	startMs: number;
	endMs: number;
	speechTimeline: NonNullable<HonomiyaTranscript["speechTimeline"]>;
}

export interface AlignmentOptions {
	interpolationMode?: InterpolationMode;
}

export interface FineAlignmentWindow {
	bookStart: number;
	bookEnd: number;
}

export function planFineAlignmentWindows(
	sentenceRanges: Array<{ start: number; end: number }>,
	totalTokens: number,
	maxTokens = MAX_FINE_WINDOW_TOKENS,
): FineAlignmentWindow[] {
	if (!Number.isInteger(maxTokens) || maxTokens <= 0) {
		throw new Error("maxTokens must be a positive integer");
	}
	const windows: FineAlignmentWindow[] = [];
	let bookStart = 0;
	while (bookStart < totalTokens) {
		const limit = Math.min(totalTokens, bookStart + maxTokens);
		let bookEnd = limit;
		for (const range of sentenceRanges) {
			if (range.end <= bookStart) continue;
			if (range.end > limit) break;
			bookEnd = range.end;
		}
		if (bookEnd <= bookStart) bookEnd = limit;
		windows.push({ bookStart, bookEnd });
		bookStart = bookEnd;
	}
	return windows;
}

function ngramKey(values: string[], position: number): string {
	return values.slice(position, position + CHAPTER_NGRAM_SIZE).join("\u0001");
}

function buildNgramIndex(values: string[]): Map<string, number[]> {
	const index = new Map<string, number[]>();
	for (
		let position = 0;
		position <= values.length - CHAPTER_NGRAM_SIZE;
		position += 1
	) {
		const key = ngramKey(values, position);
		const positions = index.get(key) ?? [];
		positions.push(position);
		index.set(key, positions);
	}
	return index;
}

interface NgramVote {
	start: number;
	matchedNgrams: number;
	winningVotes: number;
	totalNgrams: number;
}

function voteForStart(
	query: string[],
	audio: AudioTranscript,
	minimumStart = 0,
	maximumStart = Number.POSITIVE_INFINITY,
	expectedStart = minimumStart,
): NgramVote | undefined {
	if (query.length < CHAPTER_NGRAM_SIZE) return undefined;
	const votes = new Map<number, number[]>();
	let matchedNgrams = 0;
	const totalNgrams = query.length - CHAPTER_NGRAM_SIZE + 1;
	for (let position = 0; position < totalNgrams; position += 1) {
		const occurrences = audio.ngramIndex.get(ngramKey(query, position));
		if (!occurrences) continue;
		let matched = false;
		for (const occurrence of occurrences) {
			const estimatedStart = occurrence - position;
			if (estimatedStart < minimumStart || estimatedStart > maximumStart) {
				continue;
			}
			matched = true;
			const bin = Math.floor(estimatedStart / CHAPTER_VOTE_BIN_SIZE);
			const starts = votes.get(bin) ?? [];
			starts.push(estimatedStart);
			votes.set(bin, starts);
		}
		if (matched) matchedNgrams += 1;
	}

	const winningStarts = [...votes.values()].sort(
		(left, right) =>
			right.length - left.length ||
			Math.abs((left[0] ?? expectedStart) - expectedStart) -
				Math.abs((right[0] ?? expectedStart) - expectedStart),
	)[0];
	if (!winningStarts) return undefined;
	winningStarts.sort((left, right) => left - right);
	return {
		start: Math.max(
			minimumStart,
			winningStarts[Math.floor(winningStarts.length / 2)] ?? minimumStart,
		),
		matchedNgrams,
		winningVotes: winningStarts.length,
		totalNgrams,
	};
}

interface ChapterMatch {
	chapter: ChapterText;
	audio: AudioTranscript;
	score: number;
	audioStart: number;
}

interface SentenceTiming {
	sentence: AddressableSentence;
	audioFileIndex: number;
	startMs: number;
	endMs: number;
	evidence: CueEvidence;
}

function timedTokensForText(
	text: string,
	startMs: number,
	endMs: number,
	audioFileIndex: number,
	language?: string,
): TimedTranscriptToken[] {
	const tokens = alignmentTokens(text, language);
	if (tokens.length === 0) return [];
	const durationMs = endMs - startMs;
	return tokens.flatMap((value, index) => {
		const tokenStart =
			startMs + Math.floor((durationMs * index) / tokens.length);
		const tokenEnd =
			startMs + Math.floor((durationMs * (index + 1)) / tokens.length);
		return tokenEnd > tokenStart
			? [{ value, audioFileIndex, startMs: tokenStart, endMs: tokenEnd }]
			: [];
	});
}

export function transcriptTimedTokens(
	transcript: HonomiyaTranscript,
	audioFileIndex: number,
	language?: string,
): TimedTranscriptToken[] {
	const locale = language ?? transcript.language;
	const tokens: TimedTranscriptToken[] = [];
	for (const segment of transcript.segments) {
		if (segment.words.length > 0) {
			for (const word of segment.words) {
				tokens.push(
					...timedTokensForText(
						word.text,
						word.startMs,
						word.endMs,
						audioFileIndex,
						locale,
					),
				);
			}
		} else {
			tokens.push(
				...timedTokensForText(
					segment.text,
					segment.startMs,
					segment.endMs,
					audioFileIndex,
					locale,
				),
			);
		}
	}
	return tokens;
}

function groupChapters(sentences: AddressableSentence[]): ChapterText[] {
	const chapters: ChapterText[] = [];
	for (const sentence of sentences) {
		let chapter = chapters.at(-1);
		if (!chapter || chapter.sectionRef !== sentence.sectionRef) {
			chapter = {
				sectionRef: sentence.sectionRef,
				sentences: [],
				tokens: [],
				sentenceRanges: [],
			};
			chapters.push(chapter);
		}
		const start = chapter.tokens.length;
		chapter.sentences.push(sentence);
		chapter.tokens.push(...sentence.tokens);
		chapter.sentenceRanges.push({ start, end: chapter.tokens.length });
	}
	return chapters;
}

function findChapterMatch(
	bookTokens: string[],
	audioTranscript: AudioTranscript,
): { score: number; start: number } {
	const query = bookTokens.slice(0, CHAPTER_PREFIX_TOKENS);
	const audio = audioTranscript.values;
	if (query.length < MIN_CHAPTER_TOKENS || audio.length === 0) {
		return { score: 0, start: 0 };
	}

	let bestPrefix = { score: 0, start: 0 };
	const lastStart = Math.min(
		MAX_AUDIO_INTRO_TOKENS,
		Math.max(0, audio.length - 1),
	);
	const lengths = new Set([
		Math.max(1, Math.floor(query.length * 0.8)),
		query.length,
		Math.ceil(query.length * 1.2),
	]);
	for (let start = 0; start <= lastStart; start += 1) {
		for (const length of lengths) {
			const candidate = audio.slice(
				start,
				Math.min(audio.length, start + length),
			);
			if (candidate.length === 0) continue;
			const score = tokenEditSimilarity(query, candidate);
			if (score > bestPrefix.score) bestPrefix = { score, start };
		}
	}

	if (query.length < CHAPTER_NGRAM_SIZE) return bestPrefix;
	const vote = voteForStart(query, audioTranscript);
	if (!vote || vote.matchedNgrams / vote.totalNgrams < 0.2) return bestPrefix;
	const votedStart = vote.start;
	const candidate = audio.slice(votedStart, votedStart + query.length);
	const editScore = tokenEditSimilarity(query, candidate);
	const coverage = vote.matchedNgrams / vote.totalNgrams;
	const voteConcentration = Math.min(1, vote.winningVotes / vote.totalNgrams);
	const score = 0.45 * editScore + 0.35 * coverage + 0.2 * voteConcentration;
	return score >= bestPrefix.score ? { score, start: votedStart } : bestPrefix;
}

function mapChapters(
	chapters: ChapterText[],
	audio: AudioTranscript[],
): ChapterMatch[] {
	const candidates = chapters
		.flatMap((chapter, chapterIndex) =>
			audio.flatMap((track, audioIndex) => {
				const candidate = findChapterMatch(chapter.tokens, track);
				return candidate.score >= MIN_CHAPTER_SCORE
					? [
							{
								chapter,
								chapterIndex,
								track,
								audioIndex,
								...candidate,
							},
						]
					: [];
			}),
		)
		.sort((left, right) => right.score - left.score);
	const usedChapters = new Set<number>();
	const occupiedPrefixes = new Map<
		number,
		Array<{ start: number; end: number }>
	>();
	const matches: ChapterMatch[] = [];
	for (const candidate of candidates) {
		if (usedChapters.has(candidate.chapterIndex)) continue;
		const prefixEnd = Math.min(
			candidate.track.tokens.length,
			candidate.start +
				Math.min(CHAPTER_PREFIX_TOKENS, candidate.chapter.tokens.length),
		);
		const occupied = occupiedPrefixes.get(candidate.audioIndex) ?? [];
		if (
			occupied.some(
				(range) => candidate.start < range.end && prefixEnd > range.start,
			)
		) {
			continue;
		}

		usedChapters.add(candidate.chapterIndex);
		occupied.push({ start: candidate.start, end: prefixEnd });
		occupiedPrefixes.set(candidate.audioIndex, occupied);
		matches.push({
			chapter: candidate.chapter,
			audio: candidate.track,
			score: candidate.score,
			audioStart: candidate.start,
		});
	}
	return matches.sort(
		(left, right) =>
			left.audio.audioFileIndex - right.audio.audioFileIndex ||
			left.audioStart - right.audioStart,
	);
}

function interpolateMissingTimings(
	chapter: ChapterText,
	timings: Array<SentenceTiming | undefined>,
	mode: InterpolationMode,
	audio: AudioTranscript,
	chapterStartMs: number,
	chapterEndMs: number,
): void {
	if (mode === "off") return;
	let position = 0;
	while (position < timings.length) {
		if (timings[position]) {
			position += 1;
			continue;
		}
		const runStart = position;
		while (position < timings.length && !timings[position]) position += 1;
		const runEnd = position;
		const left = timings[runStart - 1];
		const right = timings[runEnd];
		if (left && left.audioFileIndex !== audio.audioFileIndex) continue;
		if (right && right.audioFileIndex !== audio.audioFileIndex) continue;
		const intervalStartMs = left?.endMs ?? chapterStartMs;
		const intervalEndMs = right?.startMs ?? chapterEndMs;
		if (intervalEndMs - intervalStartMs < runEnd - runStart) continue;
		if (
			mode === "conservative" &&
			(!left ||
				!right ||
				intervalEndMs - intervalStartMs > MAX_INTERPOLATION_GAP_MS)
		) {
			continue;
		}

		const weights = chapter.sentences
			.slice(runStart, runEnd)
			.map((sentence) => Math.max(1, sentence.tokens.length));
		const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
		const speechRegions =
			mode === "complete"
				? audio.speechTimeline.flatMap((region) => {
						const startMs = Math.max(intervalStartMs, region.startMs);
						const endMs = Math.min(intervalEndMs, region.endMs);
						return endMs > startMs ? [{ startMs, endMs }] : [];
					})
				: [];
		const totalSpeechMs = speechRegions.reduce(
			(sum, region) => sum + region.endMs - region.startMs,
			0,
		);
		if (mode === "complete" && totalSpeechMs < runEnd - runStart) continue;
		const gapMs = intervalEndMs - intervalStartMs;
		let cursor = intervalStartMs;
		let speechCursor = 0;
		let remainingSpeechMs = totalSpeechMs;
		let remainingWeight = totalWeight;
		for (let index = runStart; index < runEnd; index += 1) {
			const weight = weights[index - runStart] ?? 1;
			const isLast = index === runEnd - 1;
			let startMs = cursor;
			let endMs: number;
			if (mode === "complete") {
				const remainingSentences = runEnd - index;
				const allocatedSpeechMs = isLast
					? remainingSpeechMs
					: Math.min(
							remainingSpeechMs - (remainingSentences - 1),
							Math.max(
								1,
								Math.floor((remainingSpeechMs * weight) / remainingWeight),
							),
						);
				startMs = speechOffsetToWallTime(speechRegions, speechCursor, "start");
				speechCursor += allocatedSpeechMs;
				endMs = speechOffsetToWallTime(speechRegions, speechCursor, "end");
				remainingSpeechMs -= allocatedSpeechMs;
				remainingWeight -= weight;
			} else {
				endMs = isLast
					? intervalEndMs
					: cursor + Math.max(1, Math.floor((gapMs * weight) / totalWeight));
			}
			const sentence = chapter.sentences[index];
			if (!sentence || endMs <= startMs) continue;
			timings[index] = {
				sentence,
				audioFileIndex: audio.audioFileIndex,
				startMs,
				endMs,
				evidence: {
					kind: "interpolated",
					basis: mode === "complete" ? "speech" : "wall-clock",
				},
			};
			cursor = endMs;
		}
	}
}

function speechOffsetToWallTime(
	regions: Array<{ startMs: number; endMs: number }>,
	offsetMs: number,
	edge: "start" | "end",
): number {
	let elapsedMs = 0;
	for (const [index, region] of regions.entries()) {
		const durationMs = region.endMs - region.startMs;
		const regionEndOffset = elapsedMs + durationMs;
		if (offsetMs < regionEndOffset) {
			return region.startMs + (offsetMs - elapsedMs);
		}
		if (offsetMs === regionEndOffset) {
			if (edge === "end" || index === regions.length - 1) return region.endMs;
			return regions[index + 1]?.startMs ?? region.endMs;
		}
		elapsedMs = regionEndOffset;
	}
	return regions.at(-1)?.endMs ?? 0;
}

function reconcileTimingOverlaps(timings: SentenceTiming[]): SentenceTiming[] {
	const ordered = timings
		.map((timing) => ({ ...timing }))
		.sort(
			(left, right) =>
				left.audioFileIndex - right.audioFileIndex ||
				left.startMs - right.startMs ||
				left.endMs - right.endMs,
		);
	for (let index = 1; index < ordered.length; index += 1) {
		const previous = ordered[index - 1];
		const current = ordered[index];
		if (
			!previous ||
			!current ||
			previous.audioFileIndex !== current.audioFileIndex ||
			current.startMs >= previous.endMs
		) {
			continue;
		}
		const midpoint = Math.floor((previous.endMs + current.startMs) / 2);
		const boundary = Math.min(
			current.endMs - 1,
			Math.max(previous.startMs + 1, midpoint),
		);
		if (boundary <= previous.startMs || boundary >= current.endMs) {
			throw new Error(
				`Could not reconcile non-monotonic cues ${previous.sentence.id} and ${current.sentence.id}`,
			);
		}
		previous.endMs = boundary;
		current.startMs = boundary;
	}
	return ordered;
}

function alignChapter(
	match: ChapterMatch,
	audioEnd: number,
	hasFollowingMatch: boolean,
	interpolationMode: InterpolationMode,
): SentenceTiming[] {
	const pairsByBook = new Map<
		number,
		Array<{ audioIndex: number; exact: boolean }>
	>();
	let audioCursor = match.audioStart;
	let previousAnchor = match.audioStart;
	const windows = planFineAlignmentWindows(
		match.chapter.sentenceRanges,
		match.chapter.tokens.length,
	);
	for (const [windowIndex, window] of windows.entries()) {
		const bookTokens = match.chapter.tokens.slice(
			window.bookStart,
			window.bookEnd,
		);
		const expectedStart = hasFollowingMatch
			? match.audioStart +
				Math.floor(
					((audioEnd - match.audioStart) * window.bookStart) /
						match.chapter.tokens.length,
				)
			: audioCursor;
		const minimumStart = hasFollowingMatch
			? Math.max(
					match.audioStart,
					previousAnchor + (windowIndex === 0 ? 0 : 1),
					expectedStart - FINE_ANCHOR_SEARCH_TOKENS,
				)
			: Math.max(match.audioStart, audioCursor - FINE_ANCHOR_BACKTRACK_TOKENS);
		const anchor =
			windowIndex === 0
				? match.audioStart
				: (voteForStart(
						bookTokens.slice(0, CHAPTER_PREFIX_TOKENS),
						match.audio,
						minimumStart,
						Math.min(audioEnd - 1, expectedStart + FINE_ANCHOR_SEARCH_TOKENS),
						expectedStart,
					)?.start ??
					Math.max(
						hasFollowingMatch ? previousAnchor + 1 : audioCursor,
						expectedStart,
					));
		if (anchor >= audioEnd) break;
		previousAnchor = anchor;
		const fineWindowLength = Math.max(
			Math.ceil(bookTokens.length * FINE_WINDOW_RATIO),
			bookTokens.length + FINE_WINDOW_PADDING_TOKENS,
		);
		const audioTokens = match.audio.tokens.slice(
			anchor,
			Math.min(anchor + fineWindowLength, audioEnd),
		);
		const pairs = alignTokenSequences(
			bookTokens,
			audioTokens.map((token) => token.value),
		);
		for (const pair of pairs) {
			const bookIndex = window.bookStart + pair.bookIndex;
			const related = pairsByBook.get(bookIndex) ?? [];
			related.push({ audioIndex: anchor + pair.audioIndex, exact: pair.exact });
			pairsByBook.set(bookIndex, related);
		}
		const lastExactPair = pairs.findLast((pair) => pair.exact);
		if (lastExactPair) {
			audioCursor = anchor + lastExactPair.audioIndex + 1;
		}
	}
	const timings: Array<SentenceTiming | undefined> =
		match.chapter.sentences.map(() => undefined);

	for (const [sentenceIndex, range] of match.chapter.sentenceRanges.entries()) {
		const sentence = match.chapter.sentences[sentenceIndex];
		if (!sentence) continue;
		const related = Array.from(
			{ length: Math.max(0, range.end - range.start) },
			(_, offset) => pairsByBook.get(range.start + offset) ?? [],
		).flat();
		const exactCount = related.filter((pair) => pair.exact).length;
		const minExact = sentence.tokens.length <= 2 ? 1 : 2;
		if (exactCount < minExact || related.length === 0) continue;
		const first = match.audio.tokens[related[0]?.audioIndex ?? -1];
		const last = match.audio.tokens[related.at(-1)?.audioIndex ?? -1];
		if (!first || !last || last.endMs <= first.startMs) continue;
		const audioSpan =
			(related.at(-1)?.audioIndex ?? 0) - (related[0]?.audioIndex ?? 0) + 1;
		const score = exactCount / Math.max(sentence.tokens.length, audioSpan);
		if (score < 0.25) continue;
		timings[sentenceIndex] = {
			sentence,
			audioFileIndex: match.audio.audioFileIndex,
			startMs: first.startMs,
			endMs: last.endMs,
			evidence: { kind: "direct", score },
		};
	}

	const chapterStartMs =
		match.audio.tokens[match.audioStart]?.startMs ?? match.audio.startMs;
	const chapterEndMs =
		match.audio.tokens[audioEnd]?.startMs ?? match.audio.endMs;
	interpolateMissingTimings(
		match.chapter,
		timings,
		interpolationMode,
		match.audio,
		chapterStartMs,
		chapterEndMs,
	);
	return timings.filter((timing): timing is SentenceTiming => Boolean(timing));
}

export function alignSentencesToTranscripts(
	sentences: AddressableSentence[],
	transcripts: HonomiyaTranscript[],
	language?: string,
	options: AlignmentOptions = {},
): AlignmentResult {
	const interpolationMode = options.interpolationMode ?? "conservative";
	if (
		interpolationMode === "complete" &&
		transcripts.some((transcript) => transcript.speechTimeline === undefined)
	) {
		throw new Error(
			"Complete interpolation requires a speechTimeline in every transcript; use --quality fast or --interpolation conservative for an older transcript",
		);
	}
	const chapters = groupChapters(sentences);
	const audio = transcripts.map((transcript, audioFileIndex) => {
		const tokens = transcriptTimedTokens(transcript, audioFileIndex, language);
		const values = tokens.map((token) => token.value);
		return {
			audioFileIndex,
			tokens,
			values,
			ngramIndex: buildNgramIndex(values),
			startMs: transcript.offsetMs,
			endMs: transcript.offsetMs + transcript.durationMs,
			speechTimeline: transcript.speechTimeline ?? [],
		};
	});
	const matches = mapChapters(chapters, audio);
	const matchBySection = new Map(
		matches.map((match) => [match.chapter.sectionRef, match]),
	);
	const timings = reconcileTimingOverlaps(
		matches.flatMap((match, index) => {
			const nextMatch = matches
				.slice(index + 1)
				.find(
					(candidate) =>
						candidate.audio.audioFileIndex === match.audio.audioFileIndex,
				);
			return alignChapter(
				match,
				nextMatch?.audioStart ?? match.audio.tokens.length,
				Boolean(nextMatch),
				interpolationMode,
			);
		}),
	);
	const cues = timings
		.map(({ sentence, audioFileIndex, startMs, endMs, evidence }) => ({
			cue: {
				id: sentence.id,
				text: sentence.anchor,
				audioFileIndex,
				startMs,
				endMs,
			},
			evidence,
			text: sentence.text,
		}))
		.sort(
			(left, right) =>
				left.cue.audioFileIndex - right.cue.audioFileIndex ||
				left.cue.startMs - right.cue.startMs,
		);

	const chaptersReport = chapters.map((chapter) => {
		const match = matchBySection.get(chapter.sectionRef);
		const chapterCues = cues.filter(
			({ cue }) => cue.text.sectionRef === chapter.sectionRef,
		);
		const directCues = chapterCues.filter(
			({ evidence }) => evidence.kind === "direct",
		).length;
		const interpolatedCues = chapterCues.length - directCues;
		return {
			sectionRef: chapter.sectionRef,
			...(match
				? {
						audioFileIndex: match.audio.audioFileIndex,
						chapterScore: match.score,
					}
				: {}),
			sentences: chapter.sentences.length,
			directCues,
			interpolatedCues,
			unmatchedSentences: chapter.sentences.length - chapterCues.length,
		};
	});
	const directCues = cues.filter(
		({ evidence }) => evidence.kind === "direct",
	).length;
	const interpolatedCues = cues.length - directCues;
	const usedAudio = new Set(matches.map((match) => match.audio.audioFileIndex));
	return {
		cues,
		report: {
			bookSentences: sentences.length,
			directCues,
			interpolatedCues,
			unmatchedSentences: sentences.length - cues.length,
			bookCoverage: sentences.length > 0 ? cues.length / sentences.length : 0,
			directCoverage: sentences.length > 0 ? directCues / sentences.length : 0,
			unmatchedAudioFiles: audio
				.map((track) => track.audioFileIndex)
				.filter((index) => !usedAudio.has(index)),
			chapters: chaptersReport,
		},
	};
}

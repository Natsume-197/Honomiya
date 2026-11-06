import { type CtcEmissions, greedyDecode } from "./emissions";
import { type ConditionedText, STAR, type VocabularyIndex } from "./text";

/**
 * Boundary search: finds where each ebook chapter is narrated, and a chain of
 * anchors (book token ↔ audio frame) inside it, before any forced alignment.
 *
 * The emissions of every track are greedy-decoded onto one global frame axis.
 * Both the decode and the book are reduced to class-set tokens, and an anchor
 * candidate is an n-gram that occurs exactly once in the whole book and
 * exactly once in the whole decode. Each chapter then keeps the longest chain
 * of candidates that moves forward in both text and audio at a plausible
 * speaking rate. Chapters are placed best-first, and a placed chapter's audio
 * is unavailable to the rest, so reordered, missing and repeated chapters
 * resolve without assuming the ebook and audiobook share an order.
 */

export const BOUNDARY_SEARCH_VERSION = "honomiya.ctc-search.v1" as const;

export interface SearchDecode {
	/** Class-set ids of the greedy decode, STAR-free. */
	tokens: Int32Array;
	/** Global frame of each decoded token. */
	frames: Int32Array;
	/** Global frame where each track starts; the last entry is the total. */
	trackStartFrames: number[];
}

/** Greedy-decodes every track onto one global frame axis. */
export function decodeForSearch(
	tracks: CtcEmissions[],
	index: VocabularyIndex,
): SearchDecode {
	const tokens: number[] = [];
	const frames: number[] = [];
	const trackStartFrames: number[] = [];
	let offset = 0;
	for (const track of tracks) {
		trackStartFrames.push(offset);
		const decoded = greedyDecode(track);
		let position = 0;
		for (const character of decoded.text) {
			const token = index.tokenFor(character);
			const frame = decoded.frames[position] ?? 0;
			position += 1;
			if (token === STAR) continue;
			tokens.push(token);
			frames.push(offset + track.header.startFrame + frame);
		}
		offset += track.header.startFrame + track.header.frames;
	}
	trackStartFrames.push(offset);
	return {
		tokens: Int32Array.from(tokens),
		frames: Int32Array.from(frames),
		trackStartFrames,
	};
}

export interface ChapterSpan {
	/** Book tokens [tokenStart, tokenEnd) of the chapter. */
	tokenStart: number;
	tokenEnd: number;
}

/** Groups conditioned tokens into chapters by a key per sentence. */
export function chapterSpans(
	text: ConditionedText,
	chapterOfSentence: (sentence: number) => string,
): ChapterSpan[] {
	const spans: ChapterSpan[] = [];
	let currentKey: string | undefined;
	for (let token = 0; token < text.tokens.length; token += 1) {
		const key = chapterOfSentence(text.sentence[token] ?? 0);
		if (key !== currentKey) {
			spans.push({ tokenStart: token, tokenEnd: token + 1 });
			currentKey = key;
		} else {
			const last = spans.at(-1);
			if (last) last.tokenEnd = token + 1;
		}
	}
	return spans;
}

export interface Anchor {
	/** First book token of the matched n-gram. */
	token: number;
	/** Global frame of the matched n-gram's first decoded character. */
	frame: number;
}

export interface ChapterLocation extends ChapterSpan {
	chapter: number;
	status: "found" | "not-found";
	/**
	 * Global frames [startFrame, endFrame) that contain the narration: a
	 * generous window for the forced aligner, not a precise boundary.
	 */
	startFrame?: number;
	endFrame?: number;
	anchors: Anchor[];
	/** Anchors kept, over the chapter's anchor candidates. */
	confidence: number;
	/** Share of the chapter's tokens between its first and last anchor. */
	coverage: number;
	/** Anchor candidates found, and those left after placed chapters. */
	candidates: number;
	freeCandidates: number;
}

export interface BoundarySearchOptions {
	ngram: number;
	/** Plausible speaking rate, in frames per book token. */
	minFramesPerToken: number;
	maxFramesPerToken: number;
	/** Rate tolerance between neighbouring anchors, in frames. */
	slackFrames: number;
	/** Longest stretch of book tokens two chained anchors may span. */
	maxTokenGap: number;
	minCoverage: number;
	/**
	 * How far past the extrapolated chapter edges the narration may start or
	 * end (titles, pauses, music), in frames. Neighbouring chapters' anchors
	 * always bound it.
	 */
	edgeSearchFrames: number;
}

export const DEFAULT_BOUNDARY_SEARCH_OPTIONS: BoundarySearchOptions = {
	ngram: 6,
	minFramesPerToken: 2,
	maxFramesPerToken: 25,
	slackFrames: 150,
	maxTokenGap: 4_000,
	minCoverage: 0.3,
	edgeSearchFrames: 3_000,
};

interface Candidate {
	token: number;
	decodeIndex: number;
	frame: number;
}

function gramKey(tokens: Int32Array, start: number, n: number): string | undefined {
	let key = "";
	for (let offset = 0; offset < n; offset += 1) {
		const token = tokens[start + offset];
		if (token === undefined || token === STAR) return undefined;
		key += offset === 0 ? `${token}` : `,${token}`;
	}
	return key;
}

/** Positions of n-grams that occur exactly once; others map to -1. */
function uniqueGrams(tokens: Int32Array, n: number): Map<string, number> {
	const grams = new Map<string, number>();
	for (let start = 0; start + n <= tokens.length; start += 1) {
		const key = gramKey(tokens, start, n);
		if (key === undefined) continue;
		grams.set(key, grams.has(key) ? -1 : start);
	}
	return grams;
}

/** Longest chain moving forward in text and audio at a plausible rate. */
export function longestAnchorChain(
	candidates: Candidate[],
	options: BoundarySearchOptions,
): Candidate[] {
	const length = new Int32Array(candidates.length);
	const previous = new Int32Array(candidates.length).fill(-1);
	let bestEnd = -1;
	for (let j = 0; j < candidates.length; j += 1) {
		const b = candidates[j] as Candidate;
		length[j] = 1;
		for (let i = j - 1; i >= 0; i -= 1) {
			const a = candidates[i] as Candidate;
			const tokenGap = b.token - a.token;
			if (tokenGap > options.maxTokenGap) break;
			if (tokenGap <= 0 || b.decodeIndex <= a.decodeIndex) continue;
			const frameGap = b.frame - a.frame;
			if (
				frameGap < options.minFramesPerToken * tokenGap - options.slackFrames ||
				frameGap > options.maxFramesPerToken * tokenGap + options.slackFrames
			) {
				continue;
			}
			if ((length[i] ?? 0) + 1 > (length[j] ?? 0)) {
				length[j] = (length[i] ?? 0) + 1;
				previous[j] = i;
			}
		}
		if (bestEnd === -1 || (length[j] ?? 0) > (length[bestEnd] ?? 0)) bestEnd = j;
	}
	const chain: Candidate[] = [];
	for (let at = bestEnd; at !== -1; at = previous[at] ?? -1) {
		chain.push(candidates[at] as Candidate);
	}
	return chain.reverse();
}

function minimumAnchors(chapterTokens: number): number {
	return Math.min(8, Math.max(2, Math.floor(chapterTokens / 30)));
}

/** Rate (frames per token) fitted over the anchors at one end of a chain. */
function edgeRate(chain: Anchor[], fromEnd: boolean, fallback: number): number {
	const window = fromEnd ? chain.slice(-20) : chain.slice(0, 20);
	const first = window[0];
	const last = window.at(-1);
	if (!first || !last || last.token === first.token) return fallback;
	return (last.frame - first.frame) / (last.token - first.token);
}

export function locateChapters(
	text: ConditionedText,
	chapters: ChapterSpan[],
	decode: SearchDecode,
	options: BoundarySearchOptions = DEFAULT_BOUNDARY_SEARCH_OPTIONS,
): ChapterLocation[] {
	const n = options.ngram;
	const bookGrams = uniqueGrams(text.tokens, n);
	const decodeGrams = uniqueGrams(decode.tokens, n);
	const totalFrames = decode.trackStartFrames.at(-1) ?? 0;

	const candidatesOf = chapters.map((chapter) => {
		const candidates: Candidate[] = [];
		for (let token = chapter.tokenStart; token + n <= chapter.tokenEnd; token += 1) {
			const key = gramKey(text.tokens, token, n);
			if (key === undefined || bookGrams.get(key) !== token) continue;
			const decodeIndex = decodeGrams.get(key);
			if (decodeIndex === undefined || decodeIndex < 0) continue;
			candidates.push({ token, decodeIndex, frame: decode.frames[decodeIndex] ?? 0 });
		}
		return candidates;
	});

	// Place chapters best-first; placed narration is unavailable to the rest.
	const firstChains = candidatesOf.map((candidates) => longestAnchorChain(candidates, options));
	const order = chapters
		.map((_, chapter) => chapter)
		.sort((a, b) => (firstChains[b]?.length ?? 0) - (firstChains[a]?.length ?? 0) || a - b);
	const occupied: Array<{ start: number; end: number }> = [];
	const locations: ChapterLocation[] = chapters.map((chapter, index) => ({
		...chapter,
		chapter: index,
		status: "not-found",
		anchors: [],
		confidence: 0,
		coverage: 0,
		candidates: candidatesOf[index]?.length ?? 0,
		freeCandidates: 0,
	}));

	for (const chapterIndex of order) {
		const chapter = chapters[chapterIndex] as ChapterSpan;
		const free = (candidatesOf[chapterIndex] ?? []).filter(
			(candidate) =>
				!occupied.some((range) => candidate.frame >= range.start && candidate.frame < range.end),
		);
		const chain = longestAnchorChain(free, options);
		const chapterTokens = chapter.tokenEnd - chapter.tokenStart;
		const first = chain[0];
		const last = chain.at(-1);
		const coverage = first && last ? (last.token + n - first.token) / chapterTokens : 0;
		const location = locations[chapterIndex] as ChapterLocation;
		location.freeCandidates = free.length;
		location.confidence = free.length > 0 ? chain.length / free.length : 0;
		location.coverage = Math.min(1, coverage);
		if (!first || !last || chain.length < minimumAnchors(chapterTokens) || coverage < options.minCoverage) {
			continue;
		}

		location.status = "found";
		location.anchors = chain.map(({ token, frame }) => ({ token, frame }));
		occupied.push({ start: first.frame, end: last.frame + 1 });
	}

	// Edges: extrapolate past the outer anchors at the local speaking rate,
	// widen by the edge search margin, and stop at the neighbouring chapters'
	// anchors. The forced aligner finds the exact start and end inside.
	const placed = locations
		.filter((location) => location.status === "found")
		.sort((a, b) => (a.anchors[0]?.frame ?? 0) - (b.anchors[0]?.frame ?? 0));
	for (const [position, location] of placed.entries()) {
		const chain = location.anchors;
		const first = chain[0] as Anchor;
		const last = chain.at(-1) as Anchor;
		const overallRate =
			last.token > first.token
				? (last.frame - first.frame) / (last.token - first.token)
				: (options.minFramesPerToken + options.maxFramesPerToken) / 2;
		const startRate = edgeRate(chain, false, overallRate);
		const endRate = edgeRate(chain, true, overallRate);
		const previousLast = placed[position - 1]?.anchors.at(-1)?.frame;
		const nextFirst = placed[position + 1]?.anchors[0]?.frame;
		const extrapolatedStart = first.frame - startRate * (first.token - location.tokenStart);
		const extrapolatedEnd = last.frame + endRate * (location.tokenEnd - last.token);
		location.startFrame = Math.round(
			Math.max(
				0,
				previousLast === undefined ? 0 : previousLast + 1,
				extrapolatedStart - options.edgeSearchFrames,
			),
		);
		location.endFrame = Math.round(
			Math.max(
				last.frame + 1,
				Math.min(totalFrames, nextFirst ?? totalFrames, extrapolatedEnd + options.edgeSearchFrames),
			),
		);
	}
	return locations;
}

/** Converts a global frame to its track and the frame inside that track. */
export function trackFrame(
	decode: Pick<SearchDecode, "trackStartFrames">,
	globalFrame: number,
): { track: number; frame: number } {
	const starts = decode.trackStartFrames;
	for (let track = starts.length - 2; track >= 0; track -= 1) {
		const start = starts[track] ?? 0;
		if (globalFrame >= start) return { track, frame: globalFrame - start };
	}
	return { track: 0, frame: globalFrame };
}

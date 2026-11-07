import { type CtcEmissions, SCORE_SCALE } from "./emissions";
import { STAR } from "./text";

/**
 * CTC forced alignment of a token sequence to a span of frames.
 *
 * States interleave blanks with tokens (blank, t0, blank, t1, …, blank).
 * Each frame a path may stay, advance one state, or skip the blank between
 * two different tokens. Tokens are class sets: a token scores the best of its
 * classes in that frame. STAR tokens (characters the model cannot emit) score
 * a constant.
 */

export const STAR_SCORE = -3;
const MIN_SCORE = -32_768 / SCORE_SCALE;

/** Global-frame access to the sparse emissions of every track. */
export class EmissionReader {
	private readonly starts: number[] = [];
	constructor(readonly tracks: CtcEmissions[]) {
		let offset = 0;
		for (const track of tracks) {
			this.starts.push(offset + track.header.startFrame);
			offset += track.header.startFrame + track.header.frames;
		}
		this.totalFrames = offset;
	}

	readonly totalFrames: number;

	locate(globalFrame: number): { track: CtcEmissions; frame: number } | undefined {
		for (let index = this.tracks.length - 1; index >= 0; index -= 1) {
			const start = this.starts[index] ?? 0;
			const track = this.tracks[index] as CtcEmissions;
			if (globalFrame >= start) {
				const frame = globalFrame - start;
				return frame < track.header.frames ? { track, frame } : undefined;
			}
		}
		return undefined;
	}
}

export interface SegmentScores {
	frames: number;
	/** Columns per frame: one per distinct class set, then STAR last. */
	width: number;
	scores: Float32Array;
	blank: Float32Array;
	/** Column of every token of the segment. */
	tokenColumn: Int32Array;
}

/**
 * Dense scores for one segment, only for the class sets it uses. Classes not
 * stored for a frame score that frame's floor (its lowest stored score).
 */
export function segmentScores(
	reader: EmissionReader,
	classSets: Int32Array[],
	tokens: Int32Array,
	startFrame: number,
	endFrame: number,
): SegmentScores {
	const columns = new Map<number, number>();
	for (const token of tokens) {
		if (token !== STAR && !columns.has(token)) columns.set(token, columns.size);
	}
	const width = columns.size + 1;
	const starColumn = columns.size;
	// Which columns each class contributes to.
	const columnsOfClass = new Map<number, number[]>();
	for (const [set, column] of columns) {
		for (const classId of classSets[set] ?? []) {
			const list = columnsOfClass.get(classId);
			if (list) list.push(column);
			else columnsOfClass.set(classId, [column]);
		}
	}
	const frames = Math.max(0, endFrame - startFrame);
	const scores = new Float32Array(frames * width);
	const blank = new Float32Array(frames);
	for (let frame = 0; frame < frames; frame += 1) {
		const row = frame * width;
		const located = reader.locate(startFrame + frame);
		if (!located) {
			scores.fill(MIN_SCORE, row, row + width);
			scores[row + starColumn] = STAR_SCORE;
			blank[frame] = 0;
			continue;
		}
		const { track, frame: local } = located;
		const topK = track.header.topK;
		const offset = local * topK;
		const floor = (track.scores[offset + topK - 1] ?? -32_768) / SCORE_SCALE;
		scores.fill(floor, row, row + width);
		for (let k = 0; k < topK; k += 1) {
			const targets = columnsOfClass.get(track.classes[offset + k] ?? -1);
			if (!targets) continue;
			const score = (track.scores[offset + k] ?? -32_768) / SCORE_SCALE;
			for (const column of targets) {
				if (score > (scores[row + column] ?? MIN_SCORE)) scores[row + column] = score;
			}
		}
		scores[row + starColumn] = STAR_SCORE;
		blank[frame] = (track.blank[local] ?? -32_768) / SCORE_SCALE;
	}
	const tokenColumn = Int32Array.from(tokens, (token) =>
		token === STAR ? starColumn : (columns.get(token) ?? starColumn),
	);
	return { frames, width, scores, blank, tokenColumn };
}

export interface ForcedAlignment {
	/** Frame (relative to the segment) of each token's first and last frame. */
	firstFrame: Int32Array;
	lastFrame: Int32Array;
	/** Mean log probability over each token's own frames. */
	tokenScore: Float32Array;
	/** Path score, or -Infinity when no path fits. */
	score: number;
}

const STAY = 0;
const NEXT = 1;
const SKIP = 2;
const FRESH = 3;

/**
 * Viterbi over one segment. With `freeStart`, leading frames are free (the
 * text may start late in the segment); with `freeEnd`, trailing frames are
 * free. Otherwise the path covers the segment exactly.
 */
export function forcedAlign(
	segment: SegmentScores,
	tokens: Int32Array,
	options: { freeStart?: boolean; freeEnd?: boolean } = {},
): ForcedAlignment {
	const { frames: T, width, scores, blank, tokenColumn } = segment;
	const L = tokens.length;
	const S = 2 * L + 1;
	const firstFrame = new Int32Array(L).fill(-1);
	const lastFrame = new Int32Array(L).fill(-1);
	const tokenScore = new Float32Array(L).fill(Number.NEGATIVE_INFINITY);
	if (L === 0 || T === 0) {
		return { firstFrame, lastFrame, tokenScore, score: L === 0 ? 0 : Number.NEGATIVE_INFINITY };
	}

	// Column read by each state; blank states read the blank row (-1).
	const stateColumn = new Int32Array(S).fill(-1);
	const canSkip = new Uint8Array(S);
	for (let token = 0; token < L; token += 1) {
		const state = 2 * token + 1;
		stateColumn[state] = tokenColumn[token] ?? width - 1;
		if (token > 0) {
			const previous = tokens[token - 1];
			const current = tokens[token];
			canSkip[state] = current !== previous || current === STAR ? 1 : 0;
		}
	}

	const back = new Uint8Array(T * S);
	let previous = new Float32Array(S).fill(Number.NEGATIVE_INFINITY);
	let current = new Float32Array(S);
	previous[0] = blank[0] ?? 0;
	previous[1] = scores[stateColumn[1] ?? 0] ?? MIN_SCORE;
	back[0] = FRESH;
	back[1] = FRESH;
	let bestEnd = { score: Number.NEGATIVE_INFINITY, frame: -1, state: -1 };
	const considerEnd = (frame: number, row: Float32Array) => {
		for (const state of [S - 1, S - 2]) {
			const score = row[state] ?? Number.NEGATIVE_INFINITY;
			if (score > bestEnd.score) bestEnd = { score, frame, state };
		}
	};
	if (options.freeEnd || T === 1) considerEnd(0, previous);

	for (let t = 1; t < T; t += 1) {
		const row = t * width;
		const blankScore = blank[t] ?? 0;
		const backRow = t * S;
		// Paths can only have reached states up to 2t+1 by frame t.
		const reachable = Math.min(S, 2 * t + 2);
		for (let s = 0; s < reachable; s += 1) {
			let score = previous[s] ?? Number.NEGATIVE_INFINITY;
			let from = STAY;
			if (s > 0) {
				const advance = previous[s - 1] ?? Number.NEGATIVE_INFINITY;
				if (advance > score) {
					score = advance;
					from = NEXT;
				}
				if (canSkip[s] === 1) {
					const skip = previous[s - 2] ?? Number.NEGATIVE_INFINITY;
					if (skip > score) {
						score = skip;
						from = SKIP;
					}
				}
			}
			if (options.freeStart && s <= 1 && score < 0) {
				score = 0;
				from = FRESH;
			}
			const column = stateColumn[s] ?? -1;
			current[s] = score + (column < 0 ? blankScore : (scores[row + column] ?? MIN_SCORE));
			back[backRow + s] = from;
		}
		for (let s = reachable; s < S; s += 1) current[s] = Number.NEGATIVE_INFINITY;
		if (options.freeEnd || t === T - 1) considerEnd(t, current);
		[previous, current] = [current, previous];
	}

	if (bestEnd.state < 0 || bestEnd.score === Number.NEGATIVE_INFINITY) {
		return { firstFrame, lastFrame, tokenScore, score: Number.NEGATIVE_INFINITY };
	}
	const scoreSum = new Float64Array(L);
	const scoreFrames = new Int32Array(L);
	let state = bestEnd.state;
	for (let t = bestEnd.frame; t >= 0; t -= 1) {
		if (state % 2 === 1) {
			const token = (state - 1) / 2;
			firstFrame[token] = t;
			if (lastFrame[token] === -1) lastFrame[token] = t;
			scoreSum[token] = (scoreSum[token] ?? 0) + (scores[t * width + (stateColumn[state] ?? 0)] ?? 0);
			scoreFrames[token] = (scoreFrames[token] ?? 0) + 1;
		}
		const from = back[t * S + state] ?? STAY;
		if (from === FRESH) break;
		state -= from === STAY ? 0 : from;
	}
	for (let token = 0; token < L; token += 1) {
		const count = scoreFrames[token] ?? 0;
		if (count > 0) tokenScore[token] = (scoreSum[token] ?? 0) / count;
	}
	return { firstFrame, lastFrame, tokenScore, score: bestEnd.score };
}

const MATCH_SCORE = 1;
const MISMATCH_SCORE = -0.6;
const GAP_OPEN_SCORE = -0.8;
const GAP_EXTENSION_SCORE = -0.5;
const INITIAL_BAND = 128;

const MATCH = 1;
const GAP_IN_AUDIO = 2;
const GAP_IN_BOOK = 3;

export interface SequenceAlignmentPair {
	bookIndex: number;
	audioIndex: number;
	exact: boolean;
}

interface AlignmentAttempt {
	pairs: SequenceAlignmentPair[];
	touchedBandEdge: boolean;
}

interface DirectionRow {
	start: number;
	end: number;
	matchPreviousStates: Uint8Array;
	gapInAudioPreviousStates: Uint8Array;
	gapInBookPreviousStates: Uint8Array;
}

function rowValue(
	scores: Float64Array,
	start: number,
	end: number,
	column: number,
): number {
	return column >= start && column <= end
		? (scores[column - start] ?? Number.NEGATIVE_INFINITY)
		: Number.NEGATIVE_INFINITY;
}

function bestState(
	match: number,
	gapInAudio: number,
	gapInBook: number,
): { score: number; state: number } {
	if (match >= gapInAudio && match >= gapInBook) {
		return { score: match, state: MATCH };
	}
	if (gapInAudio >= gapInBook) {
		return { score: gapInAudio, state: GAP_IN_AUDIO };
	}
	return { score: gapInBook, state: GAP_IN_BOOK };
}

function alignWithBand(
	book: string[],
	audio: string[],
	band: number,
): AlignmentAttempt {
	const rows: DirectionRow[] = [];
	let previousStart = 0;
	let previousEnd = Math.min(audio.length, band);
	let previousMatch = new Float64Array(previousEnd + 1);
	let previousGapInAudio = new Float64Array(previousEnd + 1);
	let previousGapInBook = new Float64Array(previousEnd + 1);
	previousMatch.fill(Number.NEGATIVE_INFINITY);
	previousGapInAudio.fill(Number.NEGATIVE_INFINITY);
	previousGapInBook.fill(Number.NEGATIVE_INFINITY);
	previousMatch[0] = 0;
	const initialGapInBookPreviousStates = new Uint8Array(previousEnd + 1);
	for (let column = 1; column <= previousEnd; column += 1) {
		previousGapInBook[column] =
			GAP_OPEN_SCORE + (column - 1) * GAP_EXTENSION_SCORE;
		initialGapInBookPreviousStates[column] = column === 1 ? MATCH : GAP_IN_BOOK;
	}
	rows.push({
		start: previousStart,
		end: previousEnd,
		matchPreviousStates: new Uint8Array(previousEnd + 1),
		gapInAudioPreviousStates: new Uint8Array(previousEnd + 1),
		gapInBookPreviousStates: initialGapInBookPreviousStates,
	});

	for (let row = 1; row <= book.length; row += 1) {
		const center = Math.round((row * audio.length) / book.length);
		const start = Math.max(0, center - band);
		const end = Math.min(audio.length, center + band);
		const matchScores = new Float64Array(end - start + 1);
		const gapInAudioScores = new Float64Array(end - start + 1);
		const gapInBookScores = new Float64Array(end - start + 1);
		matchScores.fill(Number.NEGATIVE_INFINITY);
		gapInAudioScores.fill(Number.NEGATIVE_INFINITY);
		gapInBookScores.fill(Number.NEGATIVE_INFINITY);
		const matchPreviousStates = new Uint8Array(matchScores.length);
		const gapInAudioPreviousStates = new Uint8Array(matchScores.length);
		const gapInBookPreviousStates = new Uint8Array(matchScores.length);

		for (let column = start; column <= end; column += 1) {
			const position = column - start;
			const up = bestState(
				rowValue(previousMatch, previousStart, previousEnd, column) +
					GAP_OPEN_SCORE,
				rowValue(previousGapInAudio, previousStart, previousEnd, column) +
					GAP_EXTENSION_SCORE,
				rowValue(previousGapInBook, previousStart, previousEnd, column) +
					GAP_OPEN_SCORE,
			);
			gapInAudioScores[position] = up.score;
			gapInAudioPreviousStates[position] = up.state;

			if (column > 0) {
				const diagonal = bestState(
					rowValue(previousMatch, previousStart, previousEnd, column - 1),
					rowValue(previousGapInAudio, previousStart, previousEnd, column - 1),
					rowValue(previousGapInBook, previousStart, previousEnd, column - 1),
				);
				matchScores[position] =
					diagonal.score +
					(book[row - 1] === audio[column - 1] ? MATCH_SCORE : MISMATCH_SCORE);
				matchPreviousStates[position] = diagonal.state;

				const leftPosition = position - 1;
				const left = bestState(
					(leftPosition >= 0
						? (matchScores[leftPosition] ?? Number.NEGATIVE_INFINITY)
						: Number.NEGATIVE_INFINITY) + GAP_OPEN_SCORE,
					(leftPosition >= 0
						? (gapInAudioScores[leftPosition] ?? Number.NEGATIVE_INFINITY)
						: Number.NEGATIVE_INFINITY) + GAP_OPEN_SCORE,
					(leftPosition >= 0
						? (gapInBookScores[leftPosition] ?? Number.NEGATIVE_INFINITY)
						: Number.NEGATIVE_INFINITY) + GAP_EXTENSION_SCORE,
				);
				gapInBookScores[position] = left.score;
				gapInBookPreviousStates[position] = left.state;
			}
		}

		rows.push({
			start,
			end,
			matchPreviousStates,
			gapInAudioPreviousStates,
			gapInBookPreviousStates,
		});
		previousMatch = matchScores;
		previousGapInAudio = gapInAudioScores;
		previousGapInBook = gapInBookScores;
		previousStart = start;
		previousEnd = end;
	}

	const pairs: SequenceAlignmentPair[] = [];
	let row = book.length;
	let column = audio.length;
	let state = bestState(
		rowValue(previousMatch, previousStart, previousEnd, column),
		rowValue(previousGapInAudio, previousStart, previousEnd, column),
		rowValue(previousGapInBook, previousStart, previousEnd, column),
	).state;
	let touchedBandEdge = false;
	while (row > 0 || column > 0) {
		const directionRow = rows[row];
		if (!directionRow) {
			throw new Error("Alignment path left the computed band");
		}
		if (
			(directionRow.start > 0 && column === directionRow.start) ||
			(directionRow.end < audio.length && column === directionRow.end)
		) {
			touchedBandEdge = true;
		}
		const position = column - directionRow.start;
		if (column < directionRow.start || column > directionRow.end) {
			throw new Error("Alignment path left the computed band");
		}

		if (row > 0 && column > 0 && state === MATCH) {
			pairs.push({
				bookIndex: row - 1,
				audioIndex: column - 1,
				exact: book[row - 1] === audio[column - 1],
			});
			state = directionRow.matchPreviousStates[position] ?? 0;
			row -= 1;
			column -= 1;
		} else if (row > 0 && state === GAP_IN_AUDIO) {
			state = directionRow.gapInAudioPreviousStates[position] ?? 0;
			row -= 1;
		} else if (column > 0 && state === GAP_IN_BOOK) {
			state = directionRow.gapInBookPreviousStates[position] ?? 0;
			column -= 1;
		} else {
			throw new Error("Could not reconstruct sequence alignment");
		}
	}

	return { pairs: pairs.reverse(), touchedBandEdge };
}

export function alignTokenSequences(
	book: string[],
	audio: string[],
): SequenceAlignmentPair[] {
	if (book.length === 0 || audio.length === 0) return [];
	let band = Math.max(
		INITIAL_BAND,
		Math.abs(book.length - audio.length) + 32,
		Math.ceil(Math.max(book.length, audio.length) * 0.15),
	);
	const fullBand = Math.max(book.length, audio.length);

	while (true) {
		const attempt = alignWithBand(book, audio, Math.min(band, fullBand));
		if (!attempt.touchedBandEdge || band >= fullBand) return attempt.pairs;
		band = Math.min(fullBand, band * 2);
	}
}

export function tokenEditSimilarity(left: string[], right: string[]): number {
	if (left.length === 0 || right.length === 0) {
		return left.length === right.length ? 1 : 0;
	}
	let previous = new Uint32Array(right.length + 1);
	for (let column = 0; column <= right.length; column += 1) {
		previous[column] = column;
	}

	for (let row = 1; row <= left.length; row += 1) {
		const current = new Uint32Array(right.length + 1);
		current[0] = row;
		for (let column = 1; column <= right.length; column += 1) {
			current[column] = Math.min(
				(previous[column] ?? 0) + 1,
				(current[column - 1] ?? 0) + 1,
				(previous[column - 1] ?? 0) +
					(left[row - 1] === right[column - 1] ? 0 : 1),
			);
		}
		previous = current;
	}

	const distance =
		previous[right.length] ?? Math.max(left.length, right.length);
	return 1 - distance / Math.max(left.length, right.length);
}

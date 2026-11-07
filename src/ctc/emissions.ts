import { z } from "zod";

/**
 * `honomiya.emissions.v1`: sparse CTC emissions for one audio source.
 *
 * Dense emissions are far too large for character vocabularies (an 8 h book
 * with 4 541 classes is about 13 GB in fp16), so each frame keeps the blank
 * score plus its `topK` best non-blank classes. Any class not stored for a
 * frame scores at or below that frame's floor: the lowest stored score.
 *
 * Scores are natural-log probabilities quantized to int16 milli-nats, so they
 * span [-32.768, 0] with 0.001 resolution.
 *
 * File layout (little endian):
 *   8 bytes  magic "HNMYEMS1"
 *   4 bytes  uint32 header length in bytes
 *   n bytes  UTF-8 JSON header
 *   pad      zero bytes up to a multiple of 4
 *   int16    blank[frames]
 *   uint16   classes[frames * topK]  (sorted by descending score)
 *   int16    scores[frames * topK]
 */
export const HONOMIYA_EMISSIONS_SCHEMA = "honomiya.emissions.v1" as const;
const MAGIC = "HNMYEMS1";
export const SCORE_SCALE = 1_000;
const MIN_SCORE = -32_768;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);

export const emissionsHeaderSchema = z
	.object({
		schema: z.literal(HONOMIYA_EMISSIONS_SCHEMA),
		model: z
			.object({
				id: z.string().min(1),
				revision: z.string().min(1),
				timingCorrectionMs: z
					.object({ start: z.number().int(), end: z.number().int() })
					.strict(),
			})
			.strict(),
		source: z
			.object({
				sha256: sha256Schema,
				filename: z.string().min(1).optional(),
			})
			.strict(),
		sampleRate: z.number().int().positive(),
		samplesPerFrame: z.number().int().positive(),
		/** Global index of the first frame stored in this file. */
		startFrame: z.number().int().nonnegative(),
		frames: z.number().int().nonnegative(),
		/** Duration of the whole source, in milliseconds. */
		sourceDurationMs: z.number().int().positive(),
		topK: z.number().int().positive(),
		blank: z.number().int().nonnegative(),
		vocabulary: z.array(z.string()),
		scoreScale: z.literal(SCORE_SCALE),
	})
	.strict()
	.refine((header) => header.blank < header.vocabulary.length, {
		message: "blank must index the vocabulary",
		path: ["blank"],
	})
	.refine((header) => header.topK < header.vocabulary.length, {
		message: "topK must be smaller than the vocabulary",
		path: ["topK"],
	});

export type EmissionsHeader = z.infer<typeof emissionsHeaderSchema>;

export interface CtcEmissions {
	header: EmissionsHeader;
	blank: Int16Array;
	classes: Uint16Array;
	scores: Int16Array;
}

export function quantizeScore(logProbability: number): number {
	if (!(logProbability > MIN_SCORE / SCORE_SCALE)) return MIN_SCORE;
	return Math.min(0, Math.round(logProbability * SCORE_SCALE));
}

function logAddExp(a: number, b: number): number {
	if (a === Number.NEGATIVE_INFINITY) return b;
	if (b === Number.NEGATIVE_INFINITY) return a;
	const max = Math.max(a, b);
	return max + Math.log1p(Math.exp(-Math.abs(a - b)));
}

export function frameDurationMs(header: EmissionsHeader): number {
	return (header.samplesPerFrame * 1_000) / header.sampleRate;
}

/**
 * Appends frames from a dense [frames, classes] log-probability matrix,
 * keeping the blank and the best `topK` other classes per frame.
 */
export class SparseEmissionsBuilder {
	private readonly blankScores: number[] = [];
	private readonly classIds: number[] = [];
	private readonly classScores: number[] = [];
	private readonly bestIds: Int32Array;
	private readonly bestScores: Float64Array;

	/**
	 * `blankEquivalents`: classes that count as silence for alignment (a
	 * word-separator class). Their probability is added to the blank's and
	 * they never appear among the top classes.
	 */
	constructor(
		readonly topK: number,
		readonly blank: number,
		readonly blankEquivalents: readonly number[] = [],
	) {
		this.bestIds = new Int32Array(topK);
		this.bestScores = new Float64Array(topK);
	}

	get frames(): number {
		return this.blankScores.length;
	}

	append(
		logProbabilities: Float32Array,
		classes: number,
		firstFrame: number,
		endFrame: number,
	): void {
		const { topK, blank, bestIds, bestScores } = this;
		for (let frame = firstFrame; frame < endFrame; frame += 1) {
			const offset = frame * classes;
			bestScores.fill(Number.NEGATIVE_INFINITY);
			bestIds.fill(-1);
			for (let k = 0; k < classes; k += 1) {
				if (k === blank || this.isBlankEquivalent(k)) continue;
				const score = logProbabilities[offset + k] ?? Number.NEGATIVE_INFINITY;
				if (score <= (bestScores[topK - 1] ?? Number.NEGATIVE_INFINITY)) {
					continue;
				}
				let position = topK - 1;
				while (position > 0 && score > (bestScores[position - 1] ?? 0)) {
					bestScores[position] = bestScores[position - 1] ?? 0;
					bestIds[position] = bestIds[position - 1] ?? -1;
					position -= 1;
				}
				bestScores[position] = score;
				bestIds[position] = k;
			}
			let blankScore = logProbabilities[offset + blank] ?? Number.NEGATIVE_INFINITY;
			for (const equivalent of this.blankEquivalents) {
				blankScore = logAddExp(blankScore, logProbabilities[offset + equivalent] ?? Number.NEGATIVE_INFINITY);
			}
			this.blankScores.push(quantizeScore(blankScore));
			for (let position = 0; position < topK; position += 1) {
				this.classIds.push(Math.max(0, bestIds[position] ?? 0));
				this.classScores.push(quantizeScore(bestScores[position] ?? -Infinity));
			}
		}
	}

	private isBlankEquivalent(classId: number): boolean {
		return this.blankEquivalents.length > 0 && this.blankEquivalents.includes(classId);
	}

	build(header: Omit<EmissionsHeader, "frames" | "topK" | "blank" | "scoreScale">): CtcEmissions {
		return {
			header: emissionsHeaderSchema.parse({
				...header,
				frames: this.frames,
				topK: this.topK,
				blank: this.blank,
				scoreScale: SCORE_SCALE,
			}),
			blank: Int16Array.from(this.blankScores),
			classes: Uint16Array.from(this.classIds),
			scores: Int16Array.from(this.classScores),
		};
	}
}

/** Concatenates consecutive emissions of the same source and model. */
export function concatEmissions(parts: CtcEmissions[]): CtcEmissions {
	const [first] = parts;
	if (!first) throw new Error("No emissions to concatenate");
	let expectedFrame = first.header.startFrame;
	for (const part of parts) {
		const { header } = part;
		if (
			header.startFrame !== expectedFrame ||
			header.model.revision !== first.header.model.revision ||
			header.source.sha256 !== first.header.source.sha256 ||
			header.topK !== first.header.topK
		) {
			throw new Error("Emission parts are not contiguous parts of one source");
		}
		expectedFrame += header.frames;
	}
	const join = <T extends Int16Array | Uint16Array>(
		make: (length: number) => T,
		pick: (part: CtcEmissions) => T,
	): T => {
		const total = parts.reduce((sum, part) => sum + pick(part).length, 0);
		const result = make(total);
		let offset = 0;
		for (const part of parts) {
			result.set(pick(part), offset);
			offset += pick(part).length;
		}
		return result;
	};
	return {
		header: { ...first.header, frames: expectedFrame - first.header.startFrame },
		blank: join((n) => new Int16Array(n), (part) => part.blank),
		classes: join((n) => new Uint16Array(n), (part) => part.classes),
		scores: join((n) => new Int16Array(n), (part) => part.scores),
	};
}

export function encodeEmissions(emissions: CtcEmissions): Uint8Array {
	const { header } = emissions;
	const cells = header.frames * header.topK;
	if (
		emissions.blank.length !== header.frames ||
		emissions.classes.length !== cells ||
		emissions.scores.length !== cells
	) {
		throw new Error("Emission arrays do not match the header");
	}
	const headerBytes = new TextEncoder().encode(JSON.stringify(header));
	const headerEnd = 12 + headerBytes.length;
	const dataStart = Math.ceil(headerEnd / 4) * 4;
	const output = new Uint8Array(dataStart + 2 * header.frames + 4 * cells);
	output.set(new TextEncoder().encode(MAGIC), 0);
	new DataView(output.buffer).setUint32(8, headerBytes.length, true);
	output.set(headerBytes, 12);
	let offset = dataStart;
	for (const array of [emissions.blank, emissions.classes, emissions.scores]) {
		output.set(new Uint8Array(array.buffer, array.byteOffset, array.byteLength), offset);
		offset += array.byteLength;
	}
	return output;
}

export function decodeEmissions(bytes: Uint8Array): CtcEmissions {
	if (new TextDecoder().decode(bytes.subarray(0, 8)) !== MAGIC) {
		throw new Error(`Not a ${HONOMIYA_EMISSIONS_SCHEMA} file`);
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const headerLength = view.getUint32(8, true);
	const header = emissionsHeaderSchema.parse(
		JSON.parse(new TextDecoder().decode(bytes.subarray(12, 12 + headerLength))),
	);
	const dataStart = Math.ceil((12 + headerLength) / 4) * 4;
	const cells = header.frames * header.topK;
	const expectedBytes = dataStart + 2 * header.frames + 4 * cells;
	if (bytes.byteLength !== expectedBytes) {
		throw new Error(
			`Emissions file is ${bytes.byteLength} bytes, expected ${expectedBytes}`,
		);
	}
	// Copy so the typed arrays are aligned whatever the input's offset.
	const copy = bytes.slice(dataStart);
	const blank = new Int16Array(copy.buffer, 0, header.frames);
	const classes = new Uint16Array(copy.buffer, 2 * header.frames, cells);
	const scores = new Int16Array(copy.buffer, 2 * header.frames + 2 * cells, cells);
	return { header, blank, classes, scores };
}

/** Log probability of `classId` at a local frame, or the frame floor. */
export function emissionScore(
	emissions: CtcEmissions,
	frame: number,
	classId: number,
): number {
	const { header } = emissions;
	if (classId === header.blank) {
		return (emissions.blank[frame] ?? MIN_SCORE) / SCORE_SCALE;
	}
	const offset = frame * header.topK;
	for (let k = 0; k < header.topK; k += 1) {
		if (emissions.classes[offset + k] === classId) {
			return (emissions.scores[offset + k] ?? MIN_SCORE) / SCORE_SCALE;
		}
	}
	return (emissions.scores[offset + header.topK - 1] ?? MIN_SCORE) / SCORE_SCALE;
}

/** Greedy CTC decode, mostly for inspection and boundary search. */
export function greedyDecode(emissions: CtcEmissions): {
	text: string;
	/** Local frame of each decoded token. */
	frames: number[];
} {
	const { header } = emissions;
	let text = "";
	const frames: number[] = [];
	let previous = -1;
	for (let frame = 0; frame < header.frames; frame += 1) {
		const offset = frame * header.topK;
		const bestClass = emissions.classes[offset] ?? header.blank;
		const bestScore = emissions.scores[offset] ?? MIN_SCORE;
		const winner = (emissions.blank[frame] ?? MIN_SCORE) >= bestScore ? header.blank : bestClass;
		if (winner !== previous && winner !== header.blank) {
			text += header.vocabulary[winner] ?? "";
			frames.push(frame);
		}
		previous = winner;
	}
	return { text, frames };
}

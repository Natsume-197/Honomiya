import { z } from "zod";

export const HONOMIYA_TRANSCRIPT_SCHEMA = "honomiya.transcript.v1" as const;
export const TIMESTAMP_BACKENDS = ["faster-whisper", "stable-ts"] as const;
export type TimestampBackend = (typeof TIMESTAMP_BACKENDS)[number];

export function isTimestampBackend(value: string): value is TimestampBackend {
	return TIMESTAMP_BACKENDS.some((backend) => backend === value);
}

const sha256Schema = z
	.string()
	.regex(/^[a-f0-9]{64}$/u, "Expected a lowercase SHA-256 digest");

const transcriptWordSchema = z
	.object({
		startMs: z.number().int().nonnegative(),
		endMs: z.number().int().positive(),
		text: z.string().min(1),
		probability: z.number().min(0).max(1).optional(),
	})
	.strict()
	.refine((word) => word.endMs > word.startMs, {
		message: "endMs must be greater than startMs",
		path: ["endMs"],
	});

const transcriptSegmentSchema = z
	.object({
		id: z.number().int().nonnegative(),
		startMs: z.number().int().nonnegative(),
		endMs: z.number().int().positive(),
		text: z.string().min(1),
		words: z.array(transcriptWordSchema),
	})
	.strict()
	.refine((segment) => segment.endMs > segment.startMs, {
		message: "endMs must be greater than startMs",
		path: ["endMs"],
	});

const speechRegionSchema = z
	.object({
		startMs: z.number().int().nonnegative(),
		endMs: z.number().int().positive(),
	})
	.strict()
	.refine((region) => region.endMs > region.startMs, {
		message: "endMs must be greater than startMs",
		path: ["endMs"],
	});

export const honomiyaTranscriptSchema = z
	.object({
		schema: z.literal(HONOMIYA_TRANSCRIPT_SCHEMA),
		engine: z
			.object({
				provider: z.string().min(1),
				model: z.string().min(1),
				revision: z.string().min(1).optional(),
				timestampBackend: z.enum(TIMESTAMP_BACKENDS).optional(),
			})
			.strict(),
		source: z
			.object({
				sha256: sha256Schema,
				filename: z.string().min(1).optional(),
			})
			.strict()
			.optional(),
		language: z.string().min(1),
		languageProbability: z.number().min(0).max(1).optional(),
		offsetMs: z.number().int().nonnegative(),
		durationMs: z.number().int().positive(),
		speechTimeline: z.array(speechRegionSchema).optional(),
		segments: z.array(transcriptSegmentSchema),
	})
	.strict()
	.superRefine((transcript, context) => {
		let previousSpeechEndMs = transcript.offsetMs;
		for (const [position, region] of (
			transcript.speechTimeline ?? []
		).entries()) {
			if (region.startMs < previousSpeechEndMs) {
				context.addIssue({
					code: "custom",
					message: "Speech regions must be ordered and must not overlap",
					path: ["speechTimeline", position, "startMs"],
				});
			}
			if (region.endMs > transcript.offsetMs + transcript.durationMs) {
				context.addIssue({
					code: "custom",
					message: "Speech region ends after the audio duration",
					path: ["speechTimeline", position, "endMs"],
				});
			}
			previousSpeechEndMs = region.endMs;
		}

		let previousEndMs = transcript.offsetMs;
		for (const [position, segment] of transcript.segments.entries()) {
			if (segment.startMs < previousEndMs) {
				context.addIssue({
					code: "custom",
					message: "Segments must be ordered and must not overlap",
					path: ["segments", position, "startMs"],
				});
			}

			if (segment.endMs > transcript.offsetMs + transcript.durationMs) {
				context.addIssue({
					code: "custom",
					message: "Segment ends after the audio duration",
					path: ["segments", position, "endMs"],
				});
			}

			for (const [wordPosition, word] of segment.words.entries()) {
				if (word.startMs < segment.startMs || word.endMs > segment.endMs) {
					context.addIssue({
						code: "custom",
						message: "Word must be contained by its segment",
						path: ["segments", position, "words", wordPosition],
					});
				}
			}

			previousEndMs = segment.endMs;
		}
	});

export type HonomiyaTranscript = z.infer<typeof honomiyaTranscriptSchema>;

export function parseHonomiyaTranscript(input: unknown): HonomiyaTranscript {
	return honomiyaTranscriptSchema.parse(input);
}

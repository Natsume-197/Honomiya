import { z } from "zod";

export const HONOMIYA_MANIFEST_SCHEMA = "honomiya.read-listen.v1" as const;

const sha256Schema = z
	.string()
	.regex(/^[a-f0-9]{64}$/u, "Expected a lowercase SHA-256 digest");

const sourceFileSchema = z
	.object({
		sha256: sha256Schema,
		filename: z.string().min(1).optional(),
	})
	.strict();

const audioSourceSchema = sourceFileSchema
	.extend({
		index: z.number().int().nonnegative(),
		durationMs: z.number().int().positive().optional(),
	})
	.strict();

const fragmentAnchorSchema = z
	.object({
		kind: z.literal("fragment"),
		sectionRef: z.string().min(1),
		fragmentId: z.string().min(1),
	})
	.strict();

const textQuoteAnchorSchema = z
	.object({
		kind: z.literal("text-quote"),
		sectionRef: z.string().min(1),
		exact: z.string().min(1),
		prefix: z.string().min(1).optional(),
		suffix: z.string().min(1).optional(),
	})
	.strict();

export const readListenCueSchema = z
	.object({
		id: z.string().min(1),
		text: z.discriminatedUnion("kind", [
			fragmentAnchorSchema,
			textQuoteAnchorSchema,
		]),
		audioFileIndex: z.number().int().nonnegative(),
		startMs: z.number().int().nonnegative(),
		endMs: z.number().int().positive(),
	})
	.strict()
	.refine((cue) => cue.endMs > cue.startMs, {
		message: "endMs must be greater than startMs",
		path: ["endMs"],
	});

export const honomiyaManifestV1Schema = z
	.object({
		schema: z.literal(HONOMIYA_MANIFEST_SCHEMA),
		createdAt: z.iso.datetime({ offset: true }),
		generator: z
			.object({
				name: z.literal("honomiya"),
				version: z.string().min(1),
			})
			.strict(),
		granularity: z.literal("sentence"),
		sources: z
			.object({
				ebook: sourceFileSchema,
				audioFiles: z.array(audioSourceSchema).min(1),
			})
			.strict(),
		cues: z.array(readListenCueSchema),
	})
	.strict()
	.superRefine((manifest, context) => {
		const audioByIndex = new Map<
			number,
			(typeof manifest.sources.audioFiles)[number]
		>();
		for (const [position, audio] of manifest.sources.audioFiles.entries()) {
			if (audioByIndex.has(audio.index)) {
				context.addIssue({
					code: "custom",
					message: `Duplicate audio file index ${audio.index}`,
					path: ["sources", "audioFiles", position, "index"],
				});
			}
			audioByIndex.set(audio.index, audio);
		}

		const cueIds = new Set<string>();
		let previous: (typeof manifest.cues)[number] | undefined;
		for (const [position, cue] of manifest.cues.entries()) {
			if (cueIds.has(cue.id)) {
				context.addIssue({
					code: "custom",
					message: `Duplicate cue id ${cue.id}`,
					path: ["cues", position, "id"],
				});
			}
			cueIds.add(cue.id);

			const audio = audioByIndex.get(cue.audioFileIndex);
			if (!audio) {
				context.addIssue({
					code: "custom",
					message: `Unknown audio file index ${cue.audioFileIndex}`,
					path: ["cues", position, "audioFileIndex"],
				});
			} else if (
				audio.durationMs !== undefined &&
				cue.endMs > audio.durationMs
			) {
				context.addIssue({
					code: "custom",
					message: `Cue ends after audio file ${cue.audioFileIndex}`,
					path: ["cues", position, "endMs"],
				});
			}

			if (previous) {
				const outOfOrder =
					cue.audioFileIndex < previous.audioFileIndex ||
					(cue.audioFileIndex === previous.audioFileIndex &&
						cue.startMs < previous.startMs);
				if (outOfOrder) {
					context.addIssue({
						code: "custom",
						message: "Cues must be ordered by audioFileIndex and startMs",
						path: ["cues", position],
					});
				}

				if (
					cue.audioFileIndex === previous.audioFileIndex &&
					cue.startMs < previous.endMs
				) {
					context.addIssue({
						code: "custom",
						message: "Cues in the same audio file must not overlap",
						path: ["cues", position, "startMs"],
					});
				}
			}

			previous = cue;
		}
	});

export type HonomiyaManifestV1 = z.infer<typeof honomiyaManifestV1Schema>;
export type ReadListenCue = z.infer<typeof readListenCueSchema>;

export function parseHonomiyaManifest(input: unknown): HonomiyaManifestV1 {
	return honomiyaManifestV1Schema.parse(input);
}

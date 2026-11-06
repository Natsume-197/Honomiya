/**
 * Acoustic models that produce CTC emissions. Each descriptor pins the exact
 * files, so an emissions artifact can always name the model that made it.
 */

export const CTC_MODEL_IDS = ["quartznet15x5-ja"] as const;
export type CtcModelId = (typeof CTC_MODEL_IDS)[number];
export const DEFAULT_CTC_MODEL_ID: CtcModelId = "quartznet15x5-ja";

export interface CtcModelFile {
	name: string;
	url: string;
	bytes: number;
	sha256: string;
}

export interface CtcModelDescriptor {
	id: CtcModelId;
	/** Changes whenever the files or how they are run change. */
	revision: string;
	/**
	 * `signal`: the graph takes raw audio shaped [batch, 1, samples] and
	 * returns log probabilities. `input-values`: wav2vec2-style graphs that
	 * take normalized audio shaped [batch, samples] and return logits.
	 */
	input: "signal" | "input-values";
	languages: string[];
	sampleRate: number;
	/** Audio samples per emitted frame. */
	samplesPerFrame: number;
	/** Audio fed to the model per inference call, including context. */
	windowSeconds: number;
	/** Context on each side of a window whose frames are discarded. */
	contextSeconds: number;
	/**
	 * Measured constant lag of this model's emissions. Aligners add these to
	 * raw token start and end times.
	 */
	timingCorrectionMs: { start: number; end: number };
	files: {
		model: CtcModelFile;
		vocabulary: CtcModelFile;
		/** Published int8 variant; `models pull` installs it when present. */
		modelInt8?: CtcModelFile;
	};
	source: string;
	licenseNote: string;
}

/** Honomiya's own conversion, published as a GitHub release (Apache-2.0). */
const QUARTZNET_JA_RELEASE =
	"https://github.com/Natsume-197/Honomiya/releases/download/models-quartznet15x5-ja-v1";

export const CTC_MODELS: Record<CtcModelId, CtcModelDescriptor> = {
	"quartznet15x5-ja": {
		id: "quartznet15x5-ja",
		revision: "quartznet15x5-ja.v1",
		input: "signal",
		languages: ["ja"],
		sampleRate: 16_000,
		samplesPerFrame: 320,
		windowSeconds: 38,
		contextSeconds: 2,
		// Calibrated against SRT-derived references in Phase 0
		// (docs/phase-0-ctc-benchmark.md).
		timingCorrectionMs: { start: -1_228, end: -762 },
		files: {
			model: {
				name: "model.onnx",
				url: `${QUARTZNET_JA_RELEASE}/model.onnx`,
				bytes: 95_235_492,
				sha256:
					"7afc3d1df40008333235c4038b138f4d86942a07c260473a90cbbe7f9d98dab9",
			},
			vocabulary: {
				name: "vocab.txt",
				url: `${QUARTZNET_JA_RELEASE}/vocab.txt`,
				bytes: 39_723,
				sha256:
					"6277f3a0cedd93b6a22c35ea6b6ba1c6e12d5d21ca1f85fb8ebb064cc7b82daf",
			},
			modelInt8: {
				name: "model.int8.onnx",
				url: `${QUARTZNET_JA_RELEASE}/model.int8.onnx`,
				bytes: 39_750_265,
				sha256:
					"84df51eb3744ded8c3de9b2793737c8e02ada1ee50035036044645b129d845aa",
			},
		},
		// Converted by scripts/convert-nemo-quartznet.py from
		// kinouchi/japanese-quartznet-large (Apache-2.0, trained on ReazonSpeech);
		// the int8 file comes from scripts/quantize-ctc-model.py. See
		// docs/model-licences.md.
		source:
			"Honomiya release models-quartznet15x5-ja-v1, converted from kinouchi/japanese-quartznet-large (huggingface.co)",
		licenseNote:
			"Weights: Apache-2.0 (kinouchi/japanese-quartznet-large). Trained on ReazonSpeech (CDLA-Sharing-1.0, Japanese Copyright Act art. 30-4).",
	},
};

export function isCtcModelId(value: string): value is CtcModelId {
	return CTC_MODEL_IDS.some((id) => id === value);
}

export function ctcModel(id: string): CtcModelDescriptor {
	if (!isCtcModelId(id)) {
		throw new Error(
			`Unknown CTC model ${id}; available: ${CTC_MODEL_IDS.join(", ")}`,
		);
	}
	return CTC_MODELS[id];
}

export function defaultCtcModelForLanguage(
	language: string | undefined,
): CtcModelDescriptor | undefined {
	const primary = language?.toLowerCase().split(/[-_]/u)[0];
	if (!primary) return undefined;
	return Object.values(CTC_MODELS).find((model) =>
		model.languages.includes(primary),
	);
}

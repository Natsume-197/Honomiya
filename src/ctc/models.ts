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
	files: { model: CtcModelFile; vocabulary: CtcModelFile };
	source: string;
	licenseNote: string;
}

/** Interim third-party ONNX export, until a self-hosted conversion replaces it. */
const INTERIM_ONNX_SOURCE =
	"https://gitlab.com/api/v4/projects/67994333/packages/ml_models/3023444/files";

export const CTC_MODELS: Record<CtcModelId, CtcModelDescriptor> = {
	"quartznet15x5-ja": {
		id: "quartznet15x5-ja",
		revision: "quartznet15x5-ja.onnx-fp32.1",
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
				url: `${INTERIM_ONNX_SOURCE}/model.onnx`,
				bytes: 95_210_887,
				sha256:
					"9d8f341073fa23feead84269c2b3fd77f754ac7f33b339e56883aba503f2ab30",
			},
			vocabulary: {
				name: "vocab.txt",
				url: `${INTERIM_ONNX_SOURCE}/vocab.txt`,
				bytes: 39_723,
				sha256:
					"6277f3a0cedd93b6a22c35ea6b6ba1c6e12d5d21ca1f85fb8ebb064cc7b82daf",
			},
		},
		// Provenance verified 2026-11-06: identical 4 540-label vocabulary (same
		// shuffled order) and architecture as kinouchi/japanese-quartznet-large,
		// an Apache-2.0 NeMo model trained on ReazonSpeech. The ONNX export is
		// downloaded from an interim third-party model registry.
		source:
			"kinouchi/japanese-quartznet-large (huggingface.co), interim ONNX export from a third-party model registry",
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

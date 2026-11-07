/**
 * Acoustic models that produce CTC emissions. Each descriptor pins the exact
 * files, so an emissions artifact can always name the model that made it.
 */

export const CTC_MODEL_IDS = ["quartznet15x5-ja", "quartznet15x5-es", "quartznet15x5-en"] as const;
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
	input: "signal" | "input-values" | "features";
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
		/** Mel frontend for `input: "features"` models (raw audio → features). */
		frontend?: CtcModelFile;
	};
	/**
	 * Tokens that count as silence for alignment (a word-separator class),
	 * merged into the blank when emissions are computed.
	 */
	blankEquivalents?: string[];
	/** n-gram length of boundary-search anchors (default 6). */
	searchNgram?: number;
	source: string;
	licenseNote: string;
}

/**
 * Honomiya's model release: every converted model, prefixed with its id. A
 * published file is never replaced; an updated model gets a new release.
 */
const MODELS_RELEASE = "https://github.com/Natsume-197/Honomiya/releases/download/models-v1";
const releaseUrl = (id: string, file: string) => `${MODELS_RELEASE}/${id}.${file}`;

/**
 * NVIDIA NeMo QuartzNet 15x5 models (CC-BY-4.0; see docs/model-licences.md),
 * converted by scripts/convert-nemo-quartznet.py from the NGC checkpoints and
 * published as Honomiya releases, like the Japanese model.
 */
const TIMING_CORRECTION_MS = {
	es: { start: -405, end: 120 },
	en: { start: -455, end: 200 },
} as const;

function nvidiaQuartzNet(
	language: "es" | "en",
	model: { bytes: number; sha256: string },
	vocabulary: { bytes: number; sha256: string },
	modelInt8?: { bytes: number; sha256: string },
): CtcModelDescriptor {
	const id = `quartznet15x5-${language}` as CtcModelId;
	return {
		id,
		revision: `${id}.v1`,
		input: "signal",
		languages: [language],
		sampleRate: 16_000,
		samplesPerFrame: 320,
		windowSeconds: 38,
		contextSeconds: 2,
		// Calibrated from audio energy on LibriVox narration (no reference
		// alignment exists); see docs/phase-8-latin-languages.md.
		timingCorrectionMs: TIMING_CORRECTION_MS[language],
		files: {
			model: { name: "model.onnx", url: releaseUrl(id, "model.onnx"), ...model },
			vocabulary: { name: "vocab.txt", url: releaseUrl(id, "vocab.txt"), ...vocabulary },
			...(modelInt8
				? { modelInt8: { name: "model.int8.onnx", url: releaseUrl(id, "model.int8.onnx"), ...modelInt8 } }
				: {}),
		},
		// The word separator is narrated as silence.
		blankEquivalents: [" "],
		searchNgram: 10,
		source: `Honomiya release models-v1, converted from NVIDIA NeMo stt_${language}_quartznet15x5 (NGC)`,
		licenseNote: "Weights: CC-BY-4.0, NVIDIA NeMo stt_" + language + "_quartznet15x5.",
	};
}

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
				url: releaseUrl("quartznet15x5-ja", "model.onnx"),
				bytes: 95_235_492,
				sha256:
					"7afc3d1df40008333235c4038b138f4d86942a07c260473a90cbbe7f9d98dab9",
			},
			vocabulary: {
				name: "vocab.txt",
				url: releaseUrl("quartznet15x5-ja", "vocab.txt"),
				bytes: 39_723,
				sha256:
					"6277f3a0cedd93b6a22c35ea6b6ba1c6e12d5d21ca1f85fb8ebb064cc7b82daf",
			},
			modelInt8: {
				name: "model.int8.onnx",
				url: releaseUrl("quartznet15x5-ja", "model.int8.onnx"),
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
			"Honomiya release models-v1, converted from kinouchi/japanese-quartznet-large (huggingface.co)",
		licenseNote:
			"Weights: Apache-2.0 (kinouchi/japanese-quartznet-large). Trained on ReazonSpeech (CDLA-Sharing-1.0, Japanese Copyright Act art. 30-4).",
	},
	"quartznet15x5-es": nvidiaQuartzNet(
		"es",
		{ bytes: 76_764_985, sha256: "abee0fb90d16dbafebcd8483e38de917ecad192e2187c98f5cc2a244c76bdbe4" },
		{ bytes: 181, sha256: "b4df7a565daf6af46a66576ec11b916b05408380492169456b691602760daaef" },
		{ bytes: 21_279_755, sha256: "b415b11decb08a7b3235cd9f7ccb3ba6a3c37cb70f29cb0933ef2f4c7292c78d" },
	),
	"quartznet15x5-en": nvidiaQuartzNet(
		"en",
		{ bytes: 76_736_284, sha256: "050115bef0e6c92484ad8910aeb6797514ffa339dc7ac013627a1bc6decd4bde" },
		{ bytes: 139, sha256: "9c8e88ddfb9dadbda0d8d74e796abd51fba75d943bdf5e83d1ea7eed574027dd" },
		{ bytes: 21_251_055, sha256: "98c3918f0c5ee620e9fc894cafc50cbb925bdddb1f153c959c1568d2319228ba" },
	),
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

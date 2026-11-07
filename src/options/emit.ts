import { resolve } from "node:path";
import { defaultEmissionsOutputPath } from "../artifacts/output-paths";
import { type CtcPrecision, isCtcPrecision } from "../ctc/model-store";
import {
	type CtcModelId,
	DEFAULT_CTC_MODEL_ID,
	defaultCtcModelForLanguage,
	isCtcModelId,
} from "../ctc/models";

const EMIT_FLAGS = new Set([
	"--audio",
	"--cache-dir",
	"--chunk-minutes",
	"--language",
	"--model",
	"--model-dir",
	"--output",
	"--precision",
	"--threads",
	"--top-k",
]);

export interface EmitOptions {
	audioPath: string;
	outputPath: string;
	model: CtcModelId;
	modelDir?: string;
	cacheDir?: string;
	threads?: number;
	topK?: number;
	chunkMinutes?: number;
	precision?: CtcPrecision | "auto";
}

export class EmitOptionsError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "EmitOptionsError";
	}
}

function positiveInteger(flag: string, value: string | undefined) {
	if (value === undefined) return undefined;
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed <= 0) {
		throw new EmitOptionsError(`${flag} must be a positive integer`);
	}
	return parsed;
}

export function parseEmitOptions(args: string[]): EmitOptions {
	const values = new Map<string, string>();
	for (let position = 0; position < args.length; position += 2) {
		const flag = args[position];
		if (!flag?.startsWith("--")) {
			throw new EmitOptionsError(`Unexpected argument: ${flag ?? ""}`);
		}
		const value = args[position + 1];
		if (!value || value.startsWith("--")) {
			throw new EmitOptionsError(`${flag} requires a value`);
		}
		if (!EMIT_FLAGS.has(flag)) {
			throw new EmitOptionsError(`Unknown option: ${flag}`);
		}
		if (values.has(flag)) {
			throw new EmitOptionsError(`${flag} may only be provided once`);
		}
		values.set(flag, value);
	}

	const audioPath = values.get("--audio");
	if (!audioPath) throw new EmitOptionsError("--audio is required");
	const outputPath = values.get("--output") ?? defaultEmissionsOutputPath(audioPath);
	if (resolve(audioPath) === resolve(outputPath)) {
		throw new EmitOptionsError("--output must not overwrite --audio");
	}

	const modelValue = values.get("--model");
	const language = values.get("--language");
	let model: CtcModelId;
	if (modelValue) {
		if (!isCtcModelId(modelValue)) {
			throw new EmitOptionsError(`Unsupported CTC model: ${modelValue}`);
		}
		model = modelValue;
	} else if (language) {
		const descriptor = defaultCtcModelForLanguage(language);
		if (!descriptor) {
			throw new EmitOptionsError(`No CTC model is available for language ${language}`);
		}
		model = descriptor.id;
	} else {
		model = DEFAULT_CTC_MODEL_ID;
	}

	const chunkMinutesValue = values.get("--chunk-minutes");
	let chunkMinutes: number | undefined;
	if (chunkMinutesValue !== undefined) {
		chunkMinutes = Number(chunkMinutesValue);
		if (!Number.isFinite(chunkMinutes) || chunkMinutes <= 0) {
			throw new EmitOptionsError("--chunk-minutes must be a positive number");
		}
	}

	const precision = values.get("--precision");
	if (precision !== undefined && precision !== "auto" && !isCtcPrecision(precision)) {
		throw new EmitOptionsError(`Unsupported precision: ${precision}`);
	}
	const threads = positiveInteger("--threads", values.get("--threads"));
	const topK = positiveInteger("--top-k", values.get("--top-k"));
	return {
		audioPath,
		outputPath,
		model,
		...(values.get("--model-dir") ? { modelDir: values.get("--model-dir") } : {}),
		...(values.get("--cache-dir") ? { cacheDir: values.get("--cache-dir") } : {}),
		...(threads === undefined ? {} : { threads }),
		...(topK === undefined ? {} : { topK }),
		...(chunkMinutes === undefined ? {} : { chunkMinutes }),
		...(precision === undefined ? {} : { precision: precision as CtcPrecision | "auto" }),
	};
}

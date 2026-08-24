import { join } from "node:path";
import type { TranscriptionProvider, TranscriptionRequest } from "../provider";
import {
	type HonomiyaTranscript,
	parseHonomiyaTranscript,
	type TimestampBackend,
} from "../transcript";

const DEFAULT_MODEL = "large-v3";
const DEFAULT_DEVICE = "auto";
const DEFAULT_COMPUTE_TYPE = "auto";
const DEFAULT_PYTHON = "python3";
const DEFAULT_TIMESTAMP_BACKEND: TimestampBackend = "faster-whisper";
const LOCAL_RUNTIME_REVISION = "faster-whisper-1.2.1:stable-ts-2.19.1";

export interface LocalProviderConfig {
	python: string;
	workerPath: string;
	model: string;
	device: string;
	computeType: string;
	downloadRoot?: string;
}

export interface LocalTranscriptionInput {
	audioPath: string;
	language?: string;
	offsetMs: number;
	timestampBackend: TimestampBackend;
	config: LocalProviderConfig;
	signal?: AbortSignal;
}

export interface LocalTranscriptionProviderOptions {
	config?: Partial<LocalProviderConfig>;
	runWorker?: (input: LocalTranscriptionInput) => Promise<unknown>;
	timestampBackend?: TimestampBackend;
}

function optionalValue(value: string | undefined): string | undefined {
	const normalized = value?.trim();
	return normalized ? normalized : undefined;
}

export function resolveLocalProviderConfig(
	environment: Record<string, string | undefined> = process.env,
	overrides: Partial<LocalProviderConfig> = {},
): LocalProviderConfig {
	return {
		python:
			overrides.python ??
			optionalValue(environment.HONOMIYA_LOCAL_PYTHON) ??
			DEFAULT_PYTHON,
		workerPath:
			overrides.workerPath ?? join(import.meta.dir, "local-worker.py"),
		model:
			overrides.model ??
			optionalValue(environment.HONOMIYA_LOCAL_MODEL) ??
			DEFAULT_MODEL,
		device:
			overrides.device ??
			optionalValue(environment.HONOMIYA_LOCAL_DEVICE) ??
			DEFAULT_DEVICE,
		computeType:
			overrides.computeType ??
			optionalValue(environment.HONOMIYA_LOCAL_COMPUTE_TYPE) ??
			DEFAULT_COMPUTE_TYPE,
		downloadRoot:
			overrides.downloadRoot ??
			optionalValue(environment.HONOMIYA_LOCAL_MODEL_CACHE),
	};
}

function abortError(): Error {
	const error = new Error("Transcription cancelled");
	error.name = "AbortError";
	return error;
}

export async function runLocalTranscriptionWorker(
	input: LocalTranscriptionInput,
): Promise<unknown> {
	if (input.signal?.aborted) throw abortError();
	const command = [
		input.config.python,
		input.config.workerPath,
		"--audio",
		input.audioPath,
		"--offset-ms",
		input.offsetMs.toString(),
		"--timestamp-backend",
		input.timestampBackend,
		"--model",
		input.config.model,
		"--device",
		input.config.device,
		"--compute-type",
		input.config.computeType,
	];
	if (input.language) command.push("--language", input.language);
	if (input.config.downloadRoot) {
		command.push("--download-root", input.config.downloadRoot);
	}

	const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
	const onAbort = () => child.kill();
	input.signal?.addEventListener("abort", onAbort, { once: true });
	try {
		const [exitCode, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		if (input.signal?.aborted) throw abortError();
		if (exitCode !== 0) {
			const detail = stderr.trim();
			if (detail.includes("ModuleNotFoundError")) {
				throw new Error(
					`Local transcription dependencies are missing for ${input.config.python}. Install requirements-local.txt in that Python environment.`,
				);
			}
			throw new Error(
				detail
					? `Local transcription failed: ${detail}`
					: `Local transcription failed with exit code ${exitCode}`,
			);
		}
		try {
			return JSON.parse(stdout);
		} catch (error) {
			throw new Error("Local transcription returned invalid JSON", {
				cause: error,
			});
		}
	} finally {
		input.signal?.removeEventListener("abort", onAbort);
	}
}

export class LocalTranscriptionProvider implements TranscriptionProvider {
	readonly name = "local" as const;
	readonly revision: string;
	readonly #config: LocalProviderConfig;
	readonly #runWorker: (input: LocalTranscriptionInput) => Promise<unknown>;
	readonly #timestampBackend: TimestampBackend;

	constructor(options: LocalTranscriptionProviderOptions = {}) {
		this.#config = resolveLocalProviderConfig(process.env, options.config);
		this.#runWorker = options.runWorker ?? runLocalTranscriptionWorker;
		this.#timestampBackend =
			options.timestampBackend ?? DEFAULT_TIMESTAMP_BACKEND;
		this.revision =
			process.env.HONOMIYA_LOCAL_REVISION ??
			`${LOCAL_RUNTIME_REVISION}:${this.#config.model}:${this.#config.device}:${this.#config.computeType}:${this.#timestampBackend}`;
	}

	async transcribe(request: TranscriptionRequest): Promise<HonomiyaTranscript> {
		const result = await this.#runWorker({
			audioPath: request.audioPath,
			language: request.language,
			offsetMs: request.offsetMs ?? 0,
			timestampBackend: this.#timestampBackend,
			config: this.#config,
			signal: request.signal,
		});
		const transcript = parseHonomiyaTranscript(result);
		return parseHonomiyaTranscript({
			...transcript,
			engine: {
				...transcript.engine,
				provider: this.name,
				model: this.#config.model,
				revision: this.revision,
				timestampBackend: this.#timestampBackend,
			},
		});
	}
}

import { basename } from "node:path";
import { ModalClient } from "modal";
import type { TranscriptionProvider, TranscriptionRequest } from "../provider";
import {
	type HonomiyaTranscript,
	parseHonomiyaTranscript,
	type TimestampBackend,
} from "../transcript";

const DEFAULT_APP_NAME = "honomiya-transcriber";
const DEFAULT_CLASS_NAME = "HonomiyaTranscriber";
const DEFAULT_METHOD_NAME = "transcribe";
const DEFAULT_PROVIDER_REVISION = "faster-whisper-1.2.1:large-v3:speech-v3";
const DEFAULT_TIMESTAMP_BACKEND: TimestampBackend = "faster-whisper";

export interface ModalProviderConfig {
	appName: string;
	className: string;
	methodName: string;
	environment?: string;
}

export interface ModalTranscriptionInput {
	audioBytes: Uint8Array;
	filename: string;
	language?: string;
	offsetMs: number;
	timestampBackend: TimestampBackend;
}

export interface ModalTranscriptionGateway {
	transcribe(
		input: ModalTranscriptionInput,
		onStarted?: (functionCallId: string) => void | Promise<void>,
		signal?: AbortSignal,
	): Promise<unknown>;
	resume(functionCallId: string, signal?: AbortSignal): Promise<unknown>;
	cancel(functionCallId: string): Promise<void>;
}

export interface ModalTranscriptionProviderOptions {
	config?: Partial<ModalProviderConfig>;
	createGateway?: (config: ModalProviderConfig) => ModalTranscriptionGateway;
	readBytes?: (path: string) => Promise<Uint8Array>;
	timestampBackend?: TimestampBackend;
}

function optionalEnvironment(value: string | undefined): string | undefined {
	const normalized = value?.trim();
	return normalized ? normalized : undefined;
}

export function resolveModalProviderConfig(
	environment: Record<string, string | undefined> = process.env,
	overrides: Partial<ModalProviderConfig> = {},
): ModalProviderConfig {
	return {
		appName:
			overrides.appName ?? environment.HONOMIYA_MODAL_APP ?? DEFAULT_APP_NAME,
		className:
			overrides.className ??
			environment.HONOMIYA_MODAL_CLASS ??
			DEFAULT_CLASS_NAME,
		methodName:
			overrides.methodName ??
			environment.HONOMIYA_MODAL_METHOD ??
			DEFAULT_METHOD_NAME,
		environment: optionalEnvironment(
			overrides.environment ?? environment.HONOMIYA_MODAL_ENVIRONMENT,
		),
	};
}

class ModalSdkGateway implements ModalTranscriptionGateway {
	readonly #client = new ModalClient();

	constructor(private readonly config: ModalProviderConfig) {}

	async transcribe(
		input: ModalTranscriptionInput,
		onStarted?: (functionCallId: string) => void | Promise<void>,
		signal?: AbortSignal,
	): Promise<unknown> {
		const remoteClass = await this.#client.cls.fromName(
			this.config.appName,
			this.config.className,
			this.config.environment
				? { environment: this.config.environment }
				: undefined,
		);
		const instance = await remoteClass.instance();
		const method = instance.method(this.config.methodName);

		const call = await method.spawn([input.audioBytes], {
			filename: input.filename,
			language: input.language ?? null,
			offset_ms: input.offsetMs,
			timestamp_backend: input.timestampBackend,
		});
		await onStarted?.(call.functionCallId);
		return waitForModalCall(call, signal);
	}

	async resume(functionCallId: string, signal?: AbortSignal): Promise<unknown> {
		const call = await this.#client.functionCalls.fromId(functionCallId);
		return waitForModalCall(call, signal);
	}

	async cancel(functionCallId: string): Promise<void> {
		const call = await this.#client.functionCalls.fromId(functionCallId);
		await call.cancel({ terminateContainers: true });
	}
}

interface ModalFunctionCall {
	get(): Promise<unknown>;
	cancel(options: { terminateContainers: boolean }): Promise<void>;
}

function abortError(): Error {
	const error = new Error("Transcription cancelled");
	error.name = "AbortError";
	return error;
}

async function waitForModalCall(
	call: ModalFunctionCall,
	signal?: AbortSignal,
): Promise<unknown> {
	if (!signal) return call.get();
	if (signal.aborted) {
		await call.cancel({ terminateContainers: true });
		throw abortError();
	}

	let rejectAbort: ((reason: Error) => void) | undefined;
	const aborted = new Promise<never>((_resolve, reject) => {
		rejectAbort = reject;
	});
	const onAbort = () => {
		void call
			.cancel({ terminateContainers: true })
			.catch(() => undefined)
			.finally(() => rejectAbort?.(abortError()));
	};
	signal.addEventListener("abort", onAbort, { once: true });
	try {
		return await Promise.race([call.get(), aborted]);
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}

async function readFileBytes(path: string): Promise<Uint8Array> {
	return new Uint8Array(await Bun.file(path).arrayBuffer());
}

export class ModalTranscriptionProvider implements TranscriptionProvider {
	readonly name = "modal" as const;
	readonly revision: string;
	readonly #gateway: ModalTranscriptionGateway;
	readonly #readBytes: (path: string) => Promise<Uint8Array>;
	readonly #timestampBackend: TimestampBackend;

	constructor(options: ModalTranscriptionProviderOptions = {}) {
		const config = resolveModalProviderConfig(process.env, options.config);
		this.#gateway = (
			options.createGateway ?? ((value) => new ModalSdkGateway(value))
		)(config);
		this.#readBytes = options.readBytes ?? readFileBytes;
		this.#timestampBackend =
			options.timestampBackend ?? DEFAULT_TIMESTAMP_BACKEND;
		const timestampRevision =
			this.#timestampBackend === "stable-ts"
				? "stable-ts-2.19.1"
				: "faster-whisper-native";
		this.revision =
			process.env.HONOMIYA_MODAL_REVISION ??
			`${DEFAULT_PROVIDER_REVISION}:${timestampRevision}`;
	}

	async transcribe(request: TranscriptionRequest): Promise<HonomiyaTranscript> {
		const result = await this.#gateway.transcribe(
			{
				audioBytes: await this.#readBytes(request.audioPath),
				filename: basename(request.audioPath),
				language: request.language,
				offsetMs: request.offsetMs ?? 0,
				timestampBackend: this.#timestampBackend,
			},
			request.onJobStarted
				? (id) => request.onJobStarted?.({ provider: this.name, id })
				: undefined,
			request.signal,
		);
		return this.#normalize(result);
	}

	async resume(
		job: { provider: "modal"; id: string },
		signal?: AbortSignal,
	): Promise<HonomiyaTranscript> {
		return this.#normalize(await this.#gateway.resume(job.id, signal));
	}

	async cancel(job: { provider: "modal"; id: string }): Promise<void> {
		await this.#gateway.cancel(job.id);
	}

	#normalize(result: unknown): HonomiyaTranscript {
		const transcript = parseHonomiyaTranscript(result);
		return parseHonomiyaTranscript({
			...transcript,
			engine: { ...transcript.engine, revision: this.revision },
		});
	}
}

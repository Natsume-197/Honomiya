import {
	ModalTranscriptionProvider,
	type ModalTranscriptionProviderOptions,
} from "./providers/modal";
import type { HonomiyaTranscript, TimestampBackend } from "./transcript";

export const TRANSCRIPTION_PROVIDER_NAMES = ["modal"] as const;

export type TranscriptionProviderName =
	(typeof TRANSCRIPTION_PROVIDER_NAMES)[number];

export interface TranscriptionRequest {
	audioPath: string;
	language?: string;
	offsetMs?: number;
	signal?: AbortSignal;
	onJobStarted?: (job: TranscriptionJob) => void | Promise<void>;
}

export interface TranscriptionJob {
	provider: TranscriptionProviderName;
	id: string;
}

export interface TranscriptionProvider {
	readonly name: TranscriptionProviderName;
	readonly revision: string;
	transcribe(request: TranscriptionRequest): Promise<HonomiyaTranscript>;
	resume?(
		job: TranscriptionJob,
		signal?: AbortSignal,
	): Promise<HonomiyaTranscript>;
	cancel?(job: TranscriptionJob): Promise<void>;
}

export interface TranscriptionProviderOptions {
	timestampBackend?: TimestampBackend;
	modal?: Omit<ModalTranscriptionProviderOptions, "timestampBackend">;
}

export function isTranscriptionProviderName(
	value: string,
): value is TranscriptionProviderName {
	return TRANSCRIPTION_PROVIDER_NAMES.some((name) => name === value);
}

export function createTranscriptionProvider(
	name: TranscriptionProviderName,
	options: TranscriptionProviderOptions = {},
): TranscriptionProvider {
	switch (name) {
		case "modal":
			return new ModalTranscriptionProvider({
				...options.modal,
				timestampBackend: options.timestampBackend,
			});
	}
}

import type { AlignmentReport } from "../alignment/sentences";
import type { AlignOptions } from "../options/align";
import type { TranscribeOptions } from "../options/transcribe";
import type { TranscriptionControls } from "../transcription/audio";
import type { TranscriptionCommandResult } from "../transcription/command";

export interface CliIO {
	readText(path: string): Promise<string>;
	writeStdout(message: string): void;
	writeStderr(message: string): void;
}

export interface CliCommands {
	align(
		options: AlignOptions,
		controls?: TranscriptionControls,
	): Promise<AlignmentReport>;
	transcribe?(
		options: TranscribeOptions,
		controls?: TranscriptionControls,
	): Promise<TranscriptionCommandResult>;
}

export interface CliContext {
	io: CliIO;
	commands: CliCommands;
	environment: Record<string, string | undefined>;
	controls: TranscriptionControls;
}

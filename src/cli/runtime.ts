import { executeAlignCommand } from "../alignment/publication";
import { executeTranscribeCommand } from "../transcription/command";
import type { CliCommands, CliIO } from "./types";

export const runtimeIO: CliIO = {
	readText: (path) => Bun.file(path).text(),
	writeStdout: (message) => process.stdout.write(message),
	writeStderr: (message) => process.stderr.write(message),
};

export const runtimeCommands: CliCommands = {
	align: async (options, controls) =>
		(await executeAlignCommand(options, controls)).alignment,
	transcribe: (options, controls) =>
		executeTranscribeCommand(options, undefined, controls),
};

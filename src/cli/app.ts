import packageJson from "../../package.json" with { type: "json" };
import { HONOMIYA_MANIFEST_SCHEMA } from "../artifacts/manifest";
import type { TranscriptionControls } from "../transcription/audio";
import { runAlignCommand } from "./commands/align";
import { runTranscribeCommand } from "./commands/transcribe";
import { runValidateCommand } from "./commands/validate";
import { runtimeCommands, runtimeIO } from "./runtime";
import type { CliCommands, CliContext, CliIO } from "./types";

const HELP = `Honomiya ${packageJson.version}

Usage:
  honomiya align --ebook <book.epub> --audio <track> --provider <local|modal> --srt
  honomiya align --ebook <book.epub> --audio <track> --timed-text <file.srt>
  honomiya transcribe --audio <track> --provider <local|modal>
  honomiya validate <manifest.json> [--json]
  honomiya --version
  honomiya --help

Commands:
  align       Align an ebook and one or more audiobook sources.
  transcribe  Transcribe one audiobook with resumable technical chunks.
  validate    Validate an ${HONOMIYA_MANIFEST_SCHEMA} sidecar and its invariants.

Quality:
  accurate    stable-ts + complete interpolation (default).
  fast        faster-whisper + conservative interpolation.
`;

export async function runCli(
	args: string[],
	io: CliIO = runtimeIO,
	commands: CliCommands = runtimeCommands,
	environment: Record<string, string | undefined> = process.env,
	controls: TranscriptionControls = {},
): Promise<number> {
	const [command, ...rest] = args;

	if (!command || command === "--help" || command === "-h") {
		io.writeStdout(HELP);
		return 0;
	}
	if (command === "--version" || command === "-v") {
		io.writeStdout(`${packageJson.version}\n`);
		return 0;
	}

	const context: CliContext = { io, commands, environment, controls };
	switch (command) {
		case "align":
			return runAlignCommand(rest, context);
		case "transcribe":
			return runTranscribeCommand(rest, context);
		case "validate":
			return runValidateCommand(rest, context);
		default:
			io.writeStderr(`Unknown command: ${command}\n\n${HELP}`);
			return 2;
	}
}

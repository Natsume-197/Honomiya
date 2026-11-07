import packageJson from "../../package.json" with { type: "json" };
import { HONOMIYA_MANIFEST_SCHEMA } from "../artifacts/manifest";
import type { TranscriptionControls } from "../transcription/audio";
import { runAlignCommand } from "./commands/align";
import { runCompareCommand } from "./commands/compare";
import { runEmitCommand } from "./commands/emit";
import { runModelsCommand } from "./commands/models";
import { runTranscribeCommand } from "./commands/transcribe";
import { runValidateCommand } from "./commands/validate";
import { runtimeCommands, runtimeIO } from "./runtime";
import type { CliCommands, CliContext, CliIO } from "./types";

const HELP = `Honomiya ${packageJson.version}

Usage:
  honomiya align --ebook <book.epub> --audio <track> --provider <local|modal> --srt
  honomiya align --ebook <book.epub> --audio <track> --timed-text <file.srt>
  honomiya align --ebook <book.epub> --audio <track> --engine ctc
  honomiya transcribe --audio <track> --provider <local|modal>
  honomiya emit --audio <track> [--model <id>]
  honomiya models <list|pull <id>>
  honomiya validate <manifest.json> [--json]
  honomiya compare <candidate.json> <reference.json> [--json]
  honomiya --version
  honomiya --help

Commands:
  align       Align an ebook and one or more audiobook sources.
  transcribe  Transcribe one audiobook with resumable technical chunks.
  emit        Compute reusable CTC emissions for one audiobook (experimental).
  models      List or download CTC acoustic models.
  validate    Validate an ${HONOMIYA_MANIFEST_SCHEMA} sidecar and its invariants.
  compare     Measure a manifest's cue timing against a reference manifest.

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
		case "emit":
			return runEmitCommand(rest, context);
		case "models":
			return runModelsCommand(rest, context);
		case "compare":
			return runCompareCommand(rest, context);
		default:
			io.writeStderr(`Unknown command: ${command}\n\n${HELP}`);
			return 2;
	}
}

import {
	parseTranscribeOptions,
	TranscribeOptionsError,
} from "../../options/transcribe";
import { prepareProgressReporting } from "../progress";
import type { CliContext } from "../types";

export const TRANSCRIBE_USAGE =
	"Usage: honomiya transcribe --audio <track> --provider <name> [--quality <accurate|fast>] [--output <transcript.json>] [--language <locale>] [--cache-dir <path>] [--max-chunk-minutes <number>] [--chunk-overlap-seconds <number>] [--parallel-chunks <integer>] [--timestamp-backend <faster-whisper|stable-ts>] [--retries <integer>] [--progress-json]\n";

export async function runTranscribeCommand(
	args: string[],
	context: CliContext,
): Promise<number> {
	if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
		context.io.writeStdout(TRANSCRIBE_USAGE);
		return 0;
	}

	try {
		const progress = prepareProgressReporting(
			args,
			context.io,
			context.controls,
		);
		const options = parseTranscribeOptions(progress.args, context.environment);
		if (!context.commands.transcribe) {
			throw new Error("The transcribe command is unavailable");
		}
		const result = await context.commands.transcribe(
			options,
			progress.controls,
		);
		context.io.writeStdout(
			`Transcribed ${result.transcript.durationMs} ms in ${result.chunks} chunk(s) into ${result.transcript.segments.length} segments with ${result.provider.name} (${result.cacheHits} cache hit(s), ${result.resumedJobs} resumed job(s), ${result.retries} retries).\n`,
		);
		return 0;
	} catch (error) {
		if (error instanceof TranscribeOptionsError) {
			context.io.writeStderr(`${error.message}\n${TRANSCRIBE_USAGE}`);
			return 2;
		}
		const message = error instanceof Error ? error.message : String(error);
		context.io.writeStderr(`Could not transcribe audio: ${message}\n`);
		return error instanceof Error && error.name === "AbortError" ? 130 : 1;
	}
}

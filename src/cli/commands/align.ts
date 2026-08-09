import { AlignOptionsError, parseAlignOptions } from "../../options/align";
import { prepareProgressReporting } from "../progress";
import type { CliContext } from "../types";

export const ALIGN_USAGE =
	"Usage: honomiya align --ebook <book.epub> --audio <track> [--audio <track> ...] (--provider <name> | --transcript <file> [--transcript <file> ...]) [--quality <accurate|fast>] [--output <alignment.json>] [--srt] [--language <locale>] [--cache-dir <path>] [--max-chunk-minutes <number>] [--chunk-overlap-seconds <number>] [--parallel-chunks <integer>] [--timestamp-backend <faster-whisper|stable-ts>] [--interpolation <off|conservative|complete>] [--retries <integer>] [--progress-json]\n";

export async function runAlignCommand(
	args: string[],
	context: CliContext,
): Promise<number> {
	if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
		context.io.writeStdout(ALIGN_USAGE);
		return 0;
	}

	try {
		const progress = prepareProgressReporting(
			args,
			context.io,
			context.controls,
		);
		const options = parseAlignOptions(progress.args, context.environment);
		const report = await context.commands.align(options, progress.controls);
		context.io.writeStdout(
			`Aligned ${report.directCues + report.interpolatedCues}/${report.bookSentences} sentences (${report.directCues} direct, ${report.interpolatedCues} interpolated).\n`,
		);
		return 0;
	} catch (error) {
		if (error instanceof AlignOptionsError) {
			context.io.writeStderr(`${error.message}\n${ALIGN_USAGE}`);
			return 2;
		}
		const message = error instanceof Error ? error.message : String(error);
		context.io.writeStderr(`Could not align publication: ${message}\n`);
		return error instanceof Error && error.name === "AbortError" ? 130 : 1;
	}
}

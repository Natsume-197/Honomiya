import { EmitOptionsError, parseEmitOptions } from "../../options/emit";
import { prepareProgressReporting } from "../progress";
import type { CliContext } from "../types";

export const EMIT_USAGE =
	"Usage: honomiya emit --audio <track> [--model <id>] [--language <locale>] [--output <emissions.bin>] [--model-dir <path>] [--cache-dir <path>] [--threads <integer>] [--top-k <integer>] [--chunk-minutes <number>] [--progress-json]\n";

export async function runEmitCommand(
	args: string[],
	context: CliContext,
): Promise<number> {
	if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
		context.io.writeStdout(EMIT_USAGE);
		return 0;
	}

	try {
		const progress = prepareProgressReporting(
			args,
			context.io,
			context.controls,
			"emit",
		);
		const options = parseEmitOptions(progress.args);
		if (!context.commands.emit) {
			throw new Error("The emit command is unavailable");
		}
		const result = await context.commands.emit(options, progress.controls);
		const audioSeconds = result.probe.durationMs / 1_000;
		const realtime = audioSeconds / Math.max(0.001, result.performance.totalMs / 1_000);
		context.io.writeStdout(
			`Emitted ${result.frames} frames with ${result.model.id} in ${result.chunks} chunk(s) (${result.cacheHits} cache hit(s)), ${(result.outputBytes / 2 ** 20).toFixed(1)} MiB, ${realtime.toFixed(1)}x realtime (model ${(result.performance.modelMs / 1_000).toFixed(1)} s, top-k ${(result.performance.selectMs / 1_000).toFixed(1)} s, waiting on decode ${(result.performance.decodeWaitMs / 1_000).toFixed(1)} s), to ${result.outputPath}.\n`,
		);
		return 0;
	} catch (error) {
		if (error instanceof EmitOptionsError) {
			context.io.writeStderr(`${error.message}\n${EMIT_USAGE}`);
			return 2;
		}
		const message = error instanceof Error ? error.message : String(error);
		context.io.writeStderr(`Could not emit audio: ${message}\n`);
		return error instanceof Error && error.name === "AbortError" ? 130 : 1;
	}
}

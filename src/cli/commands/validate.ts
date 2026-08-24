import { ZodError } from "zod";
import { parseHonomiyaManifest } from "../../artifacts/manifest";
import type { CliContext } from "../types";

export const VALIDATE_USAGE =
	"Usage: honomiya validate <manifest.json> [--json]\n";

export async function runValidateCommand(
	args: string[],
	context: CliContext,
): Promise<number> {
	if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
		context.io.writeStdout(VALIDATE_USAGE);
		return 0;
	}

	const jsonOutput = args.includes("--json");
	const positional = args.filter((argument) => argument !== "--json");
	if (positional.length !== 1 || !positional[0]) {
		context.io.writeStderr(VALIDATE_USAGE);
		return 2;
	}

	try {
		const raw = await context.io.readText(positional[0]);
		const manifest = parseHonomiyaManifest(JSON.parse(raw));
		const summary = {
			schema: manifest.schema,
			transcriptionOrigin: manifest.transcription?.origin ?? null,
			granularity: manifest.granularity,
			audioFiles: manifest.sources.audioFiles.length,
			cues: manifest.cues.length,
		};

		if (jsonOutput) {
			context.io.writeStdout(`${JSON.stringify(summary)}\n`);
		} else {
			context.io.writeStdout(
				`Valid ${manifest.schema} manifest (${summary.cues} cues, ${summary.audioFiles} audio files).\n`,
			);
		}
		return 0;
	} catch (error) {
		if (error instanceof ZodError) {
			const details = error.issues
				.map((issue) => {
					const path =
						issue.path.length > 0 ? issue.path.join(".") : "manifest";
					return `- ${path}: ${issue.message}`;
				})
				.join("\n");
			context.io.writeStderr(`Invalid Honomiya manifest:\n${details}\n`);
			return 1;
		}

		const message = error instanceof Error ? error.message : String(error);
		context.io.writeStderr(`Could not validate manifest: ${message}\n`);
		return 1;
	}
}

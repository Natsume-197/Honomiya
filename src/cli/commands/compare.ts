import { type ManifestComparison, compareManifests } from "../../artifacts/compare";
import { parseAnyHonomiyaManifest } from "../../artifacts/manifest";
import type { CliContext } from "../types";

export const COMPARE_USAGE =
	"Usage: honomiya compare <candidate.json> <reference.json> [--json]\n";

function formatComparison(result: ManifestComparison): string {
	const lines = [
		`Recall: ${(result.recall * 100).toFixed(1)}% (${result.matchedCues}/${result.referenceCues} reference cues)`,
		`Missing: ${result.missingCues}, extra: ${result.extraCues}, wrong audio file: ${result.wrongAudioFileCues}`,
	];
	if (result.startErrorMs && result.endErrorMs) {
		lines.push(
			`Start error ms: p50 ${result.startErrorMs.p50}, p90 ${result.startErrorMs.p90}, p99 ${result.startErrorMs.p99}, max ${result.startErrorMs.max}`,
			`End error ms:   p50 ${result.endErrorMs.p50}, p90 ${result.endErrorMs.p90}, p99 ${result.endErrorMs.p99}, max ${result.endErrorMs.max}`,
		);
	}
	if (result.meanIou !== null) {
		lines.push(`Mean IoU: ${result.meanIou.toFixed(3)}`);
	}
	lines.push(
		`Within tolerance: ${result.withinTolerance
			.map(
				({ toleranceMs, share }) =>
					`${toleranceMs}ms ${(share * 100).toFixed(1)}%`,
			)
			.join(", ")}`,
	);
	if (!result.sameEbook) lines.push("Warning: the ebooks differ.");
	if (!result.sameAudio) lines.push("Warning: the audio files differ.");
	return `${lines.join("\n")}\n`;
}

export async function runCompareCommand(
	args: string[],
	context: CliContext,
): Promise<number> {
	if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
		context.io.writeStdout(COMPARE_USAGE);
		return 0;
	}

	const jsonOutput = args.includes("--json");
	const positional = args.filter((argument) => argument !== "--json");
	const [candidatePath, referencePath] = positional;
	if (positional.length !== 2 || !candidatePath || !referencePath) {
		context.io.writeStderr(COMPARE_USAGE);
		return 2;
	}

	try {
		const [candidate, reference] = await Promise.all(
			[candidatePath, referencePath].map(async (path) =>
				parseAnyHonomiyaManifest(JSON.parse(await context.io.readText(path))),
			),
		);
		if (!candidate || !reference) throw new Error("Could not read manifests");
		const result = compareManifests(candidate, reference);
		context.io.writeStdout(
			jsonOutput ? `${JSON.stringify(result)}\n` : formatComparison(result),
		);
		return 0;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		context.io.writeStderr(`Could not compare manifests: ${message}\n`);
		return 1;
	}
}

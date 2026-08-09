import { dirname, join, parse } from "node:path";

function derivedPath(inputPath: string, suffix: string): string {
	return join(dirname(inputPath), `${parse(inputPath).name}.${suffix}`);
}

export function defaultAlignmentOutputPath(ebookPath: string): string {
	return derivedPath(ebookPath, "honomiya.alignment.json");
}

export function defaultTranscriptOutputPath(audioPath: string): string {
	return derivedPath(audioPath, "honomiya.transcript.json");
}

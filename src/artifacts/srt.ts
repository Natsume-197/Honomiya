import { dirname, join, parse } from "node:path";
import { writeTextAtomically } from "../support/json-file";

export interface SubtitleCue {
	audioFileIndex: number;
	startMs: number;
	endMs: number;
	text: string;
}

function srtTimestamp(milliseconds: number): string {
	const hours = Math.floor(milliseconds / 3_600_000);
	const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
	const seconds = Math.floor((milliseconds % 60_000) / 1_000);
	const remainder = milliseconds % 1_000;
	return [hours, minutes, seconds]
		.map((value) => value.toString().padStart(2, "0"))
		.join(":")
		.concat(",", remainder.toString().padStart(3, "0"));
}

export function renderSrt(cues: SubtitleCue[]): string {
	const entries = cues
		.filter((cue) => cue.endMs > cue.startMs && cue.text.trim())
		.sort((left, right) => left.startMs - right.startMs)
		.map((cue, index) => {
			const text = cue.text.replace(/\s+/gu, " ").trim();
			return `${index + 1}\n${srtTimestamp(cue.startMs)} --> ${srtTimestamp(cue.endMs)}\n${text}`;
		});
	return entries.length > 0 ? `${entries.join("\n\n")}\n` : "";
}

export function srtOutputPath(
	alignmentOutputPath: string,
	audioPath: string,
): string {
	return join(
		dirname(alignmentOutputPath),
		`${parse(audioPath).name}.honomiya.srt`,
	);
}

export async function writeSrtArtifacts(
	alignmentOutputPath: string,
	audioPaths: string[],
	cues: SubtitleCue[],
	writeText: (
		path: string,
		value: string,
	) => Promise<void> = writeTextAtomically,
): Promise<string[]> {
	const paths: string[] = [];
	for (const [audioFileIndex, audioPath] of audioPaths.entries()) {
		const audioCues = cues.filter(
			(cue) => cue.audioFileIndex === audioFileIndex,
		);
		if (audioCues.length === 0) continue;
		const path = srtOutputPath(alignmentOutputPath, audioPath);
		await writeText(path, renderSrt(audioCues));
		paths.push(path);
	}
	return paths;
}

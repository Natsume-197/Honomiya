import type {
	TranscriptionControls,
	TranscriptionProgress,
} from "../transcription/audio";
import type { CliIO } from "./types";

const PROGRESS_SCHEMA = "honomiya.progress.v1" as const;

function progressMessage(progress: TranscriptionProgress): string {
	const prefix = `Chunk ${progress.chunk}/${progress.totalChunks}`;
	switch (progress.state) {
		case "cached":
			return `${prefix}: cache hit`;
		case "starting":
			return `${prefix}: submitted to provider`;
		case "resuming":
			return `${prefix}: reattaching to pending provider job`;
		case "retrying":
			return `${prefix}: retrying (attempt ${progress.attempt})`;
		case "completed":
			return `${prefix}: completed`;
	}
}

function writeProgress(
	io: CliIO,
	progress: TranscriptionProgress,
	json: boolean,
): void {
	if (!json) {
		io.writeStderr(`${progressMessage(progress)}\n`);
		return;
	}
	io.writeStderr(
		`${JSON.stringify({
			schema: PROGRESS_SCHEMA,
			phase: "transcribe",
			sourceIndex: progress.sourceIndex ?? 0,
			totalSources: progress.totalSources ?? 1,
			chunk: progress.chunk,
			sourceChunks: progress.totalChunks,
			completedChunks:
				progress.overallCompletedChunks ?? progress.completedChunks,
			totalChunks: progress.overallTotalChunks ?? progress.totalChunks,
			state: progress.state,
			...(progress.attempt === undefined ? {} : { attempt: progress.attempt }),
		})}\n`,
	);
}

export function prepareProgressReporting(
	args: string[],
	io: CliIO,
	controls: TranscriptionControls,
): { args: string[]; controls: TranscriptionControls } {
	const json = args.includes("--progress-json");
	return {
		args: args.filter((argument) => argument !== "--progress-json"),
		controls: {
			...controls,
			onProgress: (progress) => {
				controls.onProgress?.(progress);
				writeProgress(io, progress, json);
			},
		},
	};
}

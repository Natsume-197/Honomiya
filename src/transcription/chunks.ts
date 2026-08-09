import { extname } from "node:path";

export const DEFAULT_MAX_CHUNK_DURATION_MS = 30 * 60 * 1_000;
export const DEFAULT_CHUNK_OVERLAP_MS = 5_000;

export interface AudioChapter {
	index: number;
	startMs: number;
	endMs: number;
	title?: string;
}

export interface AudioProbe {
	durationMs: number;
	chapters: AudioChapter[];
}

export interface AudioChunk {
	index: number;
	/** Extracted interval, including recognition context. */
	startMs: number;
	endMs: number;
	/** Canonical interval owned by this chunk in the merged transcript. */
	ownedStartMs: number;
	ownedEndMs: number;
	chapterIndexes: number[];
}

interface FfprobeChapter {
	start_time?: string;
	end_time?: string;
	tags?: { title?: string };
}

interface FfprobeDocument {
	format?: { duration?: string };
	chapters?: FfprobeChapter[];
}

function milliseconds(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const seconds = Number(value);
	if (!Number.isFinite(seconds) || seconds < 0) return undefined;
	return Math.round(seconds * 1_000);
}

export function parseFfprobeOutput(input: unknown): AudioProbe {
	const document = input as FfprobeDocument;
	const durationMs = milliseconds(document.format?.duration);
	if (!durationMs || durationMs <= 0) {
		throw new Error("ffprobe did not report a positive audio duration");
	}

	const chapters = (document.chapters ?? []).flatMap((chapter, index) => {
		const startMs = milliseconds(chapter.start_time);
		const endMs = milliseconds(chapter.end_time);
		if (
			startMs === undefined ||
			endMs === undefined ||
			endMs <= startMs ||
			startMs >= durationMs
		) {
			return [];
		}
		const title = chapter.tags?.title?.trim();
		return [
			{
				index,
				startMs,
				endMs: Math.min(durationMs, endMs),
				...(title ? { title } : {}),
			},
		];
	});

	return { durationMs, chapters };
}

async function runProcess(command: string[], purpose: string): Promise<string> {
	const process = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
	const [exitCode, stdout, stderr] = await Promise.all([
		process.exited,
		new Response(process.stdout).text(),
		new Response(process.stderr).text(),
	]);
	if (exitCode !== 0) {
		throw new Error(
			`${purpose} failed: ${stderr.trim() || `exit ${exitCode}`}`,
		);
	}
	return stdout;
}

export async function probeAudio(path: string): Promise<AudioProbe> {
	const output = await runProcess(
		[
			"ffprobe",
			"-v",
			"error",
			"-print_format",
			"json",
			"-show_format",
			"-show_chapters",
			path,
		],
		"ffprobe",
	);
	return parseFfprobeOutput(JSON.parse(output));
}

function uniqueSorted(values: number[]): number[] {
	return [...new Set(values)].sort((left, right) => left - right);
}

function splitBalanced(
	startMs: number,
	endMs: number,
	maxDurationMs: number,
): Array<{ startMs: number; endMs: number }> {
	const durationMs = endMs - startMs;
	const containerRoundingToleranceMs = Math.min(
		1_000,
		Math.floor(maxDurationMs * 0.01),
	);
	const count = Math.max(
		1,
		Math.ceil(
			Math.max(1, durationMs - containerRoundingToleranceMs) / maxDurationMs,
		),
	);
	return Array.from({ length: count }, (_, index) => ({
		startMs: startMs + Math.floor((durationMs * index) / count),
		endMs: startMs + Math.floor((durationMs * (index + 1)) / count),
	}));
}

function overlappingChapterIndexes(
	startMs: number,
	endMs: number,
	chapters: AudioChapter[],
): number[] {
	return chapters
		.filter((chapter) => chapter.startMs < endMs && chapter.endMs > startMs)
		.map((chapter) => chapter.index);
}

export function planAudioChunks(
	probe: AudioProbe,
	maxDurationMs = DEFAULT_MAX_CHUNK_DURATION_MS,
	overlapMs = DEFAULT_CHUNK_OVERLAP_MS,
): AudioChunk[] {
	if (!Number.isInteger(maxDurationMs) || maxDurationMs <= 0) {
		throw new Error("maxDurationMs must be a positive integer");
	}
	if (!Number.isInteger(overlapMs) || overlapMs < 0) {
		throw new Error("overlapMs must be a non-negative integer");
	}

	const boundaries = uniqueSorted([
		0,
		probe.durationMs,
		...probe.chapters.flatMap((chapter) => [
			Math.max(0, Math.min(probe.durationMs, chapter.startMs)),
			Math.max(0, Math.min(probe.durationMs, chapter.endMs)),
		]),
	]);
	const pieces = boundaries.slice(0, -1).flatMap((startMs, index) => {
		const endMs = boundaries[index + 1] ?? startMs;
		return endMs > startMs ? splitBalanced(startMs, endMs, maxDurationMs) : [];
	});

	const ranges: Array<{ startMs: number; endMs: number }> = [];
	for (const piece of pieces) {
		const current = ranges.at(-1);
		if (current && piece.endMs - current.startMs <= maxDurationMs) {
			current.endMs = piece.endMs;
		} else {
			ranges.push({ ...piece });
		}
	}

	return ranges.map((range, index) => {
		const durationMs = range.endMs - range.startMs;
		const previous = ranges[index - 1];
		const next = ranges[index + 1];
		const beforeContextMs = previous
			? Math.min(
					overlapMs,
					Math.floor(durationMs / 4),
					Math.floor((previous.endMs - previous.startMs) / 4),
				)
			: 0;
		const afterContextMs = next
			? Math.min(
					overlapMs,
					Math.floor(durationMs / 4),
					Math.floor((next.endMs - next.startMs) / 4),
				)
			: 0;
		return {
			index,
			startMs: Math.max(0, range.startMs - beforeContextMs),
			endMs: Math.min(probe.durationMs, range.endMs + afterContextMs),
			ownedStartMs: range.startMs,
			ownedEndMs: range.endMs,
			chapterIndexes: overlappingChapterIndexes(
				range.startMs,
				range.endMs,
				probe.chapters,
			),
		};
	});
}

export function chunkExtension(path: string): string {
	const extension = extname(path).toLowerCase();
	if ([".m4a", ".m4b", ".mp4", ".aac"].includes(extension)) return ".m4a";
	return extension || ".audio";
}

export async function extractAudioChunk(
	inputPath: string,
	chunk: AudioChunk,
	outputPath: string,
): Promise<void> {
	await runProcess(
		[
			"ffmpeg",
			"-hide_banner",
			"-loglevel",
			"error",
			"-ss",
			(chunk.startMs / 1_000).toFixed(3),
			"-i",
			inputPath,
			"-t",
			((chunk.endMs - chunk.startMs) / 1_000).toFixed(3),
			"-map",
			"0:a:0",
			"-vn",
			"-map_metadata",
			"-1",
			"-map_chapters",
			"-1",
			"-c:a",
			"copy",
			"-y",
			outputPath,
		],
		"ffmpeg",
	);
}

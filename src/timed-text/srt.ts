import { basename } from "node:path";
import { alignmentTokens } from "../alignment/text";
import {
	HONOMIYA_TRANSCRIPT_SCHEMA,
	type HonomiyaTranscript,
	parseHonomiyaTranscript,
} from "../transcription/transcript";
import type { TimedTextVerificationReport } from "./verify";

export const SRT_ADAPTER_REVISION = "honomiya.srt.v1" as const;
const MIN_DENSITY_ANOMALY_TOKENS = 200;
const MAX_TOKENS_PER_SECOND = 50;
const MAX_REPORTED_ISSUES = 100;

export type TimedTextIssueReason =
	| "malformed-cue"
	| "empty-text"
	| "non-positive-duration"
	| "after-audio"
	| "overlap"
	| "implausible-density";

export interface TimedTextIssue {
	cue: number;
	reason: TimedTextIssueReason;
}

export interface SrtCue {
	index: number;
	startMs: number;
	endMs: number;
	text: string;
}

export interface ParsedSrt {
	totalCues: number;
	cues: SrtCue[];
	issues: TimedTextIssue[];
}

export interface SrtTranscriptReport {
	format: "srt";
	revision: typeof SRT_ADAPTER_REVISION;
	filename: string;
	sha256: string;
	totalCues: number;
	usedCues: number;
	excludedCues: number;
	issueCounts: Partial<Record<TimedTextIssueReason, number>>;
	issues: TimedTextIssue[];
	verification?: TimedTextVerificationReport;
}

function declaredCueNumber(line: string | undefined): number | undefined {
	if (!line || !/^\d+$/u.test(line.trim())) return undefined;
	const value = Number(line.trim());
	return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function timestampMilliseconds(
	hours: string,
	minutes: string,
	seconds: string,
	milliseconds: string,
): number {
	return (
		Number(hours) * 3_600_000 +
		Number(minutes) * 60_000 +
		Number(seconds) * 1_000 +
		Number(milliseconds)
	);
}

const TIMING_PATTERN =
	/^(\d+):([0-5]\d):([0-5]\d)[,.](\d{3})\s+-->\s+(\d+):([0-5]\d):([0-5]\d)[,.](\d{3})(?:\s+.*)?$/u;

function decodeEntities(value: string): string {
	return value.replace(
		/&(?:amp|lt|gt|quot|apos|#39);/gu,
		(entity) =>
			({
				"&amp;": "&",
				"&lt;": "<",
				"&gt;": ">",
				"&quot;": '"',
				"&apos;": "'",
				"&#39;": "'",
			})[entity] ?? entity,
	);
}

function cleanCueText(lines: string[]): string {
	return decodeEntities(lines.join(" ").replace(/\\N/gu, " "))
		.replace(/<[^>]*>/gu, "")
		.replace(/\{\\[^}]*\}/gu, "")
		.replace(/\s+/gu, " ")
		.trim();
}

export function parseSrt(value: string): ParsedSrt {
	const lines = value
		.replace(/^\uFEFF/u, "")
		.replace(/\r\n?/gu, "\n")
		.split("\n");
	const cues: SrtCue[] = [];
	const issues: TimedTextIssue[] = [];
	let position = 0;
	let ordinal = 0;

	while (position < lines.length) {
		while (position < lines.length && !lines[position]?.trim()) position += 1;
		if (position >= lines.length) break;

		ordinal += 1;
		const declared = declaredCueNumber(lines[position]);
		if (declared !== undefined) {
			position += 1;
			while (position < lines.length && !lines[position]?.trim()) position += 1;
		}
		const cue = declared ?? ordinal;
		const timingLine = lines[position]?.trim() ?? "";
		const timing = TIMING_PATTERN.exec(timingLine);
		if (!timing) {
			issues.push({ cue, reason: "malformed-cue" });
			position += 1;
			while (position < lines.length) {
				const line = lines[position] ?? "";
				if (!line.trim()) {
					position += 1;
					break;
				}
				if (TIMING_PATTERN.test(line.trim())) break;
				if (
					declaredCueNumber(line) !== undefined &&
					TIMING_PATTERN.test(lines[position + 1]?.trim() ?? "")
				) {
					break;
				}
				position += 1;
			}
			continue;
		}
		position += 1;
		const startMs = timestampMilliseconds(
			timing[1] ?? "0",
			timing[2] ?? "0",
			timing[3] ?? "0",
			timing[4] ?? "0",
		);
		const endMs = timestampMilliseconds(
			timing[5] ?? "0",
			timing[6] ?? "0",
			timing[7] ?? "0",
			timing[8] ?? "0",
		);
		const textLines: string[] = [];
		while (position < lines.length) {
			const line = lines[position] ?? "";
			if (!line.trim()) {
				position += 1;
				break;
			}
			if (TIMING_PATTERN.test(line.trim())) break;
			if (
				declaredCueNumber(line) !== undefined &&
				TIMING_PATTERN.test(lines[position + 1]?.trim() ?? "")
			) {
				break;
			}
			textLines.push(line);
			position += 1;
		}
		const text = cleanCueText(textLines);
		if (endMs <= startMs) {
			issues.push({ cue, reason: "non-positive-duration" });
			continue;
		}
		if (!text) {
			issues.push({ cue, reason: "empty-text" });
			continue;
		}
		cues.push({ index: cue, startMs, endMs, text });
	}

	return { totalCues: ordinal, cues, issues };
}

function issueCounts(
	issues: TimedTextIssue[],
): Partial<Record<TimedTextIssueReason, number>> {
	const counts: Partial<Record<TimedTextIssueReason, number>> = {};
	for (const issue of issues) {
		counts[issue.reason] = (counts[issue.reason] ?? 0) + 1;
	}
	return counts;
}

function implausiblyDense(cue: SrtCue, language?: string): boolean {
	const tokens = alignmentTokens(cue.text, language).length;
	if (tokens < MIN_DENSITY_ANOMALY_TOKENS) return false;
	const durationSeconds = (cue.endMs - cue.startMs) / 1_000;
	return tokens / durationSeconds > MAX_TOKENS_PER_SECOND;
}

export function srtToTranscript(input: {
	text: string;
	path: string;
	sha256: string;
	audioPath: string;
	audioSha256: string;
	audioDurationMs: number;
	language?: string;
}): { transcript: HonomiyaTranscript; report: SrtTranscriptReport } {
	const parsed = parseSrt(input.text);
	const issues = [...parsed.issues];
	const accepted: SrtCue[] = [];
	for (const cue of parsed.cues) {
		if (cue.endMs > input.audioDurationMs) {
			issues.push({ cue: cue.index, reason: "after-audio" });
			continue;
		}
		if (implausiblyDense(cue, input.language)) {
			issues.push({ cue: cue.index, reason: "implausible-density" });
			continue;
		}
		const previous = accepted.at(-1);
		if (previous && cue.startMs < previous.endMs) {
			issues.push({ cue: cue.index, reason: "overlap" });
			continue;
		}
		accepted.push(cue);
	}
	if (accepted.length === 0) {
		throw new Error(
			`Timed-text file ${input.path} contains no usable SRT cues`,
		);
	}

	const transcript = parseHonomiyaTranscript({
		schema: HONOMIYA_TRANSCRIPT_SCHEMA,
		engine: {
			provider: "timed-text",
			model: "srt",
			revision: SRT_ADAPTER_REVISION,
		},
		source: {
			sha256: input.audioSha256,
			filename: basename(input.audioPath),
		},
		language: input.language || "und",
		offsetMs: 0,
		durationMs: input.audioDurationMs,
		segments: accepted.map((cue, id) => ({
			id,
			startMs: cue.startMs,
			endMs: cue.endMs,
			text: cue.text,
			words: [],
		})),
	});
	return {
		transcript,
		report: {
			format: "srt",
			revision: SRT_ADAPTER_REVISION,
			filename: basename(input.path),
			sha256: input.sha256,
			totalCues: parsed.totalCues,
			usedCues: accepted.length,
			excludedCues: parsed.totalCues - accepted.length,
			issueCounts: issueCounts(issues),
			issues: issues.slice(0, MAX_REPORTED_ISSUES),
		},
	};
}

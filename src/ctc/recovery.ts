import type { AudioChapter } from "../transcription/chunks";
import { frameDurationMs, greedyDecode, type CtcEmissions } from "./emissions";
import type { CtcAlignedCue } from "./align";

function normalize(text: string): string {
	return text.normalize("NFKC").replace(/[^\p{L}\p{N}]/gu, "");
}

function lowerBound(values: number[], threshold: number): number {
	let lo = 0;
	let hi = values.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (values[mid]! < threshold) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

/** Independent of the forced text path, but uses the same acoustic model. */
export function recoveryEvidence(track: CtcEmissions) {
	const decoded = greedyDecode(track);
	const times: number[] = [];
	let letters = "";
	let index = 0;
	for (const symbol of decoded.text) {
		const ms = (track.header.startFrame + decoded.frames[index++]!) * frameDurationMs(track.header);
		const normalized = normalize(symbol);
		letters += normalized;
		for (let i = 0; i < normalized.length; i++) times.push(ms);
	}
	return (row: CtcAlignedCue) => {
		if (row.evidence.kind !== "direct") return false;
		const text = normalize(row.text);
		const heard = letters.slice(lowerBound(times, row.cue.startMs - 1000), lowerBound(times, row.cue.endMs + 1801));
		for (let i = 0; i + 3 <= text.length; i++)
			if (heard.includes(text.slice(i, i + 3))) return true;
		return false;
	};
}

export function supportedRecovery(rows: CtcAlignedCue[], evidence: (row: CtcAlignedCue) => boolean) {
	const full = Math.floor(rows.length / 8);
	if (full < 3) return [];
	const accepted: CtcAlignedCue[] = [];
	let supportedFull = 0;
	for (let i = 0; i < rows.length; i += 8) {
		const block = rows.slice(i, i + 8);
		const hits = block.map(evidence);
		const mid = Math.ceil(block.length / 2);
		if (hits.filter(Boolean).length < 3 || !hits.slice(0, mid).some(Boolean) || !hits.slice(mid).some(Boolean)) continue;
		if (block.length === 8) supportedFull++;
		accepted.push(...block.filter(row => row.evidence.kind === "direct"));
	}
	return supportedFull >= 0.9 * full ? accepted : [];
}

/** Duplicate headings are common in anthologies. A title alone cannot disambiguate them. */
export function matchingChapter(section: string, headings: Map<string,string>, chapters: AudioChapter[]) {
	const title = normalize(headings.get(section) ?? "");
	if (title.length < 4) return;
	const bookMatches = [...headings.values()].filter(text => normalize(text) === title);
	if (bookMatches.length !== 1) return;
	const audioMatches = chapters.filter(c => normalize(c.title ?? "") === title);
	return audioMatches.length === 1 ? audioMatches[0] : undefined;
}

export interface AudioWindow {
	startMs: number;
	endMs: number;
}

const MAX_WINDOW_MS = 1_500_000;
const WINDOW_OVERLAP_MS = 120_000;
const CHAPTER_PAD_MS = 60_000;
const MIN_WINDOW_MS = 15_000;

function mergeIntervals(intervals: AudioWindow[]): AudioWindow[] {
	if (!intervals.length) return [];
	const sorted = intervals
		.filter(i => i.endMs > i.startMs)
		.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
	if (!sorted.length) return [];
	const merged: AudioWindow[] = [{ ...sorted[0]! }];
	for (let i = 1; i < sorted.length; i++) {
		const cur = sorted[i]!;
		const last = merged.at(-1)!;
		if (cur.startMs <= last.endMs) last.endMs = Math.max(last.endMs, cur.endMs);
		else merged.push({ ...cur });
	}
	return merged;
}

function coveredMs(window: AudioWindow, occupied: AudioWindow[]): number {
	let total = 0;
	for (const span of occupied) {
		if (span.endMs <= window.startMs) continue;
		if (span.startMs >= window.endMs) break;
		total += Math.min(window.endMs, span.endMs) - Math.max(window.startMs, span.startMs);
	}
	return total;
}

function splitLongWindow(window: AudioWindow): AudioWindow[] {
	if (window.endMs - window.startMs <= MAX_WINDOW_MS + WINDOW_OVERLAP_MS) return [window];
	const out: AudioWindow[] = [];
	const step = MAX_WINDOW_MS - WINDOW_OVERLAP_MS;
	for (let start = window.startMs; start < window.endMs; start += step) {
		const end = Math.min(window.endMs, start + MAX_WINDOW_MS);
		out.push({ startMs: start, endMs: end });
		if (end >= window.endMs) break;
	}
	return out;
}

/**
 * Partitions unoccupied audio into bounded search windows (<= ~25 min) so
 * 4-gram anchor search avoids full-book collisions. Uses audiobook chapter
 * marks when available (with small edge padding for straddling groups) and
 * falls back to overlapping spans over free gaps otherwise.
 */
export function freeAudioWindows(
	durationMs: number,
	occupied: AudioWindow[],
	chapters: AudioChapter[],
): AudioWindow[] {
	if (durationMs < MIN_WINDOW_MS) return [];
	const merged = mergeIntervals(occupied);
	const raw: AudioWindow[] = [];
	if (chapters.length >= 2) {
		for (const ch of chapters) {
			const startMs = Math.max(0, ch.startMs);
			const endMs = Math.min(durationMs, ch.endMs);
			if (endMs - startMs < MIN_WINDOW_MS) continue;
			if (coveredMs({ startMs, endMs }, merged) / (endMs - startMs) >= 0.85) continue;
			raw.push({
				startMs: Math.max(0, startMs - CHAPTER_PAD_MS),
				endMs: Math.min(durationMs, endMs + CHAPTER_PAD_MS),
			});
		}
	} else {
		let cursor = 0;
		for (const span of merged) {
			if (span.startMs - cursor >= MIN_WINDOW_MS) raw.push({ startMs: cursor, endMs: span.startMs });
			cursor = Math.max(cursor, span.endMs);
		}
		if (durationMs - cursor >= MIN_WINDOW_MS) raw.push({ startMs: cursor, endMs: durationMs });
	}
	return raw.flatMap(splitLongWindow);
}

/** Splits a run of >= 24 sentences into balanced groups of ~24–40 sentences. */
export function balancedGroups<T>(items: T[], targetSize = 32): T[][] {
	if (items.length < 24) return [];
	const count = Math.max(1, Math.round(items.length / targetSize));
	const groups: T[][] = [];
	let offset = 0;
	for (let i = 0; i < count; i++) {
		const size = Math.ceil((items.length - offset) / (count - i));
		groups.push(items.slice(offset, offset + size));
		offset += size;
	}
	return groups;
}

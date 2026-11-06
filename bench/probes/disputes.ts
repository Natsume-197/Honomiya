// Head-to-head probe: lists sentences whose start differs by more than a
// threshold between two manifests of the same ebook and audio, with their
// text, for an independent judge (bench/probes/judge.py).
// bun disputes.ts <ebook> <a.json> <b.json> <out.json> [thresholdMs] [max]
import { readFileSync, writeFileSync } from "node:fs";
import { extractEbookSentences } from "../../src/alignment/ebook-text";
import { parseAnyHonomiyaManifest } from "../../src/artifacts/manifest";
import { openEbookFile } from "../../src/ebook-parser/node";

const [ebookPath, aPath, bPath, outPath, thresholdArg, maxArg] = process.argv.slice(2);
const threshold = Number(thresholdArg ?? 2000);
const max = Number(maxArg ?? 80);
const ebook = await openEbookFile(ebookPath!);
const sentences = await extractEbookSentences(ebook, "ja");
await ebook.close();
const text = new Map(sentences.map((sentence) => [sentence.id, sentence.text]));
const a = parseAnyHonomiyaManifest(JSON.parse(readFileSync(aPath!, "utf8")));
const b = parseAnyHonomiyaManifest(JSON.parse(readFileSync(bPath!, "utf8")));
const bById = new Map(b.cues.map((cue) => [cue.id, cue]));

const disputes = [];
let both = 0;
for (const cue of a.cues) {
	const other = bById.get(cue.id);
	if (!other) continue;
	both += 1;
	const sentence = text.get(cue.id) ?? "";
	// Short sentences are ambiguous to judge; keep ones with substance.
	if (Math.abs(cue.startMs - other.startMs) <= threshold || Array.from(sentence).length < 8) continue;
	disputes.push({
		id: cue.id,
		text: sentence,
		a: { startMs: cue.startMs, endMs: cue.endMs },
		b: { startMs: other.startMs, endMs: other.endMs },
	});
}
// Deterministic spread across the book.
const step = Math.max(1, disputes.length / max);
const sample = Array.from({ length: Math.min(max, disputes.length) }, (_, i) => disputes[Math.floor(i * step)]);
writeFileSync(outPath!, JSON.stringify(sample));
console.log(JSON.stringify({ aCues: a.cues.length, bCues: b.cues.length, both, disputes: disputes.length, sampled: sample.length }));

// Reference text for an audio window, from an SRT-derived manifest, scored
// against a greedy CTC decode. Usage:
// bun window-text.ts <ebook> <manifest> <startSec> <durationSec> <decoded.txt> <vocab.txt>
import { readFileSync } from "node:fs";
import { extractEbookSentences } from "../../src/alignment/ebook-text";
import { openEbookFile } from "../../src/ebook-parser/node";

const [ebookPath, manifestPath, startArg, durationArg, decodedPath, vocabPath] =
	process.argv.slice(2);
const startMs = Number(startArg) * 1000;
const endMs = startMs + Number(durationArg) * 1000;

const ebook = await openEbookFile(ebookPath!);
const sentences = await extractEbookSentences(ebook, "ja");
await ebook.close();
const byId = new Map(sentences.map((sentence) => [sentence.id, sentence]));
const manifest = JSON.parse(readFileSync(manifestPath!, "utf8"));
const cues = manifest.cues.filter(
	(cue: { startMs: number; endMs: number }) =>
		cue.startMs >= startMs && cue.endMs <= endMs,
);
const keep = (text: string) =>
	Array.from(text.normalize("NFKC")).filter((c) => /[\p{L}\p{N}]/u.test(c));
const reference = keep(
	cues.map((cue: { id: string }) => byId.get(cue.id)?.text ?? "").join(""),
);
const hypothesis = keep(readFileSync(decodedPath!, "utf8"));
const vocab = new Set(
	readFileSync(vocabPath!, "utf8")
		.split("\n")
		.map((line) => (line.split(" ")[0] ?? "").normalize("NFKC")),
);

function editDistance(a: string[], b: string[]): number {
	let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
	for (let i = 1; i <= a.length; i += 1) {
		const current = [i];
		for (let j = 1; j <= b.length; j += 1) {
			current[j] = Math.min(
				previous[j]! + 1,
				current[j - 1]! + 1,
				previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
			);
		}
		previous = current;
	}
	return previous[b.length]!;
}

const bookChars = sentences.flatMap((sentence) => keep(sentence.text));
const oov = bookChars.filter((c) => !vocab.has(c));
const oovTypes = new Map<string, number>();
for (const c of oov) oovTypes.set(c, (oovTypes.get(c) ?? 0) + 1);
console.log(
	JSON.stringify({
		cues: cues.length,
		referenceChars: reference.length,
		hypothesisChars: hypothesis.length,
		cer: Number((editDistance(reference, hypothesis) / reference.length).toFixed(3)),
		bookChars: bookChars.length,
		oovRate: Number((oov.length / bookChars.length).toFixed(4)),
		topOov: [...oovTypes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15),
		referenceStart: reference.slice(0, 80).join(""),
	}),
);

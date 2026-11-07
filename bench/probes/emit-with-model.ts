// Phase 6 probe: emits a whole track with an arbitrary ONNX export of a known
// model (for example a quantized one) and reports throughput.
// bun emit-with-model.ts <audio> <model.onnx> <vocab.txt> <out.bin> <cacheDir> [threads]
import { writeFileSync } from "node:fs";
import { emitAudio } from "../../src/ctc/emit";
import { encodeEmissions } from "../../src/ctc/emissions";
import { CTC_MODELS } from "../../src/ctc/models";
import { hashFileSha256 } from "../../src/support/file-hash";

const [audioPath, modelPath, vocabularyPath, outPath, cacheDir, threadsArg] = process.argv.slice(2);
const base = CTC_MODELS["quartznet15x5-ja"];
const result = await emitAudio({
	audioPath: audioPath!,
	audioSha256: await hashFileSha256(audioPath!),
	model: {
		descriptor: { ...base, revision: `${base.revision}+${modelPath!.split("/").pop()}` },
		directory: "",
		modelPath: modelPath!,
		vocabularyPath: vocabularyPath!,
	},
	cacheDir: cacheDir!,
	threads: threadsArg ? Number(threadsArg) : undefined,
});
writeFileSync(outPath!, encodeEmissions(result.emissions));
const audioSeconds = result.probe.durationMs / 1000;
console.log(
	JSON.stringify({
		model: modelPath,
		hours: Number((audioSeconds / 3600).toFixed(2)),
		xRT: Number((audioSeconds / (result.performance.totalMs / 1000)).toFixed(1)),
		...result.performance,
	}),
);

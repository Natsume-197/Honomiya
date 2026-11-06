import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importQuantizedModel, requireInstalledModel } from "./model-store";
import { CTC_MODELS, type CtcModelDescriptor } from "./models";

const VOCABULARY = "あ 0\n<blk> 1\n";
const WEIGHTS = "fp32-weights";
const descriptor: CtcModelDescriptor = {
	...CTC_MODELS["quartznet15x5-ja"],
	revision: "test.1",
	files: {
		model: { name: "model.onnx", url: "https://example.invalid/m", bytes: WEIGHTS.length, sha256: "0".repeat(64) },
		vocabulary: { name: "vocab.txt", url: "https://example.invalid/v", bytes: Buffer.byteLength(VOCABULARY), sha256: "0".repeat(64) },
	},
};

let root: string | undefined;
afterEach(async () => {
	if (root) await rm(root, { recursive: true, force: true });
});

async function installFp32(): Promise<string> {
	root = await mkdtemp(join(tmpdir(), "honomiya-models-"));
	const directory = join(root, descriptor.id, descriptor.revision);
	await mkdir(directory, { recursive: true });
	await writeFile(join(directory, "vocab.txt"), VOCABULARY);
	await writeFile(join(directory, "model.onnx"), WEIGHTS);
	return root;
}

describe("model store precision", () => {
	test("auto falls back to fp32 when no int8 variant is imported", async () => {
		const models = await installFp32();
		const model = await requireInstalledModel(descriptor, models, "auto");
		expect(model.precision).toBe("fp32");
		expect(model.descriptor.revision).toBe("test.1");
		await expect(requireInstalledModel(descriptor, models, "int8")).rejects.toThrow(/models import/);
	});

	test("imports an int8 variant and prefers it under auto", async () => {
		const models = await installFp32();
		const source = join(models, "quantized.onnx");
		await writeFile(source, "int8-weights");
		const imported = await importQuantizedModel(descriptor, models, source, () => new Date(0));
		expect(imported.precision).toBe("int8");
		expect(imported.descriptor.revision).toMatch(/^test\.1\+int8\.[0-9a-f]{12}$/u);

		const auto = await requireInstalledModel(descriptor, models, "auto");
		expect(auto.precision).toBe("int8");
		expect(auto.modelPath.endsWith("model.int8.onnx")).toBe(true);
		expect((await requireInstalledModel(descriptor, models, "fp32")).precision).toBe("fp32");
	});

	test("needs the vocabulary before importing", async () => {
		root = await mkdtemp(join(tmpdir(), "honomiya-models-"));
		const source = join(root, "quantized.onnx");
		await writeFile(source, "int8-weights");
		await expect(importQuantizedModel(descriptor, root, source)).rejects.toThrow(/models pull/);
	});
});

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

describe("pullModel", () => {
	test("downloads and verifies a published int8 variant", async () => {
		const { createHash } = await import("node:crypto");
		const { pullModel } = await import("./model-store");
		const digest = (text: string) => createHash("sha256").update(text).digest("hex");
		const bodies: Record<string, string> = {
			"https://example.invalid/v": VOCABULARY,
			"https://example.invalid/m": WEIGHTS,
			"https://example.invalid/i": "int8-weights",
		};
		const published: CtcModelDescriptor = {
			...descriptor,
			files: {
				model: { ...descriptor.files.model, sha256: digest(WEIGHTS) },
				vocabulary: { ...descriptor.files.vocabulary, sha256: digest(VOCABULARY) },
				modelInt8: {
					name: "model.int8.onnx",
					url: "https://example.invalid/i",
					bytes: "int8-weights".length,
					sha256: digest("int8-weights"),
				},
			},
		};
		root = await mkdtemp(join(tmpdir(), "honomiya-models-"));
		const fakeFetch = (async (url: string) => new Response(bodies[url] ?? "", { status: bodies[url] ? 200 : 404 })) as unknown as typeof fetch;
		const installed = await pullModel(published, root, { fetch: fakeFetch, now: () => new Date(0) });
		expect(installed.precision).toBe("fp32");
		const auto = await requireInstalledModel(published, root, "auto");
		expect(auto.precision).toBe("int8");
		expect(auto.descriptor.revision).toBe(`test.1+int8.${digest("int8-weights").slice(0, 12)}`);
	});
});

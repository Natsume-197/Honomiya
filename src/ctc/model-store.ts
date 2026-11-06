import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { CtcModelDescriptor, CtcModelFile } from "./models";

export const CTC_PRECISIONS = ["fp32", "int8"] as const;
export type CtcPrecision = (typeof CTC_PRECISIONS)[number];

export function isCtcPrecision(value: string): value is CtcPrecision {
	return CTC_PRECISIONS.some((precision) => precision === value);
}

export interface InstalledCtcModel {
	/** For int8, the revision names the quantized file's hash. */
	descriptor: CtcModelDescriptor;
	directory: string;
	modelPath: string;
	vocabularyPath: string;
	precision?: CtcPrecision;
}

const INT8_MODEL_FILE = "model.int8.onnx";
const INT8_SIDECAR_FILE = "model.int8.json";
const VARIANT_SCHEMA = "honomiya.model-variant.v1";

interface VariantSidecar {
	schema: typeof VARIANT_SCHEMA;
	precision: "int8";
	sha256: string;
	bytes: number;
	source: string;
	importedAt: string;
}

export function defaultModelDirectory(
	environment: Record<string, string | undefined> = process.env,
): string {
	if (environment.HONOMIYA_MODEL_DIR) return environment.HONOMIYA_MODEL_DIR;
	const cacheRoot =
		environment.XDG_CACHE_HOME ??
		(process.platform === "win32" && environment.LOCALAPPDATA
			? environment.LOCALAPPDATA
			: join(homedir(), ".cache"));
	return join(cacheRoot, "honomiya", "models");
}

function modelDirectory(root: string, descriptor: CtcModelDescriptor): string {
	return join(root, descriptor.id, descriptor.revision);
}

async function hasExpectedSize(path: string, file: CtcModelFile) {
	const handle = Bun.file(path);
	return (await handle.exists()) && handle.size === file.bytes;
}

/**
 * Finds an installed model. Sizes are checked on every call; hashes are
 * checked when the model is pulled.
 */
export async function findInstalledModel(
	descriptor: CtcModelDescriptor,
	root: string,
): Promise<InstalledCtcModel | undefined> {
	const directory = modelDirectory(root, descriptor);
	const modelPath = join(directory, descriptor.files.model.name);
	const vocabularyPath = join(directory, descriptor.files.vocabulary.name);
	const present = await Promise.all([
		hasExpectedSize(modelPath, descriptor.files.model),
		hasExpectedSize(vocabularyPath, descriptor.files.vocabulary),
	]);
	if (!present.every(Boolean)) return undefined;
	return { descriptor, directory, modelPath, vocabularyPath };
}

/**
 * Finds a locally imported int8 variant. It reuses the fp32 vocabulary; the
 * fp32 weights themselves are not needed.
 */
export async function findQuantizedModel(
	descriptor: CtcModelDescriptor,
	root: string,
): Promise<InstalledCtcModel | undefined> {
	const directory = modelDirectory(root, descriptor);
	const vocabularyPath = join(directory, descriptor.files.vocabulary.name);
	const modelPath = join(directory, INT8_MODEL_FILE);
	const sidecarFile = Bun.file(join(directory, INT8_SIDECAR_FILE));
	if (
		!(await hasExpectedSize(vocabularyPath, descriptor.files.vocabulary)) ||
		!(await sidecarFile.exists())
	) {
		return undefined;
	}
	let sidecar: VariantSidecar;
	try {
		sidecar = JSON.parse(await sidecarFile.text()) as VariantSidecar;
	} catch {
		return undefined;
	}
	const model = Bun.file(modelPath);
	if (sidecar.schema !== VARIANT_SCHEMA || !(await model.exists()) || model.size !== sidecar.bytes) {
		return undefined;
	}
	return {
		descriptor: {
			...descriptor,
			revision: `${descriptor.revision}+int8.${sidecar.sha256.slice(0, 12)}`,
		},
		directory,
		modelPath,
		vocabularyPath,
		precision: "int8",
	};
}

/**
 * Resolves the model to run. `auto` prefers an imported int8 variant (about
 * twice as fast on ARM CPUs, same alignment accuracy in Phase 6).
 */
export async function requireInstalledModel(
	descriptor: CtcModelDescriptor,
	root: string,
	precision: CtcPrecision | "auto" = "fp32",
): Promise<InstalledCtcModel> {
	if (precision !== "fp32") {
		const quantized = await findQuantizedModel(descriptor, root);
		if (quantized) return quantized;
		if (precision === "int8") {
			throw new Error(
				`No int8 variant of ${descriptor.id} is installed in ${root}; run: honomiya models import ${descriptor.id} --int8 <model.onnx>`,
			);
		}
	}
	const installed = await findInstalledModel(descriptor, root);
	if (!installed) {
		throw new Error(
			`CTC model ${descriptor.id} is not installed in ${root}; run: honomiya models pull ${descriptor.id}`,
		);
	}
	return { ...installed, precision: "fp32" };
}

/** Registers a quantized ONNX export of a model, recording its hash. */
export async function importQuantizedModel(
	descriptor: CtcModelDescriptor,
	root: string,
	sourcePath: string,
	now: () => Date = () => new Date(),
): Promise<InstalledCtcModel> {
	const directory = modelDirectory(root, descriptor);
	const vocabularyPath = join(directory, descriptor.files.vocabulary.name);
	if (!(await hasExpectedSize(vocabularyPath, descriptor.files.vocabulary))) {
		throw new Error(
			`Install ${descriptor.id} first (its vocabulary is shared): honomiya models pull ${descriptor.id}`,
		);
	}
	const source = Bun.file(sourcePath);
	if (!(await source.exists())) throw new Error(`${sourcePath} does not exist`);
	const hash = createHash("sha256");
	for await (const chunk of source.stream()) hash.update(chunk);
	const temporaryPath = join(directory, `${INT8_MODEL_FILE}.tmp-${process.pid}-${randomUUID()}`);
	await copyFile(sourcePath, temporaryPath);
	await rename(temporaryPath, join(directory, INT8_MODEL_FILE));
	const sidecar: VariantSidecar = {
		schema: VARIANT_SCHEMA,
		precision: "int8",
		sha256: hash.digest("hex"),
		bytes: source.size,
		source: basename(sourcePath),
		importedAt: now().toISOString(),
	};
	await Bun.write(join(directory, INT8_SIDECAR_FILE), `${JSON.stringify(sidecar, null, 2)}\n`);
	const installed = await findQuantizedModel(descriptor, root);
	if (!installed) throw new Error("Could not register the int8 model");
	return installed;
}

export interface PullProgress {
	file: string;
	receivedBytes: number;
	totalBytes: number;
}

async function downloadVerified(
	file: CtcModelFile,
	destination: string,
	fetchImpl: typeof fetch,
	onProgress?: (progress: PullProgress) => void,
	signal?: AbortSignal,
): Promise<void> {
	const response = await fetchImpl(file.url, { signal });
	if (!response.ok || !response.body) {
		throw new Error(`Could not download ${file.url}: HTTP ${response.status}`);
	}
	const temporaryPath = `${destination}.tmp-${process.pid}-${randomUUID()}`;
	const hash = createHash("sha256");
	const writer = Bun.file(temporaryPath).writer();
	let receivedBytes = 0;
	try {
		for await (const chunk of response.body) {
			hash.update(chunk);
			writer.write(chunk);
			receivedBytes += chunk.byteLength;
			onProgress?.({ file: file.name, receivedBytes, totalBytes: file.bytes });
		}
		await writer.end();
		const digest = hash.digest("hex");
		if (receivedBytes !== file.bytes || digest !== file.sha256) {
			throw new Error(
				`${file.name} failed verification (expected ${file.bytes} bytes, sha256 ${file.sha256}; got ${receivedBytes} bytes, sha256 ${digest})`,
			);
		}
		await rename(temporaryPath, destination);
	} catch (error) {
		await rm(temporaryPath, { force: true });
		throw error;
	}
}

export async function pullModel(
	descriptor: CtcModelDescriptor,
	root: string,
	options: {
		fetch?: typeof fetch;
		onProgress?: (progress: PullProgress) => void;
		signal?: AbortSignal;
		now?: () => Date;
	} = {},
): Promise<InstalledCtcModel> {
	const directory = modelDirectory(root, descriptor);
	await mkdir(directory, { recursive: true });
	for (const file of [descriptor.files.vocabulary, descriptor.files.model]) {
		const destination = join(directory, file.name);
		if (await hasExpectedSize(destination, file)) continue;
		await downloadVerified(
			file,
			destination,
			options.fetch ?? fetch,
			options.onProgress,
			options.signal,
		);
	}
	const int8 = descriptor.files.modelInt8;
	if (int8 && !(await hasExpectedSize(join(directory, INT8_MODEL_FILE), int8))) {
		await downloadVerified(
			int8,
			join(directory, INT8_MODEL_FILE),
			options.fetch ?? fetch,
			options.onProgress,
			options.signal,
		);
		const sidecar: VariantSidecar = {
			schema: VARIANT_SCHEMA,
			precision: "int8",
			sha256: int8.sha256,
			bytes: int8.bytes,
			source: int8.url,
			importedAt: (options.now ?? (() => new Date()))().toISOString(),
		};
		await Bun.write(join(directory, INT8_SIDECAR_FILE), `${JSON.stringify(sidecar, null, 2)}\n`);
	}
	return requireInstalledModel(descriptor, root);
}

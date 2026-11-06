import type { CtcModelDescriptor } from "./models";

export interface AcousticModelOutput {
	frames: number;
	classes: number;
	/** Row-major [frames, classes] log probabilities. */
	logProbabilities: Float32Array;
}

/** Runs one window of mono PCM through a CTC model. */
export interface AcousticModel {
	run(samples: Float32Array): Promise<AcousticModelOutput>;
	close(): Promise<void>;
}

type OnnxRuntime = typeof import("onnxruntime-node");

async function loadOnnxRuntime(): Promise<OnnxRuntime> {
	try {
		return await import("onnxruntime-node");
	} catch (error) {
		const detail = error instanceof Error ? `: ${error.message}` : "";
		throw new Error(
			`CTC emission requires the onnxruntime-node package${detail}`,
		);
	}
}

function normalizeWaveform(samples: Float32Array): Float32Array {
	let mean = 0;
	for (const value of samples) mean += value;
	mean /= samples.length || 1;
	let variance = 0;
	for (const value of samples) variance += (value - mean) ** 2;
	const scale = 1 / Math.sqrt(variance / (samples.length || 1) + 1e-7);
	const normalized = new Float32Array(samples.length);
	for (let index = 0; index < samples.length; index += 1) {
		normalized[index] = ((samples[index] ?? 0) - mean) * scale;
	}
	return normalized;
}

/** In-place log-softmax over each row of a [frames, classes] matrix. */
export function logSoftmaxRows(
	values: Float32Array,
	frames: number,
	classes: number,
): void {
	for (let frame = 0; frame < frames; frame += 1) {
		const offset = frame * classes;
		let max = Number.NEGATIVE_INFINITY;
		for (let k = 0; k < classes; k += 1) {
			max = Math.max(max, values[offset + k] ?? Number.NEGATIVE_INFINITY);
		}
		let sum = 0;
		for (let k = 0; k < classes; k += 1) {
			sum += Math.exp((values[offset + k] ?? 0) - max);
		}
		const logSum = max + Math.log(sum);
		for (let k = 0; k < classes; k += 1) {
			values[offset + k] = (values[offset + k] ?? 0) - logSum;
		}
	}
}

export async function openOnnxAcousticModel(
	modelPath: string,
	descriptor: CtcModelDescriptor,
	options: { threads: number; frontendPath?: string },
): Promise<AcousticModel> {
	const ort = await loadOnnxRuntime();
	const sessionOptions = {
		intraOpNumThreads: options.threads,
		interOpNumThreads: 1,
		graphOptimizationLevel: "all" as const,
	};
	const session = await ort.InferenceSession.create(modelPath, sessionOptions);
	if (descriptor.input === "features" && !options.frontendPath) {
		throw new Error(`${descriptor.id} needs its mel frontend`);
	}
	const frontend =
		descriptor.input === "features" && options.frontendPath
			? await ort.InferenceSession.create(options.frontendPath, sessionOptions)
			: undefined;
	const inputName = session.inputNames[0];
	const outputName = session.outputNames[0];
	if (!inputName || !outputName) {
		throw new Error(`${modelPath} has no inputs or outputs`);
	}

	return {
		async run(samples) {
			let tensor: InstanceType<typeof ort.Tensor>;
			if (frontend) {
				const features = (
					await frontend.run({
						[frontend.inputNames[0] ?? "signal"]: new ort.Tensor("float32", samples, [1, 1, samples.length]),
					})
				)[frontend.outputNames[0] ?? "features"];
				if (!features) throw new Error("The mel frontend returned no features");
				tensor = features as InstanceType<typeof ort.Tensor>;
			} else {
				tensor =
					descriptor.input === "signal"
						? new ort.Tensor("float32", samples, [1, 1, samples.length])
						: new ort.Tensor("float32", normalizeWaveform(samples), [1, samples.length]);
			}
			const output = (await session.run({ [inputName]: tensor }))[outputName];
			if (!output || output.type !== "float32" || output.dims.length !== 3) {
				throw new Error(`${modelPath} did not return [batch, frames, classes]`);
			}
			const frames = Number(output.dims[1]);
			const classes = Number(output.dims[2]);
			const logProbabilities = output.data as Float32Array;
			if (descriptor.input === "input-values") {
				logSoftmaxRows(logProbabilities, frames, classes);
			}
			return { frames, classes, logProbabilities };
		},
		async close() {
			await session.release();
			await frontend?.release();
		},
	};
}

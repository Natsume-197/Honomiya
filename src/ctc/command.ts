import type { EmitOptions } from "../options/emit";
import { hashFileSha256 } from "../support/file-hash";
import { writeBytesAtomically } from "../support/json-file";
import type { TranscriptionControls } from "../transcription/audio";
import { type EmitAudioResult, emitAudio } from "./emit";
import { encodeEmissions } from "./emissions";
import { defaultModelDirectory, requireInstalledModel } from "./model-store";
import { ctcModel } from "./models";

export interface EmitCommandResult extends Omit<EmitAudioResult, "emissions"> {
	outputPath: string;
	outputBytes: number;
	frames: number;
	model: { id: string; revision: string };
}

export async function executeEmitCommand(
	options: EmitOptions,
	controls: TranscriptionControls = {},
	environment: Record<string, string | undefined> = process.env,
): Promise<EmitCommandResult> {
	const descriptor = ctcModel(options.model);
	const installed = await requireInstalledModel(
		descriptor,
		options.modelDir ?? defaultModelDirectory(environment),
		options.precision ?? "auto",
	);
	const audioSha256 = await hashFileSha256(options.audioPath);
	const { emissions, ...result } = await emitAudio({
		audioPath: options.audioPath,
		audioSha256,
		model: installed,
		cacheDir: options.cacheDir ?? `${options.outputPath}.cache`,
		threads: options.threads,
		topK: options.topK,
		chunkMinutes: options.chunkMinutes,
		signal: controls.signal,
		onProgress: controls.onProgress,
	});
	const bytes = encodeEmissions(emissions);
	await writeBytesAtomically(options.outputPath, bytes);
	return {
		...result,
		outputPath: options.outputPath,
		outputBytes: bytes.byteLength,
		frames: emissions.header.frames,
		model: { id: descriptor.id, revision: installed.descriptor.revision },
	};
}

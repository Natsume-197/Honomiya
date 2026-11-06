import {
	defaultModelDirectory,
	findInstalledModel,
	findQuantizedModel,
	importQuantizedModel,
	pullModel,
} from "../../ctc/model-store";
import { CTC_MODELS, ctcModel } from "../../ctc/models";
import type { CliContext } from "../types";

export const MODELS_USAGE =
	"Usage: honomiya models list [--model-dir <path>]\n       honomiya models pull <id> [--model-dir <path>]\n       honomiya models import <id> --int8 <model.onnx> [--model-dir <path>]\n";

function extractModelDir(args: string[]): { args: string[]; modelDir?: string } {
	const position = args.indexOf("--model-dir");
	if (position === -1) return { args };
	const modelDir = args[position + 1];
	if (!modelDir || modelDir.startsWith("--")) {
		throw new Error("--model-dir requires a value");
	}
	return {
		args: args.filter((_, index) => index !== position && index !== position + 1),
		modelDir,
	};
}

export async function runModelsCommand(
	args: string[],
	context: CliContext,
): Promise<number> {
	if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
		context.io.writeStdout(MODELS_USAGE);
		return args.length === 0 ? 2 : 0;
	}

	try {
		const parsed = extractModelDir(args);
		const root = parsed.modelDir ?? defaultModelDirectory(context.environment);
		const [subcommand, ...rest] = parsed.args;
		if (subcommand === "list" && rest.length === 0) {
			for (const descriptor of Object.values(CTC_MODELS)) {
				const installed = await findInstalledModel(descriptor, root);
				const quantized = await findQuantizedModel(descriptor, root);
				const megabytes = (
					(descriptor.files.model.bytes + descriptor.files.vocabulary.bytes) /
					2 ** 20
				).toFixed(0);
				context.io.writeStdout(
					`${descriptor.id}\t${descriptor.languages.join(",")}\t${megabytes} MiB\t${installed ? "installed" : "not installed"}${quantized ? `\tint8 ${quantized.descriptor.revision}` : ""}\n`,
				);
			}
			context.io.writeStdout(`Model directory: ${root}\n`);
			return 0;
		}
		if (subcommand === "pull" && rest.length === 1 && rest[0]) {
			const descriptor = ctcModel(rest[0]);
			context.io.writeStderr(
				`Downloading ${descriptor.id} from ${descriptor.source}. ${descriptor.licenseNote}\n`,
			);
			let lastReported = -1;
			const installed = await pullModel(descriptor, root, {
				signal: context.controls.signal,
				onProgress: ({ file, receivedBytes, totalBytes }) => {
					const percent = Math.floor((receivedBytes / totalBytes) * 10) * 10;
					if (percent === lastReported) return;
					lastReported = percent;
					context.io.writeStderr(`${file}: ${percent}%\n`);
				},
			});
			context.io.writeStdout(`Installed ${descriptor.id} in ${installed.directory}\n`);
			return 0;
		}
		if (subcommand === "import" && rest.length === 3 && rest[0] && rest[1] === "--int8" && rest[2]) {
			const descriptor = ctcModel(rest[0]);
			const installed = await importQuantizedModel(descriptor, root, rest[2]);
			context.io.writeStdout(
				`Imported int8 ${descriptor.id} as ${installed.descriptor.revision}; emit and align use it by default (--precision fp32 to opt out).\n`,
			);
			return 0;
		}
		context.io.writeStderr(MODELS_USAGE);
		return 2;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		context.io.writeStderr(`Could not manage models: ${message}\n`);
		return 1;
	}
}

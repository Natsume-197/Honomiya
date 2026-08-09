#!/usr/bin/env bun

import { runCli } from "./cli/app";
import { runtimeCommands, runtimeIO } from "./cli/runtime";

export { runCli } from "./cli/app";
export type { CliCommands, CliIO } from "./cli/types";

if (import.meta.main) {
	const controller = new AbortController();
	const cancel = () => controller.abort();
	process.once("SIGINT", cancel);
	try {
		process.exitCode = await runCli(
			Bun.argv.slice(2),
			runtimeIO,
			runtimeCommands,
			process.env,
			{ signal: controller.signal },
		);
	} finally {
		process.removeListener("SIGINT", cancel);
	}
}

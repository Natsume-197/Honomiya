import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export async function writeJsonAtomically(
	path: string,
	value: unknown,
): Promise<void> {
	await writeTextAtomically(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function writeTextAtomically(
	path: string,
	value: string,
): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
	await writeFile(temporaryPath, value, "utf8");
	await rename(temporaryPath, path);
}

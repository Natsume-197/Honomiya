/**
 * Decodes part of an audio file to mono float32 PCM through ffmpeg's stdout,
 * so no intermediate files are written.
 */
export async function decodePcm(
	path: string,
	options: {
		startMs: number;
		durationMs: number;
		sampleRate: number;
		signal?: AbortSignal;
	},
): Promise<Float32Array> {
	const process = Bun.spawn(
		[
			"ffmpeg",
			"-nostdin",
			"-hide_banner",
			"-loglevel",
			"error",
			"-ss",
			(options.startMs / 1_000).toFixed(3),
			"-i",
			path,
			"-t",
			(options.durationMs / 1_000).toFixed(3),
			"-map",
			"0:a:0",
			"-vn",
			"-ac",
			"1",
			"-ar",
			String(options.sampleRate),
			"-f",
			"f32le",
			"-",
		],
		{ stdout: "pipe", stderr: "pipe", signal: options.signal },
	);
	const [exitCode, bytes, stderr] = await Promise.all([
		process.exited,
		new Response(process.stdout).arrayBuffer(),
		new Response(process.stderr).text(),
	]);
	if (exitCode !== 0) {
		throw new Error(`ffmpeg decode failed: ${stderr.trim() || `exit ${exitCode}`}`);
	}
	return new Float32Array(bytes, 0, Math.floor(bytes.byteLength / 4));
}

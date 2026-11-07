import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { EmitOptionsError, parseEmitOptions } from "./emit";

describe("parseEmitOptions", () => {
	test("defaults the model and the output beside the audio", () => {
		const options = parseEmitOptions(["--audio", join("books", "book.m4b")]);
		expect(options).toEqual({
			audioPath: join("books", "book.m4b"),
			outputPath: join("books", "book.honomiya.emissions.bin"),
			model: "quartznet15x5-ja",
		});
	});

	test("selects the model from the language and parses numbers", () => {
		expect(
			parseEmitOptions([
				"--audio",
				"a.m4b",
				"--language",
				"ja-JP",
				"--threads",
				"4",
				"--top-k",
				"8",
				"--chunk-minutes",
				"2.5",
			]),
		).toMatchObject({ model: "quartznet15x5-ja", threads: 4, topK: 8, chunkMinutes: 2.5 });
	});

	test("rejects unsupported values", () => {
		expect(() => parseEmitOptions([])).toThrow(EmitOptionsError);
		expect(() => parseEmitOptions(["--audio", "a.m4b", "--model", "x"])).toThrow(
			/Unsupported CTC model/,
		);
		expect(() => parseEmitOptions(["--audio", "a.m4b", "--language", "eo"])).toThrow(
			/No CTC model/,
		);
		expect(() => parseEmitOptions(["--audio", "a.m4b", "--threads", "0"])).toThrow(
			/positive integer/,
		);
		expect(() => parseEmitOptions(["--audio", "a.m4b", "--output", "a.m4b"])).toThrow(
			/overwrite/,
		);
	});
});

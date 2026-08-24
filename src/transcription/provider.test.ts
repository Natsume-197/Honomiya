import { describe, expect, test } from "bun:test";
import {
	createTranscriptionProvider,
	isTranscriptionProviderName,
} from "./provider";

describe("transcription providers", () => {
	test("recognizes supported provider names", () => {
		expect(isTranscriptionProviderName("modal")).toBe(true);
		expect(isTranscriptionProviderName("local")).toBe(true);
		expect(isTranscriptionProviderName("unknown")).toBe(false);
	});

	test("creates the selected provider", () => {
		expect(createTranscriptionProvider("local").name).toBe("local");
		expect(createTranscriptionProvider("modal").name).toBe("modal");
	});
});

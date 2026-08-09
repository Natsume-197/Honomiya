import type { TimestampBackend } from "../transcription/transcript";

export const QUALITY_PRESETS = ["accurate", "fast"] as const;
export type QualityPreset = (typeof QUALITY_PRESETS)[number];

export const DEFAULT_QUALITY: QualityPreset = "accurate";

export const QUALITY_SETTINGS: Record<
	QualityPreset,
	{
		timestampBackend: TimestampBackend;
		interpolationMode: "conservative" | "complete";
	}
> = {
	accurate: {
		timestampBackend: "stable-ts",
		interpolationMode: "complete",
	},
	fast: {
		timestampBackend: "faster-whisper",
		interpolationMode: "conservative",
	},
};

export function isQualityPreset(value: string): value is QualityPreset {
	return QUALITY_PRESETS.some((preset) => preset === value);
}

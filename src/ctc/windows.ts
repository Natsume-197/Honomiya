/**
 * Inference windows over a span of decoded audio. Every window starts on the
 * frame grid, so frame `f` of a window is global frame `startFrame + f` and
 * windows stitch together without resampling. Each window keeps only the
 * frames it owns; the context on either side is discarded because a
 * convolutional model sees less context there.
 */
export interface InferenceWindow {
	/** First decoded sample fed to the model, relative to the span. */
	startSample: number;
	endSample: number;
	/** Global frames whose emissions this window contributes. */
	ownedStartFrame: number;
	ownedEndFrame: number;
}

export interface WindowPlanInput {
	/** Global frame index of the span's first decoded sample. */
	spanStartFrame: number;
	/** Decoded samples available, a multiple of samplesPerFrame or not. */
	spanSamples: number;
	/** Global frames this span must produce. */
	ownedStartFrame: number;
	ownedEndFrame: number;
	samplesPerFrame: number;
	windowFrames: number;
	contextFrames: number;
}

export function planInferenceWindows(input: WindowPlanInput): InferenceWindow[] {
	const {
		spanStartFrame,
		spanSamples,
		ownedStartFrame,
		ownedEndFrame,
		samplesPerFrame,
		windowFrames,
		contextFrames,
	} = input;
	const spanFrames = Math.floor(spanSamples / samplesPerFrame);
	const spanEndFrame = spanStartFrame + spanFrames;
	if (
		ownedStartFrame < spanStartFrame ||
		ownedEndFrame > spanEndFrame ||
		ownedEndFrame <= ownedStartFrame
	) {
		throw new Error("Owned frames must lie inside the decoded span");
	}
	const stride = windowFrames - 2 * contextFrames;
	if (stride <= 0) throw new Error("Window must be longer than its context");

	const windows: InferenceWindow[] = [];
	for (let owned = ownedStartFrame; owned < ownedEndFrame; owned += stride) {
		const ownedEnd = Math.min(ownedEndFrame, owned + stride);
		let start = Math.max(spanStartFrame, owned - contextFrames);
		const end = Math.min(spanEndFrame, start + windowFrames);
		// Near the end of the span, slide back to keep a full window.
		start = Math.max(spanStartFrame, Math.min(start, end - windowFrames));
		windows.push({
			startSample: (start - spanStartFrame) * samplesPerFrame,
			endSample: Math.min(spanSamples, (end - spanStartFrame) * samplesPerFrame),
			ownedStartFrame: owned,
			ownedEndFrame: ownedEnd,
		});
	}
	return windows;
}

export interface TechnicalChunk {
	index: number;
	/** Global frames the chunk produces. */
	ownedStartFrame: number;
	ownedEndFrame: number;
	/** Global frames decoded, including context on both sides. */
	decodeStartFrame: number;
	decodeEndFrame: number;
}

/**
 * Splits a track into technical chunks for decoding, caching and progress.
 * Chunks overlap by `contextFrames` so the first and last window of a chunk
 * still see context from its neighbours.
 */
export function planTechnicalChunks(
	totalFrames: number,
	chunkFrames: number,
	contextFrames: number,
): TechnicalChunk[] {
	if (totalFrames <= 0) return [];
	const count = Math.max(1, Math.ceil(totalFrames / chunkFrames));
	const size = Math.ceil(totalFrames / count);
	return Array.from({ length: count }, (_, index) => {
		const ownedStartFrame = index * size;
		const ownedEndFrame = Math.min(totalFrames, ownedStartFrame + size);
		return {
			index,
			ownedStartFrame,
			ownedEndFrame,
			decodeStartFrame: Math.max(0, ownedStartFrame - contextFrames),
			decodeEndFrame: Math.min(totalFrames, ownedEndFrame + contextFrames),
		};
	}).filter((chunk) => chunk.ownedEndFrame > chunk.ownedStartFrame);
}

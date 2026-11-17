/** Percent of the audio read so far: half away from zero, clamped 0..100. */
export function toPercent(positionMs: number, durationMs: number): number {
  if (durationMs <= 0) return 0;
  const percent = Math.round((100 * positionMs) / durationMs);
  return Math.min(100, Math.max(0, percent));
}

/** Passes on a percent only when it changed, so 36 000 frames make at most 101 updates. */
export function distinctPercent(report: (percent: number) => void): (percent: number) => void {
  let last = -1;
  return (percent) => {
    if (percent === last) return;
    last = percent;
    report(percent);
  };
}

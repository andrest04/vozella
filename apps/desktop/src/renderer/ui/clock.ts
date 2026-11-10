/** m:ss, or h:mm:ss from one hour. Non-finite or negative input reads as 0:00. */
export function formatClock(seconds: number): string {
  const whole = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const s = String(whole % 60).padStart(2, '0');
  const m = Math.floor(whole / 60);
  if (m < 60) return `${String(m)}:${s}`;
  return `${String(Math.floor(m / 60))}:${String(m % 60).padStart(2, '0')}:${s}`;
}

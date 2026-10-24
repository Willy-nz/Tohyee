/** How long the build took, in words: "22 seconds", "1 minute 40 seconds". */
export function buildTime(seconds: number | null): string | null {
  if (seconds === null) return null;
  const whole = Math.max(1, Math.round(seconds));
  const minutes = Math.floor(whole / 60);
  const rest = whole % 60;
  const part = (value: number, unit: string) => `${value} ${unit}${value === 1 ? "" : "s"}`;
  return minutes === 0 ? part(rest, "second") : rest === 0 ? part(minutes, "minute") : `${part(minutes, "minute")} ${part(rest, "second")}`;
}

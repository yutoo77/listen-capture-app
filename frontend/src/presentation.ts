export function formatTime(milliseconds: number): string {
  const seconds = Math.max(
    0,
    Math.floor(Number.isFinite(milliseconds) ? milliseconds / 1000 : 0),
  );
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
export function dateLabel(date: string): string {
  return new Date(date).toLocaleString("ja-JP", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

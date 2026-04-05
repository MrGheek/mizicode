export function getLocalHHMM(timezone: string): string {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);

  const hourRaw = parseInt(parts.find((p) => p.type === "hour")?.value ?? "0");
  const hour = hourRaw % 24;
  const minute = parts.find((p) => p.type === "minute")?.value ?? "00";
  return `${String(hour).padStart(2, "0")}:${minute.padStart(2, "0")}`;
}

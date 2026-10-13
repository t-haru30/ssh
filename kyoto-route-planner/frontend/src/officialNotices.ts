import { isRecord } from "./apiValidation";

export type OfficialNotice = { text: string; url: string; starts_on: string; ends_on: string };

export function readOfficialNotices(value: unknown, publicUrl: (value: unknown) => string | null): OfficialNotice[] {
  if (!Array.isArray(value)) return [];
  const date = (value: unknown): value is string => typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString().slice(0, 10) === value;
  for (const item of value) {
    if (!isRecord(item) || typeof item.text !== "string" || !item.text.trim()
      || !date(item.starts_on) || !date(item.ends_on) || item.starts_on > item.ends_on) continue;
    const url = publicUrl(item.url);
    if (url) return [{ text: item.text.trim(), url, starts_on: item.starts_on, ends_on: item.ends_on }];
  }
  return [];
}

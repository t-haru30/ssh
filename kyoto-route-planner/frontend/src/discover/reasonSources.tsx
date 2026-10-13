export type ReasonSource = { title: string; url: string };
export function publicReasonUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password
      || !url.hostname.includes(".") || /(?:^|\.)(?:localhost|local|internal)$/.test(url.hostname)
      || /^\d[\d.]+$/.test(url.hostname) || url.hostname.includes(":")) return null;
    return url.href;
  } catch { return null; }
}
export function isReasonSource(item: unknown): item is ReasonSource {
  if (!item || typeof item !== "object") return false;
  const source = item as ReasonSource;
  return typeof source.title === "string" && Boolean(source.title.trim()) && source.title.length <= 300 && publicReasonUrl(source.url) !== null;
}
export function isReasonSources(value: unknown): boolean {
  return value === undefined || Array.isArray(value) && value.length <= 24 && value.every(isReasonSource);
}
export function ReasonSources({ sources }: { sources: unknown }) {
  const safeSources = Array.isArray(sources) ? sources.slice(0, 24).filter(isReasonSource).filter((source, index, all) => all.findIndex(item => item.url === source.url) === index) : [];
  if (!safeSources.length) return null;
  return <p className="place-details-source recommendation-sources" onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}>
    見どころの出典：{safeSources.map((source, index) => <span key={source.url}>{index > 0 && "・"}<a href={source.url} target="_blank" rel="noopener noreferrer">{source.title}</a></span>)}
  </p>;
}

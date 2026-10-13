/** Prefer a complete, concrete sentence over cutting the whole route explanation. */
export function conciseReason(reason: string): string {
  const text = reason.replace(/\s+/g, " ").trim();
  const sentences = text.match(/[^。！？!?]+[。！？!?]?/g) ?? [];
  const candidates = sentences.map(sentence => sentence.trim());
  const appeal = candidates.filter(sentence => !/ペースで|分滞在|最遠|移動距離/.test(sentence));
  const preferred = appeal.length ? appeal : candidates;
  const first = preferred[0] ?? text;
  const placePrefix = first.match(/^([^：:。！？!?]{1,40}[：:])/)?.[1] ?? "";
  const samePlace: string[] = [];
  for (const sentence of candidates.slice(candidates.indexOf(first))) {
    if (samePlace.length && /ペースで|分滞在|最遠|移動距離|を巡ります|で巡る候補として/.test(sentence)) break;
    if (samePlace.length && /^[^：:。！？!?]{1,40}[：:]/.test(sentence)) break;
    samePlace.push(sentence);
    if (!placePrefix) break;
  }
  const alternatives = samePlace.map((sentence, index) => index === 0 ? sentence : placePrefix + sentence);
  const complete = alternatives.find(sentence => /[。！？!?]$/.test(sentence) && Array.from(sentence).length <= 60);
  if (complete) return complete;
  if (Array.from(first).length <= 59 || Array.from(first).length === 60 && /[。！？!?]$/.test(first)) {
    return /[。！？!?]$/.test(first) ? first : `${first}。`;
  }
  const compact = first.replace(/[（(][^）)]*[）)]/g, "").trim();
  if (Array.from(compact).length <= 59) return /[。！？!?]$/.test(compact) ? compact : `${compact}。`;
  for (const sentence of samePlace) {
    const clause = sentence.split("、").at(-1)?.trim() ?? "";
    const standalone = placePrefix + clause;
    if (sentence.includes("、") && /(?:です|ます|でした|ません|である|できる|楽しめる|味わえる)[。！？!?]$/.test(clause)
      && Array.from(standalone).length <= 60) return standalone;
  }
  // Unstructured long sentences have no safe grammatical rewrite without inventing facts.
  const prefix = Array.from(compact).slice(0, 59).join("");
  const boundary = Math.max(prefix.lastIndexOf("、"), prefix.lastIndexOf("；"));
  return `${boundary >= 20 ? prefix.slice(0, boundary) : prefix}…`;
}

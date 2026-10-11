const TECHNICAL_PATTERN = /API|データ形式|有効な.*返されませんでした|サーバー|Failed to fetch|NetworkError|Load failed|^HTTP \d+/i;

export const ROUTE_FAILURE_MESSAGE =
  "うまくルートを作れませんでした。立ち寄り先を減らす・日時を変える・別のルートを選ぶ、のいずれかをお試しください。";

export const NETWORK_FAILURE_MESSAGE =
  "通信がうまくいきませんでした。電波の良い場所でもう一度お試しください。";

// APIやデータ形式に触れる技術的な文言は、次の行動が分かる文言に置き換える
export function toFriendlyMessage(cause: unknown, fallback: string = ROUTE_FAILURE_MESSAGE): string {
  if (cause instanceof TypeError) return NETWORK_FAILURE_MESSAGE;
  if (!(cause instanceof Error) || !cause.message) return fallback;
  if (/Failed to fetch|NetworkError|Load failed/i.test(cause.message)) return NETWORK_FAILURE_MESSAGE;
  return TECHNICAL_PATTERN.test(cause.message) ? fallback : cause.message;
}

export function isEstimatedLeg(leg: { line_name: string }): boolean {
  return leg.line_name.includes("（概算）");
}

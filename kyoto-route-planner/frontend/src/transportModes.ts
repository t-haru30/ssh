const transportModeLabels: Record<string, string> = {
  walk: "徒歩",
  foot: "徒歩",
  car: "車",
  public_transport: "公共交通",
  train: "電車",
  rail: "電車",
  subway: "地下鉄",
  bus: "バス",
};

export function formatTransportModes(modes: readonly string[]) {
  const labels = [...new Set(modes.map((mode) => transportModeLabels[mode] ?? "その他"))];
  return labels.length > 0 ? labels.join("・") : "未設定";
}

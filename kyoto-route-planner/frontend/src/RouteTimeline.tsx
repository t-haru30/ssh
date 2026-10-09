import type { RouteLeg, RouteTimelineItem } from "./types";

type RouteTimelineProps = {
  items: RouteTimelineItem[];
  legs: RouteLeg[];
};

function modeLabel(mode: string) {
  if (mode.toLowerCase().includes("train")) return "電車";
  if (mode.toLowerCase().includes("bus")) return "バス";
  if (mode.toLowerCase().includes("walk")) return "徒歩";
  return "乗換・移動";
}

function modeIcon(mode: string) {
  if (mode.toLowerCase().includes("train")) return "電";
  if (mode.toLowerCase().includes("bus")) return "バ";
  if (mode.toLowerCase().includes("walk")) return "歩";
  return "›";
}

function formatDuration(minutes: number | null) {
  if (minutes === null) return "時間情報なし";
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return hours > 0 ? `${hours}時間${remainder}分` : `${remainder}分`;
}

function roleLabel(role: "start" | "stop" | "finish", index: number) {
  if (role === "start") return "出発";
  if (role === "finish") return "帰着";
  return `立ち寄り ${String(index).padStart(2, "0")}`;
}

export function RouteTimeline({ items, legs }: RouteTimelineProps) {
  let stopIndex = 0;
  return (
    <section className="route-timeline" aria-label="時系列のルート行程">
      <ol className="timeline-list">
        {items.map((item, index) => {
          if (item.type === "transit") {
            return (
              <li className="timeline-row timeline-transit" key={`transit-${index}`}>
                <time className="timeline-time">
                  {item.start_time ?? "—"}
                  {item.end_time && <span>〜{item.end_time}</span>}
                </time>
                <span className="timeline-marker transit-marker" aria-hidden="true">↗</span>
                <div className="timeline-transit-copy">
                  <strong>公共交通・徒歩などで移動</strong>
                  <span>{item.from_name} <b>→</b> {item.to_name}</span>
                  <small>
                    {item.duration_minutes === null
                      ? "所要時間不明"
                      : `約${formatDuration(item.duration_minutes)} · 区間別の目安`}
                  </small>
                </div>
              </li>
            );
          }

          if (item.role === "stop") stopIndex += 1;
          return (
            <li className={`timeline-row timeline-spot timeline-${item.role}`} key={`spot-${item.place_id ?? index}`}>
              <time className="timeline-time">{item.time ?? "—"}</time>
              <span className="timeline-marker" aria-hidden="true">
                {item.role === "start" ? "出" : item.role === "finish" ? "帰" : stopIndex}
              </span>
              <article className="timeline-spot-card">
                <small>{roleLabel(item.role, stopIndex)}</small>
                <strong>{item.name}</strong>
                {item.category && item.role === "stop" && <span className="timeline-category">{item.category}</span>}
                {item.stay_minutes > 0 && (
                  <span className="timeline-stay">滞在目安 {formatDuration(item.stay_minutes)}</span>
                )}
              </article>
            </li>
          );
        })}
      </ol>

      {legs.length > 0 && (
        <details className="timeline-route-details">
          <summary>駅すぱあと経路の詳細（{legs.length}区間）</summary>
          <ol className="leg-list">
            {legs.map((leg, index) => (
              <li className="leg-row" key={`${index}-${leg.line_name}`}>
                <span className={`leg-icon leg-${leg.mode.toLowerCase()}`}>{modeIcon(leg.mode)}</span>
                <div className="leg-copy">
                  <span>{leg.from_name} <b>→</b> {leg.to_name}</span>
                  <strong>{leg.line_name}</strong>
                </div>
                <span className="leg-duration">
                  {leg.duration_minutes === null ? modeLabel(leg.mode) : `${leg.duration_minutes}分`}
                </span>
              </li>
            ))}
          </ol>
        </details>
      )}
    </section>
  );
}

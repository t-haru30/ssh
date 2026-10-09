import type {
  DailyItinerary,
  Origin,
  Place,
  RouteLeg,
  RouteTimelineItem,
} from "./types";

type TimelineSpot = Extract<RouteTimelineItem, { type: "spot" }> & {
  detail?: string;
  label?: string;
};

type TimelineTransit = Extract<RouteTimelineItem, { type: "transit" }> & {
  summary?: string;
  detail?: string;
  legs?: RouteLeg[];
  detailsLabel?: string;
};

export type TimelineItem = TimelineSpot | TimelineTransit;

type RouteTimelineProps = {
  items: TimelineItem[];
};

function formatDuration(minutes: number | null) {
  if (minutes === null) return "時間情報なし";
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return hours > 0 ? `${hours}時間${remainder}分` : `${remainder}分`;
}

function durationBetween(start: string | null, end: string | null) {
  if (!start || !end) return null;
  const toMinutes = (value: string) => {
    const [hours, minutes] = value.split(":").map(Number);
    return hours * 60 + minutes;
  };
  const difference = toMinutes(end) - toMinutes(start);
  return difference < 0 ? difference + 24 * 60 : difference;
}

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

function buildDistanceSegments(
  origin: Origin,
  places: Place[],
  totalMinutes: number | null,
) {
  const points = [
    [origin.latitude, origin.longitude] as const,
    ...places.map((place) => [place.latitude, place.longitude] as const),
    [origin.latitude, origin.longitude] as const,
  ];
  const distances = points.slice(1).map((point, index) => {
    const [latitude1, longitude1] = points[index];
    const [latitude2, longitude2] = point;
    const toRadians = (degrees: number) => degrees * Math.PI / 180;
    const latitudeDelta = toRadians(latitude2 - latitude1);
    const longitudeDelta = toRadians(longitude2 - longitude1);
    const haversine = Math.sin(latitudeDelta / 2) ** 2
      + Math.cos(toRadians(latitude1))
      * Math.cos(toRadians(latitude2))
      * Math.sin(longitudeDelta / 2) ** 2;
    return 6371 * 2 * Math.asin(Math.sqrt(haversine));
  });
  const distanceTotal = distances.reduce((sum, distance) => sum + distance, 0);
  const durationTotal = totalMinutes !== null && Number.isFinite(totalMinutes)
    ? Math.max(0, Math.round(totalMinutes))
    : null;
  const durations = distances.map((distance) => (
    durationTotal === null
      ? null
      : distanceTotal === 0
        ? Math.floor(durationTotal / distances.length)
        : Math.floor(durationTotal * distance / distanceTotal)
  ));
  if (durationTotal !== null && durations.length > 0) {
    const assigned = durations.reduce<number>((sum, duration) => sum + (duration ?? 0), 0);
    durations[durations.length - 1] = (durations[durations.length - 1] ?? 0)
      + durationTotal - assigned;
  }
  return durations;
}

export function buildRouteTimeline(
  origin: Origin,
  places: Place[],
  departureTime: string | null,
  totalMinutes: number | null,
): TimelineItem[] {
  const departureParts = departureTime?.match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  let currentMinutes = departureParts
    ? Number(departureParts[1]) * 60 + Number(departureParts[2])
    : null;
  const durations = buildDistanceSegments(origin, places, totalMinutes);
  const formatTime = (minutes: number | null) => (
    minutes === null
      ? null
      : `${String(Math.floor(minutes / 60) % 24).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`
  );
  const items: TimelineItem[] = [{
    type: "spot",
    role: "start",
    place_id: null,
    name: origin.name,
    category: "出発地",
    time: formatTime(currentMinutes),
    stay_minutes: 0,
  }];

  places.forEach((place, index) => {
    const duration = durations[index];
    const startTime = formatTime(currentMinutes);
    if (currentMinutes !== null && duration !== null) currentMinutes += duration;
    items.push({
      type: "transit",
      from_name: index === 0 ? origin.name : places[index - 1].name,
      to_name: place.name,
      mode: "public_transport",
      start_time: duration === null ? null : startTime,
      end_time: duration === null ? null : formatTime(currentMinutes),
      duration_minutes: duration,
      is_estimate: true,
      summary: duration === null
        ? "公共交通・徒歩で移動"
        : `公共交通・徒歩で約${formatDuration(duration)}`,
    });
    items.push({
      type: "spot",
      role: "stop",
      place_id: place.id,
      name: place.name,
      category: place.category,
      time: formatTime(currentMinutes),
      stay_minutes: 90,
    });
    if (currentMinutes !== null) currentMinutes += 90;
  });

  const returnDuration = durations[durations.length - 1] ?? null;
  const returnStartTime = formatTime(currentMinutes);
  if (currentMinutes !== null && returnDuration !== null) currentMinutes += returnDuration;
  items.push({
    type: "transit",
    from_name: places.length > 0 ? places[places.length - 1].name : origin.name,
    to_name: origin.name,
    mode: "public_transport",
    start_time: returnDuration === null ? null : returnStartTime,
    end_time: returnDuration === null ? null : formatTime(currentMinutes),
    duration_minutes: returnDuration,
    is_estimate: true,
    summary: returnDuration === null
      ? "公共交通・徒歩で移動"
      : `公共交通・徒歩で約${formatDuration(returnDuration)}`,
  });
  items.push({
    type: "spot",
    role: "finish",
    place_id: null,
    name: origin.name,
    category: "帰着地",
    time: formatTime(currentMinutes),
    stay_minutes: 0,
  });
  return items;
}

export function withRouteLegs(
  items: RouteTimelineItem[],
  legs: RouteLeg[],
): TimelineItem[] {
  let assigned = false;
  return items.map((item) => {
    if (item.type === "transit" && !assigned && legs.length > 0) {
      assigned = true;
      return {
        ...item,
        summary: item.duration_minutes === null
          ? "公共交通・徒歩で移動"
          : `公共交通・徒歩で約${formatDuration(item.duration_minutes)}`,
        legs,
        detailsLabel: "全区間の駅すぱあと経路詳細",
      };
    }
    return item;
  });
}

export function buildDayTimeline(
  day: DailyItinerary,
  origin: Origin,
  hotel: Place,
  departureTime: string,
): TimelineItem[] {
  let currentLocation = day.day === 1 ? origin.name : hotel.name;
  let assignedLegs = false;
  const items: TimelineItem[] = day.day === 1
    ? [{
      type: "spot",
      role: "start",
      place_id: null,
      name: origin.name,
      category: "出発地",
      time: departureTime,
      stay_minutes: 0,
    }]
    : [];
  items.push(...day.schedule.flatMap((scheduleItem): TimelineItem[] => {
    if (scheduleItem.kind === "travel") {
      const destination = scheduleItem.title.replace(/へ移動$/, "");
      const duration = durationBetween(scheduleItem.start_time, scheduleItem.end_time);
      const transit: TimelineTransit = {
        type: "transit",
        from_name: currentLocation || "出発地",
        to_name: destination,
        mode: "public_transport",
        start_time: scheduleItem.start_time,
        end_time: scheduleItem.end_time,
        duration_minutes: duration,
        is_estimate: true,
        summary: duration === null
          ? "公共交通・徒歩で移動"
          : `公共交通・徒歩で約${formatDuration(duration)}`,
        detail: scheduleItem.detail,
      };
      if (!assignedLegs && day.legs.length > 0) {
        transit.legs = day.legs;
        transit.detailsLabel = "この日の駅すぱあと経路詳細";
        assignedLegs = true;
      }
      currentLocation = destination;
      return [transit];
    }

    const isHotelDeparture = scheduleItem.title === "ホテルを出発";
    const place = day.places.find((candidate) => candidate.name === scheduleItem.title)
      ?? (scheduleItem.kind === "hotel" && scheduleItem.title === hotel.name ? hotel : undefined);
    const stayMinutes = durationBetween(scheduleItem.start_time, scheduleItem.end_time) ?? 0;
    const spot: TimelineSpot = {
      type: "spot",
      role: isHotelDeparture ? "start" : "stop",
      place_id: place?.id ?? null,
      name: scheduleItem.title,
      category: scheduleItem.kind === "hotel" ? "宿泊・到着" : place?.category ?? "立ち寄り",
      time: scheduleItem.start_time,
      stay_minutes: scheduleItem.kind === "visit" ? stayMinutes : 0,
      detail: scheduleItem.detail,
      label: isHotelDeparture
        ? "ホテルを出発"
        : scheduleItem.kind === "hotel"
          ? "宿泊・到着"
          : undefined,
    };
    currentLocation = isHotelDeparture ? hotel.name : scheduleItem.title;
    return [spot];
  }));
  if (day.legs.length > 0 && !assignedLegs) {
    const firstTransit = items.find((item): item is TimelineTransit => item.type === "transit");
    if (firstTransit) {
      firstTransit.legs = day.legs;
      firstTransit.detailsLabel = "この日の駅すぱあと経路詳細";
    }
  }
  return items;
}

function roleLabel(role: "start" | "stop" | "finish", index: number) {
  if (role === "start") return "出発";
  if (role === "finish") return "帰着";
  return `立ち寄り ${String(index).padStart(2, "0")}`;
}

function LegList({ legs }: { legs: RouteLeg[] }) {
  return (
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
  );
}

export function RouteTimeline({ items }: RouteTimelineProps) {
  let stopIndex = 0;
  return (
    <section className="route-timeline" aria-label="時系列のルート行程">
      <ol className="timeline-list">
        {items.map((item, index) => {
          if (item.type === "transit") {
            return (
              <li className="timeline-row timeline-transit" key={`transit-${index}`}>
                <time className="timeline-time">
                  {item.start_time ?? ""}
                </time>
                <span className="timeline-marker transit-marker" aria-hidden="true">↗</span>
                <div className="timeline-transit-copy">
                  <strong>{item.summary ?? "公共交通・徒歩で移動"}</strong>
                  <span>{item.from_name} <b>→</b> {item.to_name}</span>
                  {item.detail && <small>{item.detail}</small>}
                  {item.legs && item.legs.length > 0 && (
                    <details className="timeline-route-details">
                      <summary>{item.detailsLabel ?? `経路詳細（${item.legs.length}区間）`}</summary>
                      <LegList legs={item.legs} />
                    </details>
                  )}
                </div>
              </li>
            );
          }

          if (item.role === "stop") stopIndex += 1;
          return (
            <li
              className={`timeline-row timeline-spot timeline-${item.role}`}
              key={`spot-${item.place_id ?? index}`}
            >
              <time className="timeline-time">{item.time ?? "—"}</time>
              <span className="timeline-marker" aria-hidden="true">
                {item.role === "start" ? "出" : item.role === "finish" ? "帰" : stopIndex}
              </span>
              <article className="timeline-spot-card">
                <small>{item.label ?? roleLabel(item.role, stopIndex)}</small>
                <strong>{item.name}</strong>
                {item.category && item.role === "stop" && (
                  <span className="timeline-category">{item.category}</span>
                )}
                {item.detail && <span className="timeline-category">{item.detail}</span>}
                {item.stay_minutes > 0 && (
                  <span className="timeline-stay">滞在目安 {formatDuration(item.stay_minutes)}</span>
                )}
              </article>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

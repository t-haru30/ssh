/** Search by the visible facility name; its address helps distinguish same-name places. */
export function googleMapsUrl(location: { latitude: number; longitude: number; name?: string; address?: string }): string {
  if (!Number.isFinite(location.latitude) || Math.abs(location.latitude) > 90
    || !Number.isFinite(location.longitude) || Math.abs(location.longitude) > 180) {
    throw new Error("地図の座標が不正です。");
  }
  const name = location.name?.trim();
  const query = name ? [name, location.address?.trim()].filter(Boolean).join(" ") : `${location.latitude},${location.longitude}`;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

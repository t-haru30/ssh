/** Coordinates keep same-name facilities from opening an unrelated search result. */
export function googleMapsUrl(location: { latitude: number; longitude: number; name?: string }): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${location.latitude},${location.longitude}`)}`;
}

export function loadJourneyMap() {
  return import("./GoogleJourneyMap").then(({ GoogleJourneyMap }) => ({ default: GoogleJourneyMap }));
}

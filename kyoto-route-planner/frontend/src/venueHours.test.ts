import {expect,it} from "vitest";
import {openingConflict} from "./venueHours";
import type {GoogleVenueInfo} from "./discover/useGoogleVenueInfo";
it("detects an early breakfast and a weekday closure while retaining unknown hours",()=>{
  const info={status:"ready",business_status:"operational",weekly_hours:[[[660,900]],[[660,900]],[[660,900]],[],[[660,900]],[[660,900]],[[660,900]]]} as GoogleVenueInfo;
  expect(openingConflict(info,"2026-10-13",553,75)).toContain("営業時間外");
  expect(openingConflict(info,"2026-10-13",750,75)).toBeNull();
  expect(openingConflict(info,"2026-10-14",750,75)).toContain("営業時間外");
  expect(openingConflict(undefined,"2026-10-13",750,75)).toBeNull();
});

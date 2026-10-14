import { useId } from "react";
import { AGE_OPTIONS, COMPANION_OPTIONS, GENDER_OPTIONS, PACE_OPTIONS, normalizeTravelPace, type TravelerProfile } from "./travelerProfile";
import "./travelerPreferences.css";

export function TravelerPreferences({ value, onChange, section = "all", answered = true }: { answered?: boolean; value: TravelerProfile; onChange: (value: TravelerProfile) => void; section?: "all" | "companion" | "pace" }) {
  const id = useId();
  return <>{section !== "pace" && <fieldset className="traveler-preferences" aria-describedby={section === "companion" ? undefined : `${id}-hint`}>
    <legend>誰と出かけますか？</legend>
    {section !== "companion" && <p id={`${id}-hint`}>未選択でも探せます。</p>}
    <div className="traveler-companions traveler-companion-options">{COMPANION_OPTIONS.map(option => <button key={option.value} className={option.value === "unspecified" ? "traveler-unspecified" : undefined} type="button" aria-pressed={answered && value.companion === option.value} onClick={() => onChange({ ...value, companion: option.value })}>{option.label}</button>)}</div>
    <details><summary>年代・性別（任意）</summary>
      <div className="traveler-optional"><label htmlFor={`${id}-age`}>年代<select id={`${id}-age`} value={value.age_group} onChange={event => onChange({ ...value, age_group: event.target.value as TravelerProfile["age_group"] })}>{AGE_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
      <label htmlFor={`${id}-gender`}>性別<select id={`${id}-gender`} value={value.gender} onChange={event => onChange({ ...value, gender: event.target.value as TravelerProfile["gender"] })}>{GENDER_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label></div>
    </details>
  </fieldset>}
    {section !== "companion" && <fieldset className="traveler-preferences traveler-pace"><legend>旅のペース</legend>
      <div className="traveler-companions">{PACE_OPTIONS.map(option => <button key={option.value} type="button" aria-pressed={answered && normalizeTravelPace(value.pace) === option.value} onClick={() => onChange({ ...value, pace: option.value })}>{option.label}</button>)}</div>
    </fieldset>}</>;
}

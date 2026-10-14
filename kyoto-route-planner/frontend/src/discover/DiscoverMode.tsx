import { JourneyReview, isJourneyReview, type JourneyReviewData } from "./JourneyReview";
import { currentLocation } from "../currentLocation";
import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence } from "framer-motion";
import type { RouteIdea } from "../SwipeCard";
import { usePrefecture } from "../PrefectureContext";
import type { PrefectureCode } from "../PrefectureContext";
import { useFavorites } from "../useFavorites";
import { routeSelection } from "../routeSelection";
import { DiscoverCard, formatMinutes } from "./DiscoverCard";
import type { DiscoverDirection } from "./DiscoverCard";
import { RouteDetailModal } from "./RouteDetailModal";
import type { DatasetRoute, RouteDatasetIndex } from "./datasetTypes";
import { localOrigins } from "../localPlaces";
import prefectureIndex from "../data/routes/index.json";
import "./discover.css";
import "./discoverPersonalized.css";
import { PreferenceTags } from "../PreferenceTags";
import { TravelerPreferences } from "../TravelerPreferences";
import { StationSearch } from "../StationSearch";
import { DestinationGatewaySearch } from "../DestinationGatewaySearch";
import type { Origin } from "../types";
import "./discoveryFlow.css";
import { readTravelerProfile, saveTravelerProfile, travelerProfileSummary, PACE_OPTIONS, normalizeTravelPace } from "../travelerProfile";
import { TravelRangeControl } from "../TravelRangeControl";
import { composeLocalRoutes, isDiscoverResponse } from "./dynamicRoutes";
import type { DiscoveryAgent } from "./dynamicRoutes";
import { diverseRoutes } from "./routeDiversity";
import { ProgressStatus } from "../ProgressStatus";


import { MEALS, mealError, mealTime, minuteOf, type MealChoice } from "../mealPlanning";

const indexEntries = [...(prefectureIndex as RouteDatasetIndex).prefectures].sort((a, b) => a.prefecture_code.localeCompare(b.prefecture_code));
const themes = [
  { id: "all", label: "おまかせ", icon: "✦" }, { id: "history", label: "歴史・街歩き", icon: "◷" },
  { id: "temple", label: "寺社めぐり", icon: "⛩" }, { id: "nature", label: "自然・景色", icon: "❋" }, { id: "food", label: "グルメ", icon: "🍴" },
] as const;
type ThemeFilter = (typeof themes)[number]["id"];
const PROFILE_THEME_KEY = "discovery-completed-profile-theme-v1";
function readCompletedTheme(): ThemeFilter | null {
  try {
    const saved = localStorage.getItem(PROFILE_THEME_KEY);
    return themes.find(item => item.id === saved)?.id ?? null;
  } catch { return null; }
}
type Conditions = { area: string; theme: ThemeFilter; themes: ThemeFilter[]; meals: MealChoice[]; pattern: "all" | "half_day" | "full_day"; radius: number; crossPrefecture: boolean; variation: number; origin: Origin; departure: Origin; preference_text: string; priority_text: string; traveler: ReturnType<typeof readTravelerProfile> };
const conditionsId = (c: Conditions) => JSON.stringify(c);
const preferenceId = (c: Conditions) => conditionsId({ ...c, variation: 0 });
type BrowseState = { index: number; history: number[] };
const EMPTY_BROWSE: BrowseState = { index: 0, history: [] };
const DISCOVER_STEPS = ["気分に合う場所を探しています", "巡る順番を整えています"];
type DiscoverModeProps = { active: boolean; homeRequest?: number; onPlanInSearch?: (route: DatasetRoute | RouteIdea, searchTransport?: boolean) => void };

export function DiscoverMode({ active, onPlanInSearch, homeRequest = 0 }: DiscoverModeProps) {
  const { prefecture, setPrefectureCode } = usePrefecture();
  const { saveFavorite, isFavorite } = useFavorites();
  const [area, setArea] = useState(() => indexEntries.find(entry => entry.prefecture_code === prefecture.code)?.id ?? "kyoto");
  const [traveler, setTraveler] = useState(readTravelerProfile);
  useEffect(() => { saveTravelerProfile(traveler); }, [traveler]);
  const [step, setStep] = useState(0);
  const [profileStage, setProfileStage] = useState(() => readCompletedTheme() === null ? 0 : 3);
  const [moodStage, setMoodStage] = useState(0);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [preferenceText, setPreferenceText] = useState("");
  const [wish, setWish] = useState("おまかせ");
  const [departure, setDeparture] = useState<Origin>(() => ({ name: "名古屋駅", latitude: 35.1709, longitude: 136.8815 }));
  const [destination, setDestination] = useState<Origin>(() => localOrigins[area] ?? { name: `${prefecture.name}・エリア中心`, latitude: indexEntries.find(item => item.id === area)!.center[0], longitude: indexEntries.find(item => item.id === area)!.center[1] });
  const [liked, setLiked] = useState<DatasetRoute[]>([]);
  const [locating, setLocating] = useState(false);
  const [locationMessage, setLocationMessage] = useState("");
  const locationRequest = useRef(0);
  useEffect(() => {
    setLocating(false);
    setLocationMessage("");
    return () => { locationRequest.current += 1; };
  }, [step, active, area, departure]);
  async function useCurrentLocation() {
    const request = ++locationRequest.current;
    setLocating(true); setLocationMessage("現在地を取得しています。位置情報の利用を許可してください。");
    try {
      const coordinates = await currentLocation();
      if (request !== locationRequest.current) return;
      setDeparture({ name: "現在地", ...coordinates });
    } catch (cause) {
      if (request === locationRequest.current) setLocationMessage(cause instanceof Error ? cause.message : "現在地を取得できませんでした。");
    } finally { if (request === locationRequest.current) setLocating(false); }
  }

  const stepHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { if (active) stepHeading.current?.focus(); }, [step, active]);
  const [chosenThemes, setChosenThemes] = useState<ThemeFilter[]>(() => {
    try { const saved: unknown = JSON.parse(localStorage.getItem("discovery-profile-themes-v2") ?? "null");
      if (Array.isArray(saved) && saved.length && saved.every(id => themes.some(t => t.id === id))) return saved;
    } catch { /* Use the previous selection. */ }
    return [readCompletedTheme() ?? "all"];
  });
  const theme: ThemeFilter = chosenThemes.length === 1 ? chosenThemes[0] : "all";
  function setTheme(value: ThemeFilter) {
    setChosenThemes(current => value === "all" ? ["all"] : current.includes(value)
      ? current.length === 1 ? ["all"] : current.filter(t => t !== value)
      : [...current.filter(t => t !== "all"), value]);
  }
  useEffect(() => {
    if (profileStage < 3) return;
    try { localStorage.setItem(PROFILE_THEME_KEY, theme); localStorage.setItem("discovery-profile-themes-v2", JSON.stringify(chosenThemes)); } catch { /* Keep answers in memory if storage is unavailable. */ }
  }, [profileStage, theme, chosenThemes]);
  const [pattern, setPattern] = useState<"all" | "half_day" | "full_day">("all");
  const [meals, setMeals] = useState<MealChoice[]>([]);
  const [mealMode, setMealMode] = useState<"unanswered" | "auto" | "custom">("unanswered");
  const automaticMeals: MealChoice[] = chosenThemes.includes("food") ? pattern === "full_day" ? [{kind: "lunch"}, {kind: "dinner"}] : [{kind: "lunch"}] : [];
  const tripMeals = mealMode === "custom" ? meals : automaticMeals;
  const mealMinutes = tripMeals.map(m => minuteOf(mealTime(m)));
  const mealWarning = mealError(tripMeals) || (pattern === "half_day" && tripMeals.length > 1 && Math.max(...mealMinutes) - Math.min(...mealMinutes) + 60 > 300 ? "半日に収まらない食事の組み合わせです。食事を減らすか、1日を選んでください。" : "");
  // Each collection keeps its position across filter changes and tab navigation.
  const [collections, setCollections] = useState<Record<string, BrowseState>>({});
  const [deckEpoch, setDeckEpoch] = useState(0);
  const [exitDirection, setExitDirection] = useState<DiscoverDirection>("pass");
  const [selected, setSelected] = useState<DatasetRoute | RouteIdea | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [radius, setRadius] = useState(30);
  const [crossPrefecture, setCrossPrefecture] = useState(true);
  const [variation, setVariation] = useState(0);
  const [generating, setGenerating] = useState(false);
  const [remote, setRemote] = useState<{ key: string; routes: DatasetRoute[]; note: string; agent?: DiscoveryAgent; review?: JourneyReviewData; originalRoutes?: DatasetRoute[] } | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  const seenRoutes = useRef<Record<string, DatasetRoute[]>>({});
  const [applied, setApplied] = useState<Conditions>(() => ({ area, theme, themes: chosenThemes, meals: tripMeals, pattern, radius, crossPrefecture, variation, traveler, origin: destination, departure, priority_text: preferenceText.trim(), preference_text: `${wish}。${preferenceText}${selectedTags.length ? `。${selectedTags.join("、")}` : ""}` }));
  const draft = { area, theme, themes: chosenThemes, meals: tripMeals, pattern, radius, crossPrefecture, variation, traveler, origin: destination, departure, priority_text: preferenceText.trim(), preference_text: `${wish}。${preferenceText}${selectedTags.length ? `。${selectedTags.join("、")}` : ""}` };
  const dirty = conditionsId(draft) !== conditionsId(applied);
  const advanceRef = useRef<AbortController | null>(null);
  const [preparingNext, setPreparingNext] = useState(false);
  const resultsRef = useRef<HTMLDivElement>(null);
  const resultsHeadingRef = useRef<HTMLHeadingElement>(null);
  const draftEntry = indexEntries.find(item => item.id === area)!;
  const entry = indexEntries.find(item => item.id === applied.area)!;
  const origin = applied.origin;
  const conditionsKey = conditionsId(applied);
  const localRoutes = useMemo(() => diverseRoutes(composeLocalRoutes({ entry, origin, theme: applied.theme, themes: applied.themes, meals: applied.meals, course: applied.pattern, radius: applied.radius, crossPrefecture: applied.crossPrefecture, variation: applied.variation, traveler: applied.traveler, priorityText: applied.priority_text, preferenceText: applied.preference_text })), [entry, origin, applied]);
  const routes = useMemo(() => (remote?.key === conditionsKey ? remote.routes : localRoutes).map(route => ({ ...route, travel_origin: applied.departure })), [remote, conditionsKey, localRoutes, applied.departure]);
  const collectionKey = `${conditionsKey}:${remote?.key === conditionsKey ? "api" : "local"}`;
  useEffect(() => {
    advanceRef.current?.abort(); advanceRef.current = null; setPreparingNext(false);
    return () => { advanceRef.current?.abort(); advanceRef.current = null; };
  }, [collectionKey, active, generating]);
  useEffect(() => () => requestRef.current?.abort(), []);
  useEffect(() => {
    if (!active) { requestRef.current?.abort(); requestRef.current = null; setGenerating(false); }
  }, [active]);
  function focusResults() {
    resultsRef.current?.scrollIntoView?.({ behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
    resultsHeadingRef.current?.focus({ preventScroll: true });
  }
  function returnToConditions(step: 0 | 1 | 2) { requestRef.current?.abort(); requestRef.current = null; setGenerating(false); cancelAdvance(); setSelected(null); setStep(step); }
  useEffect(() => { if (homeRequest) returnToConditions(0); }, [homeRequest]);
  function editConditions() { returnToConditions(0); }
  function editDestination() { returnToConditions(2); }
  function useLocalCandidates(message: string) {
    setRemote({ key: conditionsKey, routes: diverseRoutes(localRoutes, seenRoutes.current[preferenceId(applied)]), note: "施設データと指定条件から組み合わせています。移動時間は推定です。", agent: { status: "unavailable", message } });
    setCollections(current => ({ ...current, [`${conditionsKey}:api`]: EMPTY_BROWSE }));
  }
  function cancelGeneration() {
    requestRef.current?.abort(); requestRef.current = null; setGenerating(false);
    useLocalCandidates("AIの提案を中止しました。条件に合う通常の候補を表示しています。");
  }
  async function generate(next: Conditions = draft, excludeViewed = false) {
    if (!active) return;
    const nextEntry = indexEntries.find(item => item.id === next.area)!;
    const nextOrigin = next.origin;
    const nextKey = conditionsId(next);
    if (!excludeViewed) seenRoutes.current[preferenceId(next)] = [];
    const excluded = excludeViewed ? [...(seenRoutes.current[preferenceId(next)] ?? [])] : [];
    const viewedDiningIds = [...new Set(excluded.flatMap(route => route.spots.filter(spot => spot.role !== "stop").map(spot => spot.place_id)))].slice(-60);
    const fallback = diverseRoutes(composeLocalRoutes({ entry: nextEntry, origin: nextOrigin, theme: next.theme, themes: next.themes, meals: next.meals, course: next.pattern, radius: next.radius, crossPrefecture: next.crossPrefecture, variation: next.variation, traveler: next.traveler, priorityText: next.priority_text, preferenceText: next.preference_text }), excluded);
    setDeckEpoch(value => value + 1);
    cancelAdvance(); setApplied(next); setSelected(null);
    setRemote({ key: nextKey, routes: fallback, note: "条件に合う未閲覧の候補です。移動時間は推定です。" });
    setPrefectureCode(nextEntry.prefecture_code as PrefectureCode);
    setStep(3);
    window.requestAnimationFrame(focusResults);
    requestRef.current?.abort();
    const controller = new AbortController(); requestRef.current = controller;
    const timer = window.setTimeout(() => controller.abort(), 90_000);
    setGenerating(true); setNotice(null);
    try {
      const response = await fetch("/api/discover", { method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal,
        body: JSON.stringify({ area: next.area, prefecture_name: nextEntry.name, origin: nextOrigin, theme: next.theme, themes: next.themes, meals: next.meals, course: next.pattern, radius_km: next.radius, cross_prefecture: next.crossPrefecture, variation: next.variation, count: 12, traveler: next.traveler, preference_text: next.preference_text.slice(0, 600), priority_text: next.priority_text, viewed_dining_ids: viewedDiningIds }) });
      if (!response.ok) throw new Error("候補を取得できませんでした。");
      const data: unknown = await response.json();
      if (!isDiscoverResponse(data)) throw new Error("候補データの形式が正しくありません。");
      if (!controller.signal.aborted && requestRef.current === controller) {
        const received = diverseRoutes(data.routes, excluded);
        const combined = received.length < 4 ? diverseRoutes([...received, ...fallback], excluded).slice(0, 8) : received;
        const supplement = combined.length > received.length;
        setRemote({ key: nextKey, ...data, note: supplement ? "条件に合う登録済みの施設から候補を補いました。移動時間は推定です。" : data.note,
          review: isJourneyReview(data.review) ? data.review : undefined, originalRoutes: combined, routes: combined });
        setCollections(current => ({ ...current, [`${nextKey}:api`]: EMPTY_BROWSE }));
      }
    } catch {
      if (requestRef.current === controller) {
        setRemote({ key: nextKey, routes: fallback, note: "施設データと指定条件から組み合わせています。移動時間は推定です。", agent: { status: "unavailable", message: "AIの提案を取得できませんでした。通常の候補を表示しています。「別の組み合わせ」で再試行できます。" } });
        setCollections(current => ({ ...current, [`${nextKey}:api`]: EMPTY_BROWSE }));
      }
    } finally { window.clearTimeout(timer); if (requestRef.current === controller) { requestRef.current = null; setGenerating(false); } }
  }
  const nextBlockedReason = step === 0 && profileStage < 3
    ? ["誰と出かけるかを選んでください。「指定しない」でも進めます。", "旅のペースを選んでください。", "好きな過ごし方を1つ以上選んでください。"][profileStage]
    : step === 1 && moodStage < 2 ? moodStage === 0 ? "今回の旅で大切にしたいことを選んでください。" : "どれくらい楽しむかを選んでください。"
    : step > 0 && step < 3 && mealWarning ? mealWarning : step === 2 && locating ? "現在地を取得中です。取得が終わるまでお待ちください。" : "";
  const { index, history } = collections[collectionKey] ?? EMPTY_BROWSE;
  const stack = routes.slice(index, index + 3);
  const areaName = entry.name;

  function invalidateDestinationResults() {
    requestRef.current?.abort(); requestRef.current=null; cancelAdvance();setGenerating(false);setRemote(null);setSelected(null);setNotice(null);setCollections({});
  }
  function chooseArea(nextArea: string) { invalidateDestinationResults();setArea(nextArea); const place = indexEntries.find(item => item.id === nextArea)!; setDestination(localOrigins[nextArea] ?? { name: `${place.name}・エリア中心`, latitude: place.center[0], longitude: place.center[1] }); }
  function updateCollection(next: BrowseState) { setCollections(current => ({ ...current, [collectionKey]: next })); }
  function undo() {
    cancelAdvance();
    if (!history.length) return;
    setDeckEpoch(value => value + 1);
    updateCollection({ index: Math.max(0, index - 1), history: history.slice(0, -1) });
    setExitDirection("pass"); setSelected(null); setNotice(null);
  }
  function cancelAdvance() { advanceRef.current?.abort(); advanceRef.current = null; setPreparingNext(false); }
  function swipe(direction: DiscoverDirection) {
    if (generating || !active) return false;
    return commitSwipe(direction);
  }
  function toIdea(current: DatasetRoute): RouteIdea {
      const entry = indexEntries.find(candidate => candidate.id === current.area);
      const selection = routeSelection(current);
      const idea: RouteIdea = {
        theme: current.theme, prefecture_code: entry?.prefecture_code ?? prefecture.code, prefecture_name: entry?.name ?? prefecture.name,
        title: current.title, story: current.recommendation_reason || `${current.spots.length}か所を巡る、約${formatMinutes(current.estimated_minutes)}の旅のプラン。`,
        places: selection.places, origin: selection.origin, travel_origin: current.travel_origin, dwell_minutes: selection.dwellMinutes,
        image_url: null, author_name: null, source_url: null, license_name: null, license_url: null,
        copywriting_source: current.recommendation_source === "gemini" ? "gemini" : "fallback", note: current.recommendation_source === "gemini" ? "AIが条件に合わせて選んだ旅の候補" : "地図データに基づく旅の候補",
      };
      return idea;
  }
  function rememberRoute(route: DatasetRoute | undefined) {
    if (!route) return;
    const key = preferenceId(applied);
    const previous = seenRoutes.current[key] ?? [];
    if (!previous.some(item => item.id === route.id)) seenRoutes.current[key] = [...previous, route];
  }
  function commitSwipe(direction: DiscoverDirection) {
    if (!routes[index]) return false;
    if (direction === "like") {
      const route = routes[index];
      const idea = toIdea(route);
      if (!isFavorite(idea) && !saveFavorite(idea)) { setNotice("保存できませんでした。保存容量やお気に入りの件数を確認してください。"); return false; }
      setLiked(current => current.some(item => item.id === route.id) ? current : [...current, route]);
    }
    rememberRoute(routes[index]);
    setNotice(direction === "like" ? "いいねしました。選んだ旅程から編集できます。" : null); setExitDirection(direction);
    updateCollection({ index: index + 1, history: [...history, index] });
    return true;
  }

  return <div className="tab-panel discover-mode discover-personalized" id="panel-discover" role="tabpanel" aria-labelledby="tab-discover" hidden={!active}>
    <nav className="discovery-progress" aria-label="旅選びのステップ">{["あなたの好み", "旅の気分", "行き先", "スワイプ"].map((label, i) => (i === 0 || i === 1 && profileStage >= 3 || i === 2 && profileStage >= 3) ? <button type="button" key={label} aria-label={`0${i + 1} ${label}へ`} aria-current={step === i ? "step" : undefined} data-complete={step > i} onClick={() => returnToConditions(i as 0 | 1 | 2)}><b>{`0${i + 1}`}</b>{label}</button> : <span key={label} aria-current={step === i ? "step" : undefined} data-complete={step > i}><b>{step > i ? "✓" : `0${i + 1}`}</b>{label}</span>)}</nav>
    {step < 3 && <section className="discovery-question" key={step} aria-labelledby="discovery-question-title">
      <h1 id="discovery-question-title" ref={stepHeading} tabIndex={-1}>{["まずは、あなたのこと。", "どんな一日にしたい？", "どこから、どこへ？"][step]}</h1>
      {step === 0 && <>
        <div className="discovery-profile-progress" role="progressbar" aria-label="好みの設定" aria-valuemin={0} aria-valuemax={3} aria-valuenow={profileStage} aria-valuetext={`${profileStage} / 3項目完了`}><span>好みの設定 <b>{profileStage} / 3</b></span><div><i style={{ width: `${profileStage / 3 * 100}%` }} /></div></div>
        <div className="profile-reveal profile-first-question"><TravelerPreferences section="companion" answered={profileStage >= 1} value={traveler} onChange={value => { setTraveler(value); setProfileStage(stage => Math.max(stage, 1)); }} /></div>
        {profileStage >= 1 && <div className="profile-reveal"><TravelerPreferences section="pace" answered={profileStage >= 2} value={traveler} onChange={value => { setTraveler(value); setProfileStage(stage => Math.max(stage, 2)); }} /></div>}
        {profileStage >= 2 && <div className="profile-reveal"><fieldset className="discover-filter-group"><legend>好きな過ごし方は？（複数選択できます）</legend><div className="discover-theme-options">{themes.map(item => <button type="button" key={item.id} aria-pressed={profileStage >= 3 && chosenThemes.includes(item.id)} onClick={() => { setTheme(item.id); setProfileStage(3); }}>{item.label}</button>)}</div></fieldset></div>}
      </>}
      {step === 1 && <>
        <div className="discovery-tags" aria-label="あなたの旅のタグ">{selectedTags.map(tag => <span key={tag}>✦ {tag}</span>)}<span>{travelerProfileSummary(traveler)}</span><span>{chosenThemes.map(id => themes.find(item => item.id === id)?.label).join("・")}</span><span>{PACE_OPTIONS.find(item => item.value === normalizeTravelPace(traveler.pace))?.label}</span></div>
        <div className="profile-reveal"><PreferenceTags theme={theme} traveler={traveler} selected={selectedTags} onChange={setSelectedTags} /></div>
        <div className="profile-reveal profile-first-question"><fieldset className="discover-filter-group"><legend>{traveler.companion === "family" ? "家族でどんな時間を過ごしたい？" : theme === "food" ? "食の寄り道、どう楽しむ？" : "今回の旅で大切にしたいのは？"}</legend><div className="discover-theme-options">{["おまかせ", "ゆっくり過ごしたい", "有名な場所を巡りたい", "自然を楽しみたい", "おいしいものを食べたい"].map(label => <button type="button" key={label} aria-pressed={moodStage >= 1 && wish === label} onClick={() => { setWish(label); setMoodStage(stage => Math.max(stage, 1)); if (label === "ゆっくり過ごしたい") setTraveler({ ...traveler, pace: "relaxed" }); if (label === "自然を楽しみたい" && !chosenThemes.includes("nature")) setTheme("nature"); if (label === "おいしいものを食べたい" && !chosenThemes.includes("food")) setTheme("food"); }}>{label}</button>)}</div></fieldset></div>
        {moodStage >= 1 && <div className="profile-reveal"><fieldset className="discover-filter-group"><legend>どれくらい楽しむ？</legend><div className="discover-duration-options">{([{ id: "all", label: "おまかせ" }, { id: "half_day", label: "半日" }, { id: "full_day", label: "1日" }] as const).map(item => <button key={item.id} type="button" aria-pressed={moodStage >= 2 && pattern === item.id} onClick={() => { setPattern(item.id); if (item.id === "half_day") setMeals(current => current.filter(m => m.kind !== "breakfast")); setMoodStage(2); }}>{item.label}</button>)}</div></fieldset></div>}
        {moodStage >= 2 && <div className="profile-reveal"><fieldset className="discover-filter-group">
          <legend>{pattern === "full_day" ? "1日の旅に、どの食事を入れますか？" : pattern === "half_day" ? "食事の予定は入れますか？" : "旅の途中に、どの食事を入れますか？"}</legend>
          {chosenThemes.includes("food") && <p className="preference-tags-note">{`未選択なら${pattern === "full_day" ? "昼・夜ごはん" : "昼ごはん"}を入れます。食事を入れない場合は「食事なし」を選んでください。`}</p>}
          <div className="discover-theme-options"><button type="button" aria-pressed={mealMode === "auto"} onClick={() => {setMealMode("auto"); setMeals([]);}}>食事はおまかせ</button>{MEALS.filter(m => pattern !== "half_day" || m.kind !== "breakfast").map(m => <button type="button" key={m.kind} aria-pressed={mealMode === "custom" && meals.some(c => c.kind === m.kind)} onClick={() => {setMealMode("custom"); setMeals(current => current.some(c => c.kind === m.kind) ? current.filter(c => c.kind !== m.kind) : [...current, {kind: m.kind}]);}}>{m.label}</button>)}<button type="button" aria-pressed={mealMode === "custom" && !meals.length} onClick={() => {setMealMode("custom"); setMeals([]);}}>食事なし</button></div>
          {MEALS.filter(m => meals.some(c => c.kind === m.kind)).map(m => <label className="meal-time-field" key={m.kind}>{m.label}の時間（任意）<input type="time" aria-label={`${m.label}の時間（任意）`} value={meals.find(c => c.kind === m.kind)?.time ?? ""} onChange={e => setMeals(current => current.map(c => c.kind === m.kind ? {...c,time:e.target.value || null} : c))} /><small>未指定なら<strong>{m.time}ごろ</strong>を目安にします</small></label>)}
          {mealWarning && <p role="alert">{mealWarning}</p>}
        </fieldset></div>}
        <div className="profile-reveal"><label className="discovery-free-text">旅に加えたいことはありますか？（任意）<textarea value={preferenceText} onChange={event => setPreferenceText(event.target.value)} maxLength={500} rows={3} placeholder="例：金沢で庭園を歩いて、カフェに寄りたい" /></label>
          <small>入力した希望を、旅程づくりで優先します。</small>
        </div>
      </>}
      {step === 2 && <>
        <StationSearch label="出発地点" value={departure} options={[localOrigins[area] ?? { name: `${draftEntry.name}・エリア中心`, latitude: draftEntry.center[0], longitude: draftEntry.center[1] }]} onChange={setDeparture} />
        <div className="departure-location">
          <button type="button" disabled={locating} onClick={useCurrentLocation}>{locating ? "現在地を取得中…" : "現在地を使う"}</button>
          {(locationMessage || departure.name === "現在地") && <p role="status" aria-live="polite">{locationMessage || "現在地を出発地点に設定しました。"}</p>}
        </div>
        <label className="prefecture-picker">行き先の都道府県<select value={area} onChange={event => chooseArea(event.target.value)}>{indexEntries.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <DestinationGatewaySearch key={area} area={area} prefecture={{ name: draftEntry.name, code: draftEntry.prefecture_code }} value={destination} fallback={localOrigins[area] ?? { name: `${draftEntry.name}・エリア中心`, latitude: draftEntry.center[0], longitude: draftEntry.center[1] }} onChange={station => { invalidateDestinationResults();setDestination(station);setCrossPrefecture(false); }} />
        <details className="discover-more-conditions"><summary>到着後の観光範囲 · {radius === 20000 ? "制限なし" : `半径${radius}km`}</summary><label className="range-checkbox"><input type="checkbox" checked={radius === 20000} onChange={event => setRadius(event.target.checked ? 20000 : 30)} />距離を制限しない</label>{radius !== 20000 && <TravelRangeControl value={radius} onChange={setRadius} maximum={20000} label="観光の起点からの半径（km）" />}<label className="range-checkbox"><input type="checkbox" checked={crossPrefecture} onChange={event => setCrossPrefecture(event.target.checked)} />県をまたぐ候補も含める</label></details>
      </>}
      <footer className="discovery-question-footer">
        <p id="discovery-next-hint" className="discovery-next-hint" role="status" aria-live="polite">{nextBlockedReason || (step === 0 ? profileStage >= 3 ? "好みの設定が完了しました。" : `あと${3 - profileStage}項目を選んでください。` : step === 1 ? moodStage < 2 ? "旅の気分と長さを選ぶと次へ進めます。" : "行き先は次の画面で選べます。" : "この条件で旅程を探します。")}</p>
        <div className="discovery-next">{step > 0 && <button type="button" onClick={() => setStep(step - 1)}>← 戻る</button>}<button type="button" className="idea-primary-button" aria-describedby="discovery-next-hint" disabled={Boolean(nextBlockedReason)} onClick={() => step === 2 ? void generate() : setStep(step + 1)}>{step === 2 ? "おすすめ旅程を見る" : step === 0 ? "次へ：旅の気分を選ぶ" : "次へ：行き先を選ぶ"} →</button></div>
      </footer>
    </section>}
    {step === 3 && <section className="discover-workspace discovery-deck" aria-label="旅の候補を探す">
      <div className="discover-results" ref={resultsRef}><header className="discover-results-heading"><div><h2 ref={resultsHeadingRef} tabIndex={-1}>{areaName}{applied.crossPrefecture ? "周辺" : "内"}の旅のプラン</h2></div>{!generating && <span className="discover-result-count">{routes.length}件の候補</span>}</header>
        <div className="discover-conditions-summary"><button type="button" onClick={editDestination}>行き先を選び直す</button><button type="button" onClick={editConditions}>条件を変更 <span aria-hidden="true">↑</span></button></div>
        {!generating && routes.length === 1 && <p className="discover-candidate-note">今の条件に合う旅程は1件です。別案を増やすには、食事・時間や観光範囲を見直せます。</p>}
        {!generating && routes.length > 1 && new Set(routes.flatMap(route => route.spots.filter(spot => spot.role !== "stop").map(spot => spot.place_id))).size === 1
          && <p className="discover-candidate-note">食事先の候補は1店です。別のお店も探すには、行き先・観光範囲を変更できます。</p>}

        {generating && <ProgressStatus title="旅の候補を探しています" steps={DISCOVER_STEPS} onCancel={cancelGeneration} cancelLabel="AIを待たずに候補を見る" />}
        {!generating && remote?.key === conditionsKey && remote.agent?.status === "unavailable" && <div className="discover-candidate-note" role="status"><p>{!routes.length ? "AIの提案を取得できませんでした。食事や時間の条件を見直して再検索できます。" : remote.agent.message.startsWith("AIの提案を中止") ? "AIを待たずに、条件に合う候補を表示しています。" : "AIの提案を取得できませんでした。条件に合う候補で続けられます。"}</p><button type="button" onClick={() => void generate(applied)}>AIの提案を再試行</button></div>}
        {!generating && remote?.key === conditionsKey && remote.review && <JourneyReview key={remote.review.id} report={remote.review}
          onAdopt={route => { cancelAdvance(); setSelected(null); setDeckEpoch(v => v + 1); setRemote(current => current ? {...current, routes: [route]} : current); updateCollection(EMPTY_BROWSE); }}
          onRestore={() => { cancelAdvance(); setSelected(null); setDeckEpoch(v => v + 1); setRemote(current => current ? {...current, routes: diverseRoutes(current.originalRoutes ?? [], [])} : current); updateCollection(EMPTY_BROWSE); }} />}
        {!generating && <><div className="discover-stack" aria-busy={preparingNext}><AnimatePresence custom={exitDirection === "like" ? "accept" : "skip"}>{stack.map((route, depth) => ({ route, depth })).reverse().map(({ route, depth }) => <DiscoverCard key={`${deckEpoch}:${route.id}`} route={route} depth={depth} active={active && !generating && !selected} preparingNext={preparingNext && depth === 0} exitDirection={exitDirection} onSwipe={swipe} />)}</AnimatePresence>
          {routes.length === 0 && <div className="discover-empty"><strong>この条件で新しく提案できる旅程はありません</strong><p>{applied.themes.includes("food") && !applied.meals.length ? "食事なしでは飲食店を候補から外します。食事を選ぶか、ほかの好みを組み合わせてください。" : "食事の時刻や観光範囲を見直すと、候補を増やせます。"}</p><button type="button" className="idea-primary-button" onClick={() => returnToConditions(1)}>食事・時間を見直す</button><button type="button" onClick={editDestination}>観光範囲を広げる</button></div>}
          {routes.length > 0 && !stack.length && <div className="discover-empty"><span className="discover-empty-icon" aria-hidden="true">✦</span><strong>すべてのルートを見ました</strong><p>いいねした旅程を下から選んで、編集しましょう。</p><button type="button" className="idea-primary-button" onClick={() => { setDeckEpoch(value => value + 1); updateCollection(EMPTY_BROWSE); setNotice(null); }}>最初から見直す ↻</button></div>}
        </div>
        <div className="discover-actions">
          <button type="button" className="discover-action detail" onClick={() => setSelected(stack[0])} disabled={!stack.length || generating || preparingNext}>詳細を見る</button>
          <button type="button" className="discover-action pass" onClick={() => swipe("pass")} disabled={!stack.length || preparingNext || generating}>← 今回は見送る</button>
          <button type="button" className="discover-action save" onClick={() => swipe("like")} disabled={!stack.length || preparingNext || generating}>いいね ♥</button>
        </div>

        {preparingNext && <div className="discover-photo-pending" role="status"><span>次のカードの写真を準備しています…</span><button type="button" onClick={cancelAdvance}>待機をやめる</button></div>}
        <div className="discover-deck-meta"><button type="button" onClick={undo} disabled={!history.length || preparingNext || generating}>← 前の候補</button><span className="discover-progress">{Math.min(index + 1, routes.length)} / {routes.length}</span><button type="button" disabled={generating || dirty} onClick={() => { rememberRoute(stack[0]); const nextVariation = variation + 1; setVariation(nextVariation); void generate({ ...applied, variation: nextVariation }, true); }}>別の組み合わせ</button></div>
        {notice && <div className="discover-toast" role="status">{notice}</div>}

        <details className="discover-data-note"><summary>移動時間・提案の範囲について</summary><p>{remote?.key === conditionsKey ? remote.note : `施設候補から条件に合わせて作成しました。半径${applied.radius}km以内で検索範囲を自動調整します。候補が少ない場合はスポット数を減らします。移動時間は推定です。`}</p></details>
        {onPlanInSearch && <button type="button" className="idea-primary-button discover-plan-button" disabled={generating || !stack.length} onClick={() => { const route = selected ?? stack[0]; if (route) { setSelected(null); onPlanInSearch(route); } }}>この旅程を選んで編集する <span aria-hidden="true">→</span></button>}
        {liked.length > 0 && <section className="discovery-liked" aria-label="いいねした旅程"><h2>いいねした旅程 <small>{liked.length}件</small></h2>{liked.map(route => <article key={route.id}><div><strong>{route.title}</strong><p>{route.spots.map(spot => spot.name).join(" → ")}</p></div><button type="button" onClick={() => onPlanInSearch?.(route)}>編集する →</button></article>)}</section>}
        </>}
      </div>
    </section>}
    {active && selected && <RouteDetailModal route={selected} onClose={() => setSelected(null)} onPlanInSearch={onPlanInSearch && (route => { setSelected(null); onPlanInSearch(route); })} />}
  </div>;
}

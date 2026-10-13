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
import type { Origin } from "../types";
import { isOrigin, isRecord } from "../apiValidation";
import "./discoveryFlow.css";
import { readTravelerProfile, saveTravelerProfile, travelerProfileSummary, PACE_OPTIONS, normalizeTravelPace } from "../travelerProfile";
import { TravelRangeControl } from "../TravelRangeControl";
import { composeLocalRoutes, isDiscoverResponse } from "./dynamicRoutes";
import type { DiscoveryAgent } from "./dynamicRoutes";
import { diverseRoutes } from "./routeDiversity";
import { ProgressStatus } from "../ProgressStatus";


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
type Conditions = { area: string; theme: ThemeFilter; pattern: "all" | "half_day" | "full_day"; radius: number; crossPrefecture: boolean; variation: number; origin: Origin; departure: Origin; preference_text: string; traveler: ReturnType<typeof readTravelerProfile> };
const conditionsId = (c: Conditions) => JSON.stringify(c);
const preferenceId = (c: Conditions) => conditionsId({ ...c, variation: 0 });
type BrowseState = { index: number; history: number[] };
const EMPTY_BROWSE: BrowseState = { index: 0, history: [] };
const DISCOVER_STEPS = ["条件に合う施設を調べています", "行き先と巡る順番を選んでいます", "旅程を点検し、必要な変更案をまとめています"];
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
  const moodQuestion = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (step !== 1 || moodStage === 0 || !active) return;
    moodQuestion.current?.scrollIntoView?.({ behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "nearest" });
    moodQuestion.current?.focus({ preventScroll: true });
  }, [moodStage, step, active]);
  const profileQuestion = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (step !== 0 || profileStage === 0 || !active) return;
    profileQuestion.current?.scrollIntoView?.({ behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "nearest" });
    profileQuestion.current?.focus({ preventScroll: true });
  }, [profileStage, step, active]);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [preferenceText, setPreferenceText] = useState("");
  const [destinationBusy, setDestinationBusy] = useState(false);
  const [destinationNote, setDestinationNote] = useState("");
  const destinationRequest = useRef<AbortController | null>(null);
  useEffect(() => { destinationRequest.current?.abort(); destinationRequest.current = null; setDestinationBusy(false); return () => { destinationRequest.current?.abort(); destinationRequest.current = null; }; }, [step, active, preferenceText]);
  async function proposeDestination() {
    if (!preferenceText.trim() || destinationBusy) return;
    const controller = new AbortController(); destinationRequest.current = controller;
    const timer = window.setTimeout(() => controller.abort(), 45000);
    setDestinationBusy(true); setDestinationNote("");
    try {
      const response = await fetch("/api/destination-suggestion", { method:"POST", headers:{"Content-Type":"application/json"}, signal:controller.signal, body:JSON.stringify({ text:preferenceText.trim() }) });
      const data: unknown = await response.json();
      if (!response.ok) throw new Error(isRecord(data) && typeof data.detail === "string" ? data.detail : "行き先を提案できませんでした。");
      if (!isRecord(data) || !isOrigin(data.origin)) throw new Error("行き先の位置を確認できませんでした。");
      const nextArea = indexEntries.find(item => item.name === data.prefecture);
      if (!nextArea) throw new Error("都道府県を確認できませんでした。");
      if (controller.signal.aborted) return;
      setArea(nextArea.id); setDestination(data.origin); setMoodStage(2);
      setDestinationNote(`${nextArea.name}${typeof data.municipality === "string" ? `・${data.municipality}` : ""}の${data.origin.name}を提案しました。行き先は変更できます。`);
      setStep(2);
    } catch (error) {
      if (destinationRequest.current === controller && !controller.signal.aborted) setDestinationNote(error instanceof Error ? error.message : "行き先を取得できませんでした。");
      else if (destinationRequest.current === controller) setDestinationNote("取得を中止しました。もう一度試すか、駅を選んでください。");
    } finally { window.clearTimeout(timer); if (destinationRequest.current === controller) setDestinationBusy(false); }
  }
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
  const [theme, setTheme] = useState<ThemeFilter>(() => readCompletedTheme() ?? "all");
  useEffect(() => {
    if (profileStage < 3) return;
    try { localStorage.setItem(PROFILE_THEME_KEY, theme); } catch { /* Keep answers in memory if storage is unavailable. */ }
  }, [profileStage, theme]);
  const [pattern, setPattern] = useState<"all" | "half_day" | "full_day">("all");
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
  const [applied, setApplied] = useState<Conditions>(() => ({ area, theme, pattern, radius, crossPrefecture, variation, traveler, origin: destination, departure, preference_text: `${wish}。${preferenceText}${selectedTags.length ? `。${selectedTags.join("、")}` : ""}` }));
  const draft = { area, theme, pattern, radius, crossPrefecture, variation, traveler, origin: destination, departure, preference_text: `${wish}。${preferenceText}${selectedTags.length ? `。${selectedTags.join("、")}` : ""}` };
  const dirty = conditionsId(draft) !== conditionsId(applied);
  const advanceRef = useRef<AbortController | null>(null);
  const [preparingNext, setPreparingNext] = useState(false);
  const resultsRef = useRef<HTMLDivElement>(null);
  const resultsHeadingRef = useRef<HTMLHeadingElement>(null);
  const draftEntry = indexEntries.find(item => item.id === area)!;
  const entry = indexEntries.find(item => item.id === applied.area)!;
  const origin = applied.origin;
  const conditionsKey = conditionsId(applied);
  const localRoutes = useMemo(() => diverseRoutes(composeLocalRoutes({ entry, origin, theme: applied.theme, course: applied.pattern, radius: applied.radius, crossPrefecture: applied.crossPrefecture, variation: applied.variation, traveler: applied.traveler, preferenceText: applied.preference_text })), [entry, origin, applied]);
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
    const fallback = diverseRoutes(composeLocalRoutes({ entry: nextEntry, origin: nextOrigin, theme: next.theme, course: next.pattern, radius: next.radius, crossPrefecture: next.crossPrefecture, variation: next.variation, traveler: next.traveler, preferenceText: next.preference_text }), excluded);
    setDeckEpoch(value => value + 1);
    cancelAdvance(); setApplied(next); setSelected(null);
    setRemote({ key: nextKey, routes: fallback, note: "条件に合う未閲覧の候補です。移動時間は推定です。" });
    setPrefectureCode(nextEntry.prefecture_code as PrefectureCode);
    setStep(3);
    window.requestAnimationFrame(focusResults);
    requestRef.current?.abort();
    const controller = new AbortController(); requestRef.current = controller;
    const timer = window.setTimeout(() => controller.abort(), 70_000);
    setGenerating(true); setNotice(null);
    try {
      const response = await fetch("/api/discover", { method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal,
        body: JSON.stringify({ area: next.area, prefecture_name: nextEntry.name, origin: nextOrigin, theme: next.theme, course: next.pattern, radius_km: next.radius, cross_prefecture: next.crossPrefecture, variation: next.variation, count: 12, traveler: next.traveler, preference_text: next.preference_text }) });
      if (!response.ok) throw new Error("候補を取得できませんでした。");
      const data: unknown = await response.json();
      if (!isDiscoverResponse(data)) throw new Error("候補データの形式が正しくありません。");
      if (!controller.signal.aborted && requestRef.current === controller) {
        setRemote({ key: nextKey, ...data, review: isJourneyReview(data.review) ? data.review : undefined, originalRoutes: data.routes, routes: diverseRoutes(data.routes, excluded) });
        setCollections(current => ({ ...current, [`${nextKey}:api`]: EMPTY_BROWSE }));
      }
    } catch {
      if (requestRef.current === controller) {
        setRemote({ key: nextKey, routes: fallback, note: "施設データと指定条件から組み合わせています。移動時間は推定です。", agent: { status: "unavailable", message: "AIの提案を取得できませんでした。通常の候補を表示しています。「別の組み合わせ」で再試行できます。" } });
        setCollections(current => ({ ...current, [`${nextKey}:api`]: EMPTY_BROWSE }));
      }
    } finally { window.clearTimeout(timer); if (requestRef.current === controller) { requestRef.current = null; setGenerating(false); } }
  }
  const { index, history } = collections[collectionKey] ?? EMPTY_BROWSE;
  const stack = routes.slice(index, index + 3);
  const areaName = entry.name;

  function chooseArea(nextArea: string) { setArea(nextArea); const place = indexEntries.find(item => item.id === nextArea)!; setDestination(localOrigins[nextArea] ?? { name: `${place.name}・エリア中心`, latitude: place.center[0], longitude: place.center[1] }); }
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
        <div className="profile-reveal profile-first-question"><TravelerPreferences section="companion" answered={profileStage >= 1} value={traveler} onChange={value => { setTraveler(value); setProfileStage(stage => Math.max(stage, 1)); }} /></div>
        {profileStage >= 1 && <div className="profile-reveal" ref={profileStage === 1 ? profileQuestion : undefined} tabIndex={-1}><TravelerPreferences section="pace" answered={profileStage >= 2} value={traveler} onChange={value => { setTraveler(value); setProfileStage(stage => Math.max(stage, 2)); }} /></div>}
        {profileStage >= 2 && <div className="profile-reveal" ref={profileStage === 2 ? profileQuestion : undefined} tabIndex={-1}><fieldset className="discover-filter-group"><legend>好きな過ごし方は？</legend><div className="discover-theme-options">{themes.map(item => <button type="button" key={item.id} aria-pressed={profileStage >= 3 && theme === item.id} onClick={() => { setTheme(item.id); setProfileStage(3); }}><span aria-hidden="true">{item.icon}</span>{item.label}</button>)}</div></fieldset></div>}
      </>}
      {step === 1 && <>
        <div className="discovery-tags" aria-label="あなたの旅のタグ">{selectedTags.map(tag => <span key={tag}>✦ {tag}</span>)}<span>{travelerProfileSummary(traveler)}</span><span>{themes.find(item => item.id === theme)?.label}</span><span>{PACE_OPTIONS.find(item => item.value === normalizeTravelPace(traveler.pace))?.label}</span></div>
        <div className="profile-reveal"><PreferenceTags theme={theme} traveler={traveler} selected={selectedTags} onChange={setSelectedTags} /></div>
        <div className="profile-reveal profile-first-question"><fieldset className="discover-filter-group"><legend>{traveler.companion === "family" ? "家族でどんな時間を過ごしたい？" : theme === "food" ? "食の寄り道、どう楽しむ？" : "今回の旅で大切にしたいのは？"}</legend><div className="discover-theme-options">{["おまかせ", "ゆっくり過ごしたい", "有名な場所を巡りたい", "自然を楽しみたい", "おいしいものを食べたい"].map(label => <button type="button" key={label} aria-pressed={moodStage >= 1 && wish === label} onClick={() => { setWish(label); setMoodStage(stage => Math.max(stage, 1)); if (label === "ゆっくり過ごしたい") setTraveler({ ...traveler, pace: "relaxed" }); if (label === "自然を楽しみたい") setTheme("nature"); if (label === "おいしいものを食べたい") setTheme("food"); }}>{label}</button>)}</div></fieldset></div>
        {moodStage >= 1 && <div className="profile-reveal" ref={moodStage === 1 ? moodQuestion : undefined} tabIndex={-1}><fieldset className="discover-filter-group"><legend>どれくらい楽しむ？</legend><div className="discover-duration-options">{([{ id: "all", label: "おまかせ" }, { id: "half_day", label: "半日" }, { id: "full_day", label: "1日" }] as const).map(item => <button key={item.id} type="button" aria-pressed={moodStage >= 2 && pattern === item.id} onClick={() => { setPattern(item.id); setMoodStage(2); }}>{item.label}</button>)}</div></fieldset></div>}
        {<div className="profile-reveal" ref={moodStage >= 2 ? moodQuestion : undefined} tabIndex={-1}><label className="discovery-free-text">ほかに、やってみたいことは？（任意）<textarea value={preferenceText} onChange={event => setPreferenceText(event.target.value)} maxLength={500} rows={3} placeholder="例：庭園でのんびりして、カフェに寄りたい" /></label><button type="button" className="idea-primary-button" disabled={destinationBusy || !preferenceText.trim()} onClick={() => void proposeDestination()}>{destinationBusy ? "行き先を提案中…" : "入力から行き先を提案"}</button><p role="status">{destinationNote}</p></div>}
      </>}
      {step === 2 && <><p role="status">{destinationNote}</p>
        <label className="prefecture-picker">行き先の都道府県<select value={area} onChange={event => chooseArea(event.target.value)}>{indexEntries.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <StationSearch label="出発地点" value={departure} options={[localOrigins[area] ?? { name: `${draftEntry.name}・エリア中心`, latitude: draftEntry.center[0], longitude: draftEntry.center[1] }]} onChange={setDeparture} />
        <div className="departure-location">
          <button type="button" disabled={locating} onClick={useCurrentLocation}>{locating ? "現在地を取得中…" : "現在地を使う"}</button>
          {(locationMessage || departure.name === "現在地") && <p role="status" aria-live="polite">{locationMessage || "現在地を出発地点に設定しました。"}</p>}
        </div>
        <StationSearch key={area} prefecture={{ name: draftEntry.name, code: draftEntry.prefecture_code }} label="行き先の駅・観光の起点" value={destination} options={[localOrigins[area] ?? { name: `${draftEntry.name}・エリア中心`, latitude: draftEntry.center[0], longitude: draftEntry.center[1] }]} onChange={(station, prefecture) => { setDestination(station); const stationArea = indexEntries.find(item => item.name === prefecture) ?? indexEntries.find(item => localOrigins[item.id]?.latitude === station.latitude && localOrigins[item.id]?.longitude === station.longitude); if (stationArea) { setArea(stationArea.id); setCrossPrefecture(false); } }} />
        <details className="discover-more-conditions"><summary>到着後の観光範囲 · {radius === 20000 ? "制限なし" : `半径${radius}km`}</summary><label className="range-checkbox"><input type="checkbox" checked={radius === 20000} onChange={event => setRadius(event.target.checked ? 20000 : 30)} />距離を制限しない</label>{radius !== 20000 && <TravelRangeControl value={radius} onChange={setRadius} maximum={20000} label="観光の起点からの半径（km）" />}<label className="range-checkbox"><input type="checkbox" checked={crossPrefecture} onChange={event => setCrossPrefecture(event.target.checked)} />県をまたぐ候補も含める</label></details>
      </>}
      {(step !== 0 || profileStage >= 3) && <div className="discovery-next">{step > 0 && <button type="button" onClick={() => setStep(step - 1)}>← 戻る</button>}{(step !== 1 || moodStage >= 2) && <button type="button" className="idea-primary-button" disabled={step === 2 && locating} onClick={() => step === 2 ? void generate() : setStep(step + 1)}>{step === 2 ? "おすすめ旅程を見る" : step === 0 ? "旅の気分を選ぶ" : "行き先を選ぶ"} →</button>}</div>}
    </section>}
    {step === 3 && <section className="discover-workspace discovery-deck" aria-label="旅の候補を探す">
      <div className="discover-results" ref={resultsRef}><header className="discover-results-heading"><div><h2 ref={resultsHeadingRef} tabIndex={-1}>{areaName}{applied.crossPrefecture ? "周辺" : "内"}の旅のプラン</h2></div>{!generating && <span className="discover-result-count">{routes.length}件の候補</span>}</header>
        <div className="discover-conditions-summary"><button type="button" onClick={editDestination}>行き先を選び直す</button><button type="button" onClick={editConditions}>条件を変更 <span aria-hidden="true">↑</span></button></div>
        {!(remote?.key === conditionsKey && remote.agent?.status === "ready" && remote.agent.message === "AIが公式紹介の見どころを参考に、行き先と巡る順番を選びました。") && <p className="discover-agent-status" role="status" data-ready={remote?.key === conditionsKey && remote.agent?.status === "ready"}>{generating ? "AIが条件に合わせて行き先を選んでいます。" : remote?.key === conditionsKey ? remote.agent?.message ?? "施設データから条件に合う候補を表示しています。" : "まずは通常の候補を表示しています。条件を選んで「この条件で探す」を押してください。"}</p>}
        {generating && <ProgressStatus title="AIが旅の候補を選んでいます" steps={DISCOVER_STEPS} onCancel={cancelGeneration} />}
        {!generating && remote?.key === conditionsKey && remote.review && <JourneyReview key={remote.review.id} report={remote.review}
          onAdopt={route => { cancelAdvance(); setSelected(null); setDeckEpoch(v => v + 1); setRemote(current => current ? {...current, routes: [route]} : current); updateCollection(EMPTY_BROWSE); }}
          onRestore={() => { cancelAdvance(); setSelected(null); setDeckEpoch(v => v + 1); setRemote(current => current ? {...current, routes: diverseRoutes(current.originalRoutes ?? [], [])} : current); updateCollection(EMPTY_BROWSE); }} />}
        {!generating && <><div className="discover-stack" aria-busy={preparingNext}><AnimatePresence custom={exitDirection === "like" ? "accept" : "skip"}>{stack.map((route, depth) => ({ route, depth })).reverse().map(({ route, depth }) => <DiscoverCard key={`${deckEpoch}:${route.id}`} route={route} depth={depth} active={active && !generating && !selected} preparingNext={preparingNext && depth === 0} exitDirection={exitDirection} onSwipe={swipe} />)}</AnimatePresence>
          {routes.length === 0 && <div className="discover-empty"><span className="discover-empty-icon" aria-hidden="true">⌁</span><strong>この条件で新しく提案できる旅程はありません</strong><p>似た旅程や、すでに見た候補を除いています。気分・行き先・移動範囲を変えてみてください。</p><button type="button" className="idea-primary-button" onClick={editConditions}>条件を変えて探す</button></div>}
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

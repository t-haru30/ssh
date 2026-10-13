import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { isOrigin, isRecord, isSavedRouteIdea } from "./apiValidation";
import type { RouteIdea } from "./SwipeCard";
import { usePrefecture } from "./PrefectureContext";
import { parseJourneyFile } from "./journeyFile";
import { parseOvernightSnapshot } from "./overnightFavorite";

const FAVORITES_STORAGE_KEY = "kyoto-route-planner:favorites:v1";
export const MAX_FAVORITES = 50;

export type FavoriteRoute = RouteIdea & {
  id: string;
  prefecture_code: string;
  prefecture_name: string;
  tags: Record<string, string>;
  saved_at: string;
  pinned?: boolean;
  edited?: boolean;
};

type FavoritesContextValue = {
  favorites: FavoriteRoute[];
  error: string | null;
  saveFavorite: (idea: RouteIdea) => boolean;
  replaceFavorite: (id: string, idea: RouteIdea) => boolean;
  removeFavorite: (id: string) => boolean;
  togglePin: (id: string) => boolean;
  isFavorite: (idea: RouteIdea) => boolean;
};

type FavoritesState = {
  favorites: FavoriteRoute[];
  error: string | null;
};

const FavoritesContext = createContext<FavoritesContextValue | null>(null);

function hasValidJourneyFile(value: { journey_file?: unknown }): boolean {
  if (value.journey_file === undefined) return true;
  if (typeof value.journey_file !== "string") return false;
  try { parseJourneyFile(value.journey_file); return true; } catch { return false; }
}
function hasValidOvernight(value: { overnight_snapshot?: unknown }): boolean {
  if (value.overnight_snapshot === undefined) return true;
  try { parseOvernightSnapshot(value.overnight_snapshot); return true; } catch { return false; }
}

function isFavoriteRoute(value: unknown): value is FavoriteRoute {
  if (!isRecord(value)) return false;
  if (!hasValidJourneyFile(value) || !hasValidOvernight(value)) return false;
  const favorite = value;
  return isSavedRouteIdea(value)
    && typeof favorite.id === "string"
    && favorite.id.length > 0
    && typeof favorite.prefecture_code === "string"
    && typeof favorite.prefecture_name === "string"
    && isRecord(favorite.tags)
    && Object.values(favorite.tags).every((tag) => typeof tag === "string")
    && typeof favorite.saved_at === "string"
    && (favorite.pinned === undefined || typeof favorite.pinned === "boolean")
    && (favorite.origin === undefined || isOrigin(favorite.origin))
    && (favorite.dwell_minutes === undefined
      || (isRecord(favorite.dwell_minutes)
        && !Array.isArray(favorite.dwell_minutes)
        && Object.values(favorite.dwell_minutes).every((minutes) => (
          typeof minutes === "number" && Number.isSafeInteger(minutes) && minutes >= 0
        ))));
}

// 上限を超えたら、ピン留めされていない最も古いルート（配列の末尾側）から削除する
export function trimFavorites(favorites: FavoriteRoute[], max: number = MAX_FAVORITES): FavoriteRoute[] | null {
  const result = [...favorites];
  while (result.length > max) {
    let index = -1;
    for (let cursor = result.length - 1; cursor >= 0; cursor -= 1) {
      if (!result[cursor].pinned) {
        index = cursor;
        break;
      }
    }
    if (index < 0) return null;
    result.splice(index, 1);
  }
  return result;
}

function readFavorites(): FavoritesState {
  if (typeof window === "undefined") return { favorites: [], error: null };
  try {
    const serialized = window.localStorage.getItem(FAVORITES_STORAGE_KEY);
    if (serialized === null) return { favorites: [], error: null };
    const payload: unknown = JSON.parse(serialized);
    if (!Array.isArray(payload) || !payload.every(isFavoriteRoute)) {
      throw new Error("保存済みルートのデータ形式が正しくありません。");
    }
    const unique = new Map(payload.map((favorite) => [favorite.id, favorite.overnight_snapshot ? { ...favorite, overnight_snapshot: parseOvernightSnapshot(favorite.overnight_snapshot) } : favorite]));
    const favorites = [...unique.values()].slice(0, MAX_FAVORITES);
    if (favorites.length < unique.size) {
      try {
        window.localStorage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify(favorites));
      } catch (cause) {
        const message = cause instanceof Error
          ? cause.message
          : "保存済みルートの上限を適用できませんでした。";
        console.error("Failed to limit saved routes in localStorage.", cause);
        return { favorites, error: message };
      }
    }
    return { favorites, error: null };
  } catch (cause) {
    const message = cause instanceof Error
      ? cause.message
      : "保存済みルートを読み込めませんでした。";
    console.error("Failed to read saved routes from localStorage.", cause);
    return { favorites: [], error: message };
  }
}

export function favoriteId(idea: RouteIdea, prefectureCode: string) {
  const placeIds = idea.places.map((place) => place.id).sort();
  let version = "";
  if (idea.overnight_snapshot) {
    let hash = 2166136261;
    for (const c of JSON.stringify(parseOvernightSnapshot(idea.overnight_snapshot))) hash = Math.imul(hash ^ c.charCodeAt(0), 16777619);
    version = `:overnight-${(hash >>> 0).toString(16)}`;
  }
  if (idea.journey_file) {
    const { savedAt: _savedAt, ...data } = parseJourneyFile(idea.journey_file);
    let hash = 2166136261;
    for (const c of JSON.stringify(data)) hash = Math.imul(hash ^ c.charCodeAt(0), 16777619);
    version = `:plan-${(hash >>> 0).toString(16)}`;
  }
  return `${prefectureCode}:${placeIds.join("|")}${version}`;
}

type FavoritesProviderProps = {
  children: ReactNode;
};

export function FavoritesProvider({ children }: FavoritesProviderProps) {
  const { prefecture } = usePrefecture();
  const [state, setState] = useState<FavoritesState>(readFavorites);
  const favoritesRef = useRef(state.favorites);

  useEffect(() => {
    function handleStorage(event: StorageEvent) {
      if (event.key !== FAVORITES_STORAGE_KEY && event.key !== null) return;
      const nextState = readFavorites();
      favoritesRef.current = nextState.favorites;
      setState(nextState);
    }
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);

  const persist = useCallback((favorites: FavoriteRoute[]) => {
    try {
      window.localStorage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify(favorites));
      favoritesRef.current = favorites;
      setState({ favorites, error: null });
      return true;
    } catch (cause) {
      const message = cause instanceof Error
        ? cause.message
        : "保存済みルートを書き込めませんでした。";
      console.error("Failed to write saved routes to localStorage.", cause);
      setState((current) => ({ ...current, error: message }));
      return false;
    }
  }, []);

  const saveFavorite = useCallback((idea: RouteIdea) => {
    if (!isSavedRouteIdea(idea) || !hasValidJourneyFile(idea) || !hasValidOvernight(idea)) return false;
    if (idea.overnight_snapshot) idea = { ...idea, overnight_snapshot: parseOvernightSnapshot(idea.overnight_snapshot) };
    const prefectureCode = idea.prefecture_code ?? prefecture.code;
    const prefectureName = idea.prefecture_name ?? prefecture.name;
    const id = favoriteId(idea, prefectureCode);
    if (favoritesRef.current.some((favorite) => (favorite.id === id || favoriteId(favorite, favorite.prefecture_code) === id))) return false;
    const favorite: FavoriteRoute = {
      ...idea,
      id,
      prefecture_code: prefectureCode,
      prefecture_name: prefectureName,
      tags: {
        prefecture_code: prefectureCode,
        prefecture_name: prefectureName,
      },
      saved_at: new Date().toISOString(),
    };
    const trimmed = trimFavorites([favorite, ...favoritesRef.current]);
    if (!trimmed || !trimmed.some((route) => route.id === id)) {
      setState((current) => ({
        ...current,
        error: `保存数が上限（${MAX_FAVORITES}件）に達し、すべてピン留めされています。ピン留めを外してから保存してください。`,
      }));
      return false;
    }
    return persist(trimmed);
  }, [persist, prefecture]);

  const replaceFavorite = useCallback((id: string, idea: RouteIdea) => {
    const original = favoritesRef.current.find(item => item.id === id);
    if (!original || !isSavedRouteIdea(idea) || !hasValidJourneyFile(idea) || !hasValidOvernight(idea)) return false;
    const updated: FavoriteRoute = { ...original, ...idea, prefecture_code: idea.prefecture_code ?? original.prefecture_code, prefecture_name: idea.prefecture_name ?? original.prefecture_name, id, edited: true, saved_at: new Date().toISOString() };
    return persist(favoritesRef.current.map(item => item.id === id ? updated : item));
  }, [persist]);

  const togglePin = useCallback((id: string) => {
    const current = favoritesRef.current;
    if (!current.some((favorite) => favorite.id === id)) return false;
    return persist(current.map((favorite) => (
      favorite.id === id ? { ...favorite, pinned: !favorite.pinned } : favorite
    )));
  }, [persist]);

  const removeFavorite = useCallback((id: string) => {
    const current = favoritesRef.current;
    if (!current.some((favorite) => favorite.id === id)) return false;
    return persist(current.filter((favorite) => favorite.id !== id));
  }, [persist]);

  const isFavorite = useCallback((idea: RouteIdea) => {
    if (!isSavedRouteIdea(idea) || !hasValidJourneyFile(idea) || !hasValidOvernight(idea)) return false;
    const prefectureCode = idea.prefecture_code ?? prefecture.code;
    const id = favoriteId(idea, prefectureCode);
    return favoritesRef.current.some((favorite) => favorite.id === id || favoriteId(favorite, favorite.prefecture_code) === id);
  }, [prefecture]);

  const value = useMemo(() => ({
    favorites: state.favorites,
    error: state.error,
    saveFavorite,
    replaceFavorite,
    removeFavorite,
    togglePin,
    isFavorite,
  }), [isFavorite, removeFavorite, saveFavorite, replaceFavorite, togglePin, state]);

  return <FavoritesContext.Provider value={value}>{children}</FavoritesContext.Provider>;
}

export function useFavorites() {
  const context = useContext(FavoritesContext);
  if (!context) throw new Error("useFavorites must be used within FavoritesProvider.");
  return context;
}

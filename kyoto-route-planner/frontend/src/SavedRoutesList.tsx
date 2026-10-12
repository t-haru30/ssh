import { useEffect, useMemo, useState } from "react";
import { RouteDetailModal } from "./discover/RouteDetailModal";
import { MAX_FAVORITES, useFavorites } from "./useFavorites";
import type { FavoriteRoute } from "./useFavorites";

const NEAR_LIMIT_MARGIN = 5;

type SavedRoutesListProps = {
  onClose: () => void;
  onPlanInSearch?: React.ComponentProps<typeof RouteDetailModal>["onPlanInSearch"];
  onGoHome?: () => void;
};

function formatSavedDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : `${date.getMonth() + 1}/${date.getDate()}保存`;
}

export function SavedRoutesList({ onClose, onPlanInSearch, onGoHome }: SavedRoutesListProps) {
  const { favorites, error, removeFavorite, togglePin } = useFavorites();
  const [detail, setDetail] = useState<FavoriteRoute | null>(null);
  const [prefectureFilter, setPrefectureFilter] = useState("all");
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !detail) onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose, detail]);

  const prefectures = useMemo(() => {
    const names = new Map<string, string>();
    favorites.forEach((favorite) => names.set(favorite.prefecture_code, favorite.prefecture_name));
    return [...names.entries()].sort(([first], [second]) => first.localeCompare(second));
  }, [favorites]);

  const activeFilter = prefectures.some(([code]) => code === prefectureFilter) ? prefectureFilter : "all";
  const visible = useMemo(() => {
    const filtered = activeFilter === "all"
      ? favorites
      : favorites.filter((favorite) => favorite.prefecture_code === activeFilter);
    // ピン留めを先頭に、それ以外は保存順（新しい順）を維持する
    return [...filtered.filter((item) => item.pinned), ...filtered.filter((item) => !item.pinned)];
  }, [favorites, activeFilter]);
  const remaining = MAX_FAVORITES - favorites.length;

  return (
    <>
      <div className="favorites-backdrop" onClick={onClose}>
        <section
          className="favorites-panel"
          role="dialog"
          aria-modal="true"
          aria-labelledby="favorites-title"
          onClick={(event) => event.stopPropagation()}
        >
          <header className="favorites-header">
            <div>
              <p className="eyebrow">SAVED ROUTES</p>
              <h2 id="favorites-title">保存済みプラン</h2>
            </div>
            <button type="button" className="route-modal-close" onClick={onClose} aria-label="閉じる">✕</button>
          </header>

          <p className="favorites-limit-note">
            保存数の上限は{MAX_FAVORITES}件です。上限を超えると、ピン留めしていない古いルートから自動的に削除されます。
          </p>
          {remaining <= NEAR_LIMIT_MARGIN && favorites.length > 0 && (
            <p className="favorites-near-limit" role="status">
              {remaining > 0
                ? `あと${remaining}件で上限です。残したいルートは📌でピン留めすると削除されません。`
                : "上限に達しています。次に保存すると、ピン留めしていない最も古いルートが削除されます。"}
            </p>
          )}
          {error && <p className="favorites-error" role="alert">{error}</p>}
          {prefectures.length > 1 && (
            <label className="favorites-filter">
              都道府県で絞り込む
              <select value={activeFilter} onChange={(event) => setPrefectureFilter(event.target.value)}>
                <option value="all">すべて（{favorites.length}件）</option>
                {prefectures.map(([code, name]) => (
                  <option key={code} value={code}>{name}</option>
                ))}
              </select>
            </label>
          )}
          {favorites.length === 0 ? (
            <div className="favorites-empty">
              <span className="favorites-empty-icon" aria-hidden="true">♡</span>
              <p>まだ保存されたプランはありません。</p>
              <p>見つける画面からお気に入りを保存できます。</p>
              {onGoHome && (
                <button type="button" className="favorites-home-button nowrap" onClick={onGoHome}>
                  ホームに戻る
                </button>
              )}
            </div>
          ) : (
            <ul className="favorites-list">
              {visible.map((favorite) => (
                <li className="favorite-route" key={favorite.id}>
                  <button
                    type="button"
                    className="favorite-route-open"
                    onClick={() => setDetail(favorite)}
                    aria-label={`${favorite.title}の詳細を見る`}
                  >
                    {favorite.image_url && (
                      <img
                        className="favorite-route-image"
                        src={favorite.image_url}
                        alt=""
                        onError={(event) => {
                          event.currentTarget.style.display = "none";
                        }}
                      />
                    )}
                    <div className="favorite-route-content">
                      <div className="favorite-route-heading">
                        <h3>{favorite.pinned ? "📌 " : ""}{favorite.title}</h3>
                        <span className="favorite-prefecture-tag">
                          {favorite.prefecture_name} ({favorite.prefecture_code})
                        </span>
                      </div>
                      <p>{favorite.places.map((place) => place.name).join(" → ")}</p>
                      <span className="favorite-route-more">{formatSavedDate(favorite.saved_at)} · 詳細を見る ›</span>
                    </div>
                  </button>
                  <div className="favorite-route-footer">
                    {favorite.author_name && favorite.source_url && (
                      <a href={favorite.source_url} target="_blank" rel="noreferrer">
                        画像提供: {favorite.author_name}
                      </a>
                    )}
                    <button
                      type="button"
                      className="favorite-pin-button"
                      onClick={() => togglePin(favorite.id)}
                      aria-pressed={Boolean(favorite.pinned)}
                      aria-label={`${favorite.title}を${favorite.pinned ? "ピン留め解除" : "ピン留め"}`}
                    >
                      {favorite.pinned ? "📌 ピン留め中" : "📌 ピン留め"}
                    </button>
                    {confirmingId === favorite.id ? (
                      <span className="favorite-confirm">
                        <button
                          type="button"
                          className="favorite-remove-button"
                          onClick={() => {
                            removeFavorite(favorite.id);
                            setConfirmingId(null);
                          }}
                          aria-label={`${favorite.title}の削除を確定`}
                        >
                          削除する
                        </button>
                        <button type="button" className="favorite-cancel-button" onClick={() => setConfirmingId(null)}>
                          やめる
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="favorite-remove-button"
                        onClick={() => setConfirmingId(favorite.id)}
                        aria-label={`${favorite.title}を保存から削除`}
                      >
                        🗑 削除
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
      {detail && <RouteDetailModal route={detail} onClose={() => setDetail(null)} onPlanInSearch={onPlanInSearch} />}
    </>
  );
}

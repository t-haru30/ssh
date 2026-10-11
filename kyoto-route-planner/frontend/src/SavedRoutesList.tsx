import { useEffect, useState } from "react";
import { RouteDetailModal } from "./discover/RouteDetailModal";
import { MAX_FAVORITES, useFavorites } from "./useFavorites";
import type { FavoriteRoute } from "./useFavorites";

type SavedRoutesListProps = {
  onClose: () => void;
};

export function SavedRoutesList({ onClose }: SavedRoutesListProps) {
  const { favorites, error, removeFavorite } = useFavorites();
  const [detail, setDetail] = useState<FavoriteRoute | null>(null);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !detail) onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose, detail]);

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
            保存数の上限は{MAX_FAVORITES}件です。上限を超えると、古いルートから自動的に削除されます。
          </p>
          {error && <p className="favorites-error" role="alert">{error}</p>}
          {favorites.length === 0 ? (
            <div className="favorites-empty">
              <span className="favorites-empty-icon" aria-hidden="true">♡</span>
              <p>まだ保存されたプランはありません。</p>
              <p>スワイプしてお気に入りを見つけましょう！</p>
            </div>
          ) : (
            <ul className="favorites-list">
              {favorites.map((favorite) => (
                <li className="favorite-route" key={favorite.id}>
                  <button
                    type="button"
                    className="favorite-route-open"
                    onClick={() => setDetail(favorite)}
                    aria-label={`${favorite.title}の詳細を見る`}
                  >
                    {favorite.image_url && (
                      <img className="favorite-route-image" src={favorite.image_url} alt="" />
                    )}
                    <div className="favorite-route-content">
                      <div className="favorite-route-heading">
                        <h3>{favorite.title}</h3>
                        <span className="favorite-prefecture-tag">
                          {favorite.prefecture_name} ({favorite.prefecture_code})
                        </span>
                      </div>
                      <p>{favorite.places.map((place) => place.name).join(" → ")}</p>
                      <span className="favorite-route-more">詳細を見る ›</span>
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
                      className="favorite-remove-button"
                      onClick={() => removeFavorite(favorite.id)}
                      aria-label={`${favorite.title}を保存から削除`}
                    >
                      🗑 削除
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
      {detail && <RouteDetailModal route={detail} onClose={() => setDetail(null)} />}
    </>
  );
}

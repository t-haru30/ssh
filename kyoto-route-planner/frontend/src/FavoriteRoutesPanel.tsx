import { useEffect } from "react";
import { useFavorites } from "./useFavorites";

type FavoriteRoutesPanelProps = {
  onClose: () => void;
};

export function FavoriteRoutesPanel({ onClose }: FavoriteRoutesPanelProps) {
  const { favorites, error, removeFavorite } = useFavorites();

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
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
            <h2 id="favorites-title">保存したルート</h2>
          </div>
          <button type="button" className="route-modal-close" onClick={onClose} aria-label="閉じる">✕</button>
        </header>

        {error && <p className="favorites-error" role="alert">{error}</p>}
        {favorites.length === 0 ? (
          <p className="favorites-empty">保存したルートはありません。右スワイプでお気に入りに追加できます。</p>
        ) : (
          <ul className="favorites-list">
            {favorites.map((favorite) => (
              <li className="favorite-route" key={favorite.id}>
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
                    保存を解除
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

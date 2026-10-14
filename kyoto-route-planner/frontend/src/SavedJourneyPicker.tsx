import type { FavoriteRoute } from "./useFavorites";

export function SavedJourneyPicker({ favorites, onEdit }: {
  favorites: FavoriteRoute[]; onEdit: (route: FavoriteRoute) => void;
}) {
  if (!favorites.length) return null;
  const ordered = [...favorites.filter(route => route.pinned), ...favorites.filter(route => !route.pinned)];
  return <section className="discovery-liked saved-journey-picker" aria-label="保存した旅程から編集">
    <h2>保存した旅程 <small>{favorites.length}件</small></h2>
    <div className="saved-journey-options">{ordered.map(route => <article key={route.id}>
      <div><strong>{route.title}</strong><small>{route.prefecture_name}{route.edited ? " · 編集済み" : ""}</small>
        <p>{route.places.map(place => place.name).join(" → ")}</p></div>
      <button type="button" aria-label={`${route.title}を編集`} onClick={() => onEdit(route)}>編集する →</button>
    </article>)}</div>
  </section>;
}

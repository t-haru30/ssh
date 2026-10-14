import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { animate, motion, useMotionValue, useTransform, usePresence, usePresenceData } from "framer-motion";
import type { PanInfo } from "framer-motion";
import type { Theme } from "./types";

export type SharedSwipeDirection = "accept" | "skip";

export type SharedSwipeCardSpot = {
  id: string;
  name: string;
  category?: string;
  appeal?: string;
  icon?: ReactNode;
};

export type SharedSwipeCardProps = {
  presentation?: "full" | "visual";
  theme: Theme;
  title: string;
  description?: string;
  descriptionLabel?: string;
  descriptionSupplement?: ReactNode;
  recommendationLabel?: string;
  recommendationSources?: ReactNode;
  summary?: string;
  spots: SharedSwipeCardSpot[];
  imageUrl?: string | null;
  coverContent?: ReactNode;
  imageReady?: boolean;
  photoPlaceName?: string | null;
  illustrationLabel?: string;
  illustrationKind?: "route" | "theme";
  imageStatus?: string;
  onSpotSelect?: (id: string) => void;
  authorName?: string | null;
  sourceUrl?: string | null;
  licenseName?: string | null;
  licenseUrl?: string | null;
  coverBadge: string;
  depth: number;
  isTop: boolean;
  isProcessing?: boolean;
  swipeEnabled?: boolean;
  acceptLabel?: string;
  skipLabel?: string;
  exitDirection: SharedSwipeDirection;
  onSwipe: (direction: SharedSwipeDirection) => boolean | void;
};

const SWIPE_THRESHOLD = 110;
const MAX_VISIBLE_SPOTS = 3;

export function SharedSwipeCard({
  presentation = "full",
  theme,
  title,
  description,
  descriptionLabel,
  descriptionSupplement,
  recommendationLabel,
  recommendationSources,
  summary,
  spots,
  imageUrl,
  coverContent,
  imageReady = false,
  photoPlaceName,
  illustrationLabel,
  illustrationKind = "theme",
  imageStatus,
  onSpotSelect,
  authorName,
  sourceUrl,
  licenseName,
  licenseUrl,
  coverBadge,
  depth,
  isTop,
  isProcessing = false,
  swipeEnabled = true,
  acceptLabel = "行きたい",
  skipLabel = "SKIP",
  exitDirection,
  onSwipe,
}: SharedSwipeCardProps) {
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const swipedRef = useRef(false);
  const x = useMotionValue(0);
  const opacity = useMotionValue(1);
  const [isPresent, safeToRemove] = usePresence();
  const presenceDirection = usePresenceData() as SharedSwipeDirection | undefined;
  const departureDirection = presenceDirection ?? exitDirection;

  useEffect(() => {
    if (isPresent) return;
    // Own the drag value during departure; do not compete with a variant animation.
    x.stop();
    const target = departureDirection === "accept" ? Math.max(520, x.get() + 320) : Math.min(-520, x.get() - 320);
    const movement = animate(x, target, { duration: 0.25, ease: "easeOut" });
    const fade = animate(opacity, 0, { duration: 0.25 });
    let removed = false;
    const remove = () => { if (!removed) { removed = true; safeToRemove?.(); } };
    void Promise.all([movement, fade]).then(remove);
    // WebKit may suspend animation completion when a touch is cancelled.
    const timeout = window.setTimeout(remove, 400);
    return () => { removed = true; window.clearTimeout(timeout); movement.stop(); fade.stop(); };
  }, [isPresent, departureDirection, safeToRemove, x, opacity]);
  const rotate = useTransform(x, [-240, 240], [-13, 13]);
  const backgroundColor = useTransform(x, value => `color-mix(in srgb, var(--paper) ${100 - Math.min(30, Math.abs(value) / 110 * 30)}%, ${value < 0 ? "#8a9198" : "#e89a62"})`);
  const skipOpacity = useTransform(x, [-140, -35], [1, 0]);
  const acceptOpacity = useTransform(x, [35, 140], [0, 1]);
  const hasCoverImage = Boolean(imageUrl) && failedUrl !== imageUrl;
  const imageLoaded = imageReady || loadedUrl === imageUrl;
  const titleBoundary = title.indexOf("から、");
  useEffect(() => { if (!isProcessing) swipedRef.current = false; }, [isProcessing, isTop, title]);

  function handleDragEnd(_event: MouseEvent | TouchEvent | PointerEvent, info: PanInfo) {
    if (!isPresent || !swipeEnabled || !isTop || isProcessing || swipedRef.current) return;
    if (info.offset.x > SWIPE_THRESHOLD) {
      swipedRef.current = true;
      if (onSwipe("accept") === false) { swipedRef.current = false; animate(x, 0, { duration: 0.2 }); }
    } else if (info.offset.x < -SWIPE_THRESHOLD) {
      swipedRef.current = true;
      if (onSwipe("skip") === false) { swipedRef.current = false; animate(x, 0, { duration: 0.2 }); }
    } else {
      animate(x, 0, { duration: 0.2 });
    }
  }

  return (
    <motion.article
      className={`swipe-card${presentation === "visual" ? ` swipe-card-visual${!isTop ? " is-behind" : ""}` : ""}${isProcessing ? " is-processing" : ""}`}
      style={{ x, rotate, opacity, backgroundColor, zIndex: 10 - depth, pointerEvents: isTop && isPresent ? "auto" : "none" }}
      drag={isPresent && swipeEnabled && isTop && !isProcessing ? "x" : false}
      dragMomentum={false}
      whileTap={swipeEnabled && isTop && !isProcessing ? { cursor: "grabbing" } : undefined}
      onDragStart={() => x.stop()}
      onDragEnd={handleDragEnd}
      onPointerCancel={() => { if (isPresent && !swipedRef.current) animate(x, 0, { duration: 0.2 }); }}
      initial={{ scale: 0.94, y: 22 }}
      animate={{ scale: 1 - depth * 0.035, y: depth * 12 }}
      transition={{ type: "spring", stiffness: 280, damping: 25 }}
      aria-label={title}
      aria-busy={isProcessing}
      inert={!isTop || !isPresent}
    >
      {swipeEnabled && <motion.div className="swipe-stamp skip" aria-hidden="true" style={{ opacity: skipOpacity, pointerEvents: "none" }}>{skipLabel}</motion.div>}
      {swipeEnabled && <motion.div className="swipe-stamp accept" aria-hidden="true" style={{ opacity: acceptOpacity, pointerEvents: "none" }}>{acceptLabel}</motion.div>}
      <div className={`swipe-cover theme-${theme}${hasCoverImage || coverContent ? " has-image" : ""}`}>
        {coverContent ?? <>
        {hasCoverImage ? (
          <>
            {!imageLoaded && <div className="swipe-cover-skeleton" aria-hidden="true" />}
            <img
              className={`swipe-cover-image${imageLoaded ? " loaded" : ""}`}
              src={imageUrl ?? undefined}
              alt=""
              aria-hidden="true"
              loading="eager"
              decoding="async"
              onLoad={() => setLoadedUrl(imageUrl ?? null)}
              onError={() => setFailedUrl(imageUrl ?? null)}
            />
          </>
        ) : (
          <div className="swipe-cover-placeholder" aria-hidden="true">
            <PinIcon />
            <span>{spots[0]?.name ?? "京都"}</span>
          </div>
        )}
        {hasCoverImage && (
          <>
            {spots[0] && !illustrationLabel && (
              <div className="swipe-cover-spot" data-testid="cover-spot-name">
                <PinIcon />
                <strong>{photoPlaceName ?? spots[0].name}</strong>
              </div>
            )}
            <span className="swipe-cover-image-label">{illustrationLabel ? illustrationKind === "route" ? "AIルートイラスト" : "AIテーマイラスト" : `${photoPlaceName ?? spots[0]?.name}の写真`}</span>
            {illustrationLabel && <strong className="swipe-cover-theme-label">{illustrationLabel}</strong>}
            {!photoPlaceName && !illustrationLabel && authorName && sourceUrl && licenseName && licenseUrl && (
              <div className="swipe-cover-credit" onPointerDown={(event) => event.stopPropagation()}>
                <a href={sourceUrl} target="_blank" rel="noopener noreferrer">{authorName}</a>
                <a
                  className="swipe-cover-license"
                  href={licenseUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {licenseName}
                </a>
              </div>
            )}
          </>
        )}
        </>}
        {presentation !== "visual" && <span className="swipe-cover-badge">{coverBadge}</span>}
      </div>
      <div className="swipe-card-copy">
        {presentation === "visual" && <span className="swipe-plan-course">{coverBadge}</span>}
        {imageStatus && (!hasCoverImage || !photoPlaceName) && <p className="route-illustration-status" role="status">{photoPlaceName && !hasCoverImage ? "写真を表示できませんでした。行き先の説明をご覧ください。" : imageStatus}</p>}
        <h3 title={title} data-long-title={title.length > 36 || undefined}>{titleBoundary > 0 ? <>
          <span className="swipe-title-part">{title.slice(0, titleBoundary + 3)}</span><wbr />
          <span className="swipe-title-part">{title.slice(titleBoundary + 3)}</span>
        </> : title}</h3>
        {recommendationLabel && <span className="discover-recommendation-label">✦ {recommendationLabel}</span>}
        {description && (descriptionLabel ? <section className="swipe-reason" aria-label={descriptionLabel}><strong>{descriptionLabel}</strong><p className="swipe-story">{description}</p>{descriptionSupplement}</section> : <p className="swipe-story">{description}</p>)}
        {recommendationSources}
        {summary && <p className="swipe-distance">{summary}</p>}
        {spots.length > 0 && <ul className="swipe-spot-list">
          {(onSpotSelect ? spots : spots.slice(0, MAX_VISIBLE_SPOTS)).map((spot) => (
            <li key={spot.id}>
              {onSpotSelect ? <button
                type="button"
                className="swipe-spot-open"
                onPointerDown={event => event.stopPropagation()}
                onClick={() => onSpotSelect(spot.id)}
                aria-label={`${spot.name}の説明を見る`}
                aria-haspopup="dialog"
              >
                <span className="swipe-spot-icon" aria-hidden="true">{spot.icon ?? <PinIcon />}</span>
                <span className="swipe-spot-copy"><strong>{spot.name}</strong>{spot.category && <small>{spot.category}</small>}{spot.appeal && <span className="swipe-spot-appeal">{spot.appeal}</span>}</span>
                <span className="swipe-spot-detail-label">説明 <span aria-hidden="true">›</span></span>
              </button> : <>
              <span className="swipe-spot-icon" aria-hidden="true">
                {spot.icon ?? <PinIcon />}
              </span>
              <span className="swipe-spot-copy">
                <strong>{spot.name}</strong>
              </span>
              {spot.category && <small className="swipe-spot-category">{spot.category}</small>}
              </>}
            </li>
          ))}
          {!onSpotSelect && spots.length > MAX_VISIBLE_SPOTS && (
            <li className="swipe-spot-more">ほか{spots.length - MAX_VISIBLE_SPOTS}か所（詳細で確認）</li>
          )}
        </ul>}
        {hasCoverImage && photoPlaceName && <div className="route-photo-credit" aria-label="写真のクレジット" onPointerDown={event => event.stopPropagation()}>
          <span>写真: <a href={sourceUrl ?? undefined} target="_blank" rel="noopener noreferrer">{authorName}</a></span>
          <a href={sourceUrl ?? undefined} target="_blank" rel="noopener noreferrer">写真の出典</a>
          <a href={licenseUrl ?? undefined} target="_blank" rel="noopener noreferrer">{licenseName}</a>
          <span className="route-photo-crop">一部トリミング</span>
        </div>}
      </div>
    </motion.article>
  );
}

function PinIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 2a7 7 0 0 0-7 7c0 5.2 7 13 7 13s7-7.8 7-13a7 7 0 0 0-7-7Zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5Z" />
    </svg>
  );
}

import { useEffect, useRef, useState } from "react";
import { motion, useMotionValue, useTransform } from "framer-motion";
import type { PanInfo } from "framer-motion";
import type { Theme } from "./types";

export type SharedSwipeDirection = "accept" | "skip";

export type SharedSwipeCardSpot = {
  id: string;
  name: string;
  category?: string;
  icon?: string;
};

export type SharedSwipeCardProps = {
  theme: Theme;
  title: string;
  description?: string;
  recommendationLabel?: string;
  summary?: string;
  spots: SharedSwipeCardSpot[];
  imageUrl?: string | null;
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
  acceptLabel?: string;
  exitDirection: SharedSwipeDirection;
  onSwipe: (direction: SharedSwipeDirection) => void;
};

const SWIPE_THRESHOLD = 110;
const MAX_VISIBLE_SPOTS = 3;
const cardVariants = {
  exit: (direction: SharedSwipeDirection) => ({
    x: direction === "accept" ? 520 : -520,
    opacity: 0,
    rotate: direction === "accept" ? 16 : -16,
    transition: { duration: 0.25 },
  }),
};

export function SharedSwipeCard({
  theme,
  title,
  description,
  recommendationLabel,
  summary,
  spots,
  imageUrl,
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
  acceptLabel = "行きたい",
  exitDirection,
  onSwipe,
}: SharedSwipeCardProps) {
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const swipedRef = useRef(false);
  const x = useMotionValue(0);
  const rotate = useTransform(x, [-240, 240], [-13, 13]);
  const skipOpacity = useTransform(x, [-140, -35], [1, 0]);
  const acceptOpacity = useTransform(x, [35, 140], [0, 1]);
  const hasCoverImage = Boolean(imageUrl) && failedUrl !== imageUrl;
  const imageLoaded = imageReady || loadedUrl === imageUrl;
  const titleBoundary = title.indexOf("から、");
  useEffect(() => { if (!isProcessing) swipedRef.current = false; }, [isProcessing]);

  function handleDragEnd(_event: MouseEvent | TouchEvent | PointerEvent, info: PanInfo) {
    if (!isTop || isProcessing || swipedRef.current) return;
    if (info.offset.x > SWIPE_THRESHOLD) {
      swipedRef.current = true;
      onSwipe("accept");
    } else if (info.offset.x < -SWIPE_THRESHOLD) {
      swipedRef.current = true;
      onSwipe("skip");
    }
  }

  return (
    <motion.article
      className={`swipe-card${isProcessing ? " is-processing" : ""}`}
      custom={exitDirection}
      variants={cardVariants}
      style={{ x, rotate, zIndex: 10 - depth, pointerEvents: isTop ? "auto" : "none" }}
      drag={isTop && !isProcessing ? "x" : false}
      dragConstraints={{ left: 0, right: 0 }}
      dragElastic={0.82}
      whileTap={isTop && !isProcessing ? { cursor: "grabbing" } : undefined}
      onDragEnd={handleDragEnd}
      initial={{ scale: 0.94, y: 22, opacity: 0 }}
      animate={{ scale: 1 - depth * 0.035, y: depth * 12, opacity: 1 }}
      exit="exit"
      transition={{ type: "spring", stiffness: 280, damping: 25 }}
      aria-label={title}
      aria-busy={isProcessing}
      inert={!isTop}
    >
      <motion.div className="swipe-stamp skip" style={{ opacity: skipOpacity }}>SKIP</motion.div>
      <motion.div className="swipe-stamp accept" style={{ opacity: acceptOpacity }}>{acceptLabel}</motion.div>
      <div className={`swipe-cover theme-${theme}${hasCoverImage ? " has-image" : ""}`}>
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
        <span className="swipe-cover-badge">{coverBadge}</span>
      </div>
      <div className="swipe-card-copy">
        {imageStatus && (!hasCoverImage || !photoPlaceName) && <p className="route-illustration-status" role="status">{photoPlaceName && !hasCoverImage ? "写真を表示できませんでした。行き先の説明をご覧ください。" : imageStatus}</p>}
        <h3 title={title}>{titleBoundary > 0 ? <>
          <span className="swipe-title-part">{title.slice(0, titleBoundary + 3)}</span><wbr />
          <span className="swipe-title-part">{title.slice(titleBoundary + 3)}</span>
        </> : title}</h3>
        {recommendationLabel && <span className="discover-recommendation-label">✦ {recommendationLabel}</span>}
        {description && <p className="swipe-story">{description}</p>}
        {summary && <p className="swipe-distance">{summary}</p>}
        <ul className="swipe-spot-list">
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
                <span className="swipe-spot-copy"><strong>{spot.name}</strong>{spot.category && <small>{spot.category}</small>}</span>
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
        </ul>
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

import { useRef, useState } from "react";
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
  summary?: string;
  spots: SharedSwipeCardSpot[];
  imageUrl?: string | null;
  authorName?: string | null;
  sourceUrl?: string | null;
  licenseName?: string | null;
  licenseUrl?: string | null;
  coverBadge: string;
  depth: number;
  isTop: boolean;
  isProcessing?: boolean;
  exitDirection: SharedSwipeDirection;
  onSwipe: (direction: SharedSwipeDirection) => void;
};

const SWIPE_THRESHOLD = 110;
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
  summary,
  spots,
  imageUrl,
  authorName,
  sourceUrl,
  licenseName,
  licenseUrl,
  coverBadge,
  depth,
  isTop,
  isProcessing = false,
  exitDirection,
  onSwipe,
}: SharedSwipeCardProps) {
  const [imageLoaded, setImageLoaded] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);
  const swipedRef = useRef(false);
  const x = useMotionValue(0);
  const rotate = useTransform(x, [-240, 240], [-13, 13]);
  const skipOpacity = useTransform(x, [-140, -35], [1, 0]);
  const acceptOpacity = useTransform(x, [35, 140], [0, 1]);
  const hasCoverImage = Boolean(imageUrl) && !imageFailed;

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
    >
      <motion.div className="swipe-stamp skip" style={{ opacity: skipOpacity }}>SKIP</motion.div>
      <motion.div className="swipe-stamp accept" style={{ opacity: acceptOpacity }}>行きたい</motion.div>
      <div className={`swipe-cover theme-${theme}${hasCoverImage ? " has-image" : ""}`}>
        {hasCoverImage ? (
          <>
            {!imageLoaded && <div className="swipe-cover-skeleton" aria-hidden="true" />}
            <img
              className={`swipe-cover-image${imageLoaded ? " loaded" : ""}`}
              src={imageUrl ?? undefined}
              alt=""
              aria-hidden="true"
              onLoad={() => setImageLoaded(true)}
              onError={() => setImageFailed(true)}
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
            <span className="swipe-cover-image-label">イメージ画像</span>
            {authorName && sourceUrl && licenseName && licenseUrl && (
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
        <h3 title={title}>{title}</h3>
        {description && <p className="swipe-story">{description}</p>}
        {summary && <p className="swipe-distance">{summary}</p>}
        <ul className="swipe-spot-list">
          {spots.map((spot) => (
            <li key={spot.id}>
              <span className="swipe-spot-icon" aria-hidden="true">
                {spot.icon ?? <PinIcon />}
              </span>
              <span className="swipe-spot-copy">
                <strong>{spot.name}</strong>
              </span>
              {spot.category && <small className="swipe-spot-category">{spot.category}</small>}
            </li>
          ))}
        </ul>
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

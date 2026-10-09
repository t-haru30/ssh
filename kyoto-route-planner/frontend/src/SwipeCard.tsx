import { useState } from "react";
import { motion, useMotionValue, useTransform } from "framer-motion";
import type { PanInfo } from "framer-motion";
import type { Place } from "./types";

export type SwipeDirection = "accept" | "skip";

export type RouteIdea = {
  theme: Place["themes"][number];
  title: string;
  story: string;
  places: Place[];
  image_url?: string | null;
  copywriting_source: "gemini" | "fallback";
  note: string;
};

type SwipeCardProps = {
  idea: RouteIdea;
  depth: number;
  onSwipe: (direction: SwipeDirection) => void;
};

const SWIPE_THRESHOLD = 110;
const cardVariants = {
  exit: (direction: SwipeDirection) => ({
    x: direction === "accept" ? 520 : -520,
    opacity: 0,
    rotate: direction === "accept" ? 16 : -16,
    transition: { duration: 0.25 },
  }),
};

export function SwipeCard({ idea, depth, onSwipe }: SwipeCardProps) {
  const [imageLoaded, setImageLoaded] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);
  const x = useMotionValue(0);
  const rotate = useTransform(x, [-240, 240], [-13, 13]);
  const skipOpacity = useTransform(x, [-140, -35], [1, 0]);
  const acceptOpacity = useTransform(x, [35, 140], [0, 1]);
  const hasCoverImage = Boolean(idea.image_url) && !imageFailed;

  function handleDragEnd(_event: MouseEvent | TouchEvent | PointerEvent, info: PanInfo) {
    if (info.offset.x > SWIPE_THRESHOLD) {
      onSwipe("accept");
    } else if (info.offset.x < -SWIPE_THRESHOLD) {
      onSwipe("skip");
    }
  }

  return (
    <motion.article
      className="swipe-card"
      variants={cardVariants}
      style={{ x, rotate, zIndex: 10 - depth }}
      drag="x"
      dragConstraints={{ left: 0, right: 0 }}
      dragElastic={0.82}
      whileTap={{ cursor: "grabbing" }}
      onDragEnd={handleDragEnd}
      initial={{ scale: 0.94, y: 22, opacity: 0 }}
      animate={{ scale: 1 - depth * 0.035, y: depth * 12, opacity: 1 }}
      exit="exit"
      transition={{ type: "spring", stiffness: 280, damping: 25 }}
      aria-label={idea.title}
    >
      <motion.div className="swipe-stamp skip" style={{ opacity: skipOpacity }}>SKIP</motion.div>
      <motion.div className="swipe-stamp accept" style={{ opacity: acceptOpacity }}>行きたい</motion.div>
      <div className={`swipe-cover theme-${idea.theme}${hasCoverImage ? " has-image" : ""}`}>
        {hasCoverImage ? (
          <>
            {!imageLoaded && <div className="swipe-cover-skeleton" aria-hidden="true" />}
            <img
              className={`swipe-cover-image${imageLoaded ? " loaded" : ""}`}
              src={idea.image_url ?? undefined}
              alt=""
              aria-hidden="true"
              onLoad={() => setImageLoaded(true)}
              onError={() => setImageFailed(true)}
            />
          </>
        ) : (
          <div className="swipe-cover-placeholder" aria-hidden="true">
            <PinIcon />
            <span>{idea.places[0]?.name ?? "京都"}</span>
          </div>
        )}
        <span className="swipe-cover-badge">{idea.places.length}か所</span>
      </div>
      <div className="swipe-card-copy">
        <h3 title={idea.title}>{idea.title}</h3>
        <p className="swipe-story">{idea.story}</p>
        <ul className="swipe-spot-list">
          {idea.places.map((place) => (
            <li key={place.id}>
              <span className="swipe-spot-icon"><PinIcon /></span>
              <span className="swipe-spot-copy">
                <strong>{place.name}</strong>
              </span>
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

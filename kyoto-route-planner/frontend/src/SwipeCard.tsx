import { motion, useMotionValue, useTransform } from "framer-motion";
import type { PanInfo } from "framer-motion";
import type { Place } from "./types";

export type SwipeDirection = "accept" | "skip";

export type RouteIdea = {
  theme: Place["themes"][number];
  title: string;
  story: string;
  places: Place[];
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
  const x = useMotionValue(0);
  const rotate = useTransform(x, [-240, 240], [-13, 13]);
  const skipOpacity = useTransform(x, [-140, -35], [1, 0]);
  const acceptOpacity = useTransform(x, [35, 140], [0, 1]);

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
      <div className={`swipe-cover theme-${idea.theme}`}>
        <span className="swipe-cover-index">KYOTO · IDEA</span>
        <span className="swipe-cover-kanji" aria-hidden="true">
          {idea.theme === "nature" ? "景" : idea.theme === "temple" ? "祈" : idea.theme === "food" ? "味" : "京"}
        </span>
        <span className="swipe-cover-count">{idea.places.length} SPOTS</span>
      </div>
      <div className="swipe-card-copy">
        <p className="eyebrow">{idea.theme.toUpperCase()} · よりみちの提案</p>
        <h3>{idea.title}</h3>
        <p className="swipe-story">{idea.story}</p>
        <ol className="swipe-spot-list">
          {idea.places.map((place, index) => (
            <li key={place.id}>
              <span className="swipe-spot-number">{String(index + 1).padStart(2, "0")}</span>
              <span className="swipe-spot-copy">
                <strong>{place.name}</strong>
                <small>{place.category}{place.address ? ` · ${place.address}` : ""}</small>
              </span>
            </li>
          ))}
        </ol>
        <p className="swipe-hint">右へスワイプして採用 · 左へスワイプしてスキップ</p>
      </div>
    </motion.article>
  );
}

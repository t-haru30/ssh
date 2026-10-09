import { useRef, useState } from "react";
import { motion, useMotionValue, useTransform } from "framer-motion";
import type { PanInfo } from "framer-motion";
import type { DatasetRoute } from "./datasetTypes";

export type DiscoverDirection = "like" | "pass";

const SWIPE_THRESHOLD = 110;

const categoryIcons: Record<string, string> = {
  寺院: "🏯",
  神社: "⛩️",
  自然: "🌿",
  グルメ: "🍵",
  名所: "📍",
};

export function categoryIcon(category: string) {
  return categoryIcons[category] ?? "📍";
}

export function formatMinutes(minutes: number) {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest}分`;
  return rest === 0 ? `${hours}時間` : `${hours}時間${rest}分`;
}

const exitVariants = {
  exit: (direction: DiscoverDirection) => ({
    x: direction === "like" ? 560 : -560,
    opacity: 0,
    rotate: direction === "like" ? 16 : -16,
    transition: { duration: 0.22 },
  }),
};

type DiscoverCardProps = {
  route: DatasetRoute;
  depth: number;
  exitDirection: DiscoverDirection;
  onSwipe: (direction: DiscoverDirection) => void;
};

export function DiscoverCard({ route, depth, exitDirection, onSwipe }: DiscoverCardProps) {
  const x = useMotionValue(0);
  const rotate = useTransform(x, [-240, 240], [-13, 13]);
  const passOpacity = useTransform(x, [-140, -35], [1, 0]);
  const likeOpacity = useTransform(x, [35, 140], [0, 1]);
  const isTop = depth === 0;
  const swipedRef = useRef(false);
  const [dragging, setDragging] = useState(false);

  function handleDragEnd(_event: MouseEvent | TouchEvent | PointerEvent, info: PanInfo) {
    setDragging(false);
    if (swipedRef.current) return;
    if (info.offset.x > SWIPE_THRESHOLD) {
      swipedRef.current = true;
      onSwipe("like");
    } else if (info.offset.x < -SWIPE_THRESHOLD) {
      swipedRef.current = true;
      onSwipe("pass");
    }
  }

  return (
    <motion.article
      className={`discover-card${dragging ? " dragging" : ""}`}
      custom={exitDirection}
      variants={exitVariants}
      style={{ x, rotate, zIndex: 10 - depth, pointerEvents: isTop ? "auto" : "none" }}
      drag={isTop ? "x" : false}
      dragConstraints={{ left: 0, right: 0 }}
      dragElastic={0.82}
      onDragStart={() => setDragging(true)}
      onDragEnd={handleDragEnd}
      initial={{ scale: 0.94, y: 22, opacity: 0 }}
      animate={{ scale: 1 - depth * 0.04, y: depth * 14, opacity: 1 }}
      exit="exit"
      transition={{ type: "spring", stiffness: 280, damping: 25 }}
      aria-label={route.title}
    >
      <motion.div className="discover-stamp pass" style={{ opacity: passOpacity }}>SKIP</motion.div>
      <motion.div className="discover-stamp like" style={{ opacity: likeOpacity }}>行きたい</motion.div>
      <div className={`discover-cover theme-${route.theme}`}>
        <span className="discover-pattern">{route.pattern === "full_day" ? "1日コース" : "半日コース"}</span>
        <div className="discover-icons" aria-hidden="true">
          {route.spots.map((spot) => (
            <span key={spot.place_id} title={spot.category}>{categoryIcon(spot.category)}</span>
          ))}
        </div>
      </div>
      <div className="discover-body">
        <h3>{route.title}</h3>
        <p className="discover-duration">
          <span aria-hidden="true">⏱</span> 総所要時間 約{formatMinutes(route.estimated_minutes)}
        </p>
        <ul className="discover-spots">
          {route.spots.map((spot) => (
            <li key={spot.place_id}>
              <span aria-hidden="true">{categoryIcon(spot.category)}</span>
              <strong>{spot.name}</strong>
              <small>{spot.category}</small>
            </li>
          ))}
        </ul>
      </div>
    </motion.article>
  );
}

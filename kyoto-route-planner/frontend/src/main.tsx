import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { PrefectureProvider } from "./PrefectureContext";
import { FavoritesProvider } from "./useFavorites";
import "./style.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <PrefectureProvider>
      <FavoritesProvider>
        <App />
      </FavoritesProvider>
    </PrefectureProvider>
  </StrictMode>,
);

import { useEffect, useState } from "react";

export type ColorTheme = "light" | "dark" | "earth" | "sunset";

const themeOptions: { id: ColorTheme; label: string; icon: string }[] = [
  { id: "light", label: "ライト", icon: "☼" },
  { id: "dark", label: "ダーク", icon: "☾" },
  { id: "earth", label: "アース", icon: "◌" },
  { id: "sunset", label: "サンセット", icon: "◒" },
];

const storageKey = "kyoto-route-planner-color-theme";

function isColorTheme(value: string | null): value is ColorTheme {
  return themeOptions.some((option) => option.id === value);
}

function getStoredTheme(): ColorTheme {
  if (typeof window === "undefined") return "light";
  const storedTheme = window.localStorage.getItem(storageKey);
  return isColorTheme(storedTheme) ? storedTheme : "light";
}

export function ThemeSwitcher() {
  const [colorTheme, setColorTheme] = useState<ColorTheme>(getStoredTheme);

  useEffect(() => {
    document.documentElement.dataset.theme = colorTheme;
    window.localStorage.setItem(storageKey, colorTheme);
  }, [colorTheme]);

  return (
    <div className="theme-switcher">
      <label htmlFor="color-theme">配色</label>
      <div className="theme-select-wrap">
        <span aria-hidden="true">{themeOptions.find((option) => option.id === colorTheme)?.icon}</span>
        <select
          id="color-theme"
          value={colorTheme}
          onChange={(event) => {
            if (isColorTheme(event.target.value)) setColorTheme(event.target.value);
          }}
          aria-label="サイトの配色を選択"
        >
          {themeOptions.map((option) => (
            <option value={option.id} key={option.id}>{option.label}</option>
          ))}
        </select>
      </div>
    </div>
  );
}

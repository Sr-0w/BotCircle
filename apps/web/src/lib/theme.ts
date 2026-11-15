import { useSyncExternalStore } from "react";

/** Quiet UI ships three complete themes; "system" follows the OS between Light and Dark. */
export type ThemeChoice = "system" | "light" | "dark" | "oled";
const listeners = new Set<() => void>();
const media = window.matchMedia("(prefers-color-scheme: dark)");

function stored(): ThemeChoice {
  try {
    const value = localStorage.getItem("od-theme");
    return value === "light" || value === "dark" || value === "oled" ? value : "system";
  } catch {
    return "system";
  }
}

let choice: ThemeChoice = stored();

function apply() {
  const dark = choice === "dark" || choice === "oled" || (choice === "system" && media.matches);
  const root = document.documentElement;
  root.classList.toggle("dark", dark);
  root.classList.toggle("oled", choice === "oled");
  const color = choice === "oled" ? "#000000" : dark ? "#0D0D0E" : "#FFFFFF";
  for (const meta of document.querySelectorAll('meta[name="theme-color"]')) meta.setAttribute("content", color);
}
media.addEventListener("change", () => { apply(); for (const l of listeners) l(); });
apply();

export function setTheme(theme: ThemeChoice) {
  choice = theme;
  try {
    if (theme === "system") localStorage.removeItem("od-theme");
    else localStorage.setItem("od-theme", theme);
  } catch {
    // stockage indisponible
  }
  apply();
  for (const l of listeners) l();
}

export function useTheme() {
  const theme = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => choice,
  );
  return { theme, setTheme };
}

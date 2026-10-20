import { createSignal } from "solid-js";

export type Theme = "light" | "dark";

const saved = localStorage.getItem("theme") as Theme | null;
const [theme, set] = createSignal<Theme>(saved ?? "light");

export { theme };

export function setTheme(t: Theme) {
  localStorage.setItem("theme", t);
  set(t);
}

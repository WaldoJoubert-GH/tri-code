import { Toggle } from "./components/Toggle";
import { setTheme, theme } from "./theme";

export function Settings() {
  return (
    <section class="settings">
      <h2>Settings</h2>
      <Toggle
        label="Dark theme"
        on={theme() === "dark"}
        onChange={(on) => setTheme(on ? "dark" : "light")}
      />
    </section>
  );
}

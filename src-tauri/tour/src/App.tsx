import { Settings } from "./Settings";
import { theme } from "./theme";

export function App() {
  return (
    <main class={theme()}>
      <h1>tour</h1>
      <Settings />
    </main>
  );
}

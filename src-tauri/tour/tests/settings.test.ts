import { describe, expect, it } from "vitest";
import { setTheme, theme } from "../src/theme";

describe("theme", () => {
  it("switches to dark and remembers it", () => {
    setTheme("dark");
    expect(theme()).toBe("dark");
    expect(localStorage.getItem("theme")).toBe("dark");
  });
});

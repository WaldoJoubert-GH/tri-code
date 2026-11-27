import { expect, test } from "bun:test";
import { fillShots } from "./shots";

test("each shot becomes its path, quoted when it has a space", () => {
  const text = "1. <button>\n   screenshot: ⟦shot 1⟧\n2. <h1>\n   screenshot: ⟦shot 2⟧";
  expect(fillShots(text, ["/tmp/a.png", "C:\\Users\\Jo Smith\\b.png"])).toBe(
    '1. <button>\n   screenshot: /tmp/a.png\n2. <h1>\n   screenshot: "C:\\Users\\Jo Smith\\b.png"',
  );
});

test("a shot that wasn't saved says so", () => {
  expect(fillShots("image: ⟦shot 1⟧ and ⟦shot 3⟧", ["/tmp/a.png"], "(failed)")).toBe("image: /tmp/a.png and (failed)");
});

test("text without shots is left alone", () => {
  expect(fillShots("no images [shot 1]", [])).toBe("no images [shot 1]");
});

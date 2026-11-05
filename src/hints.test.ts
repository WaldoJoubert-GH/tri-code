// bun test: when the Hold Hints clock starts, and what cancels it (src/hints.ts).

import { afterEach, describe, expect, test } from "bun:test";
import { HINT_HOLD_MS, hintChord, hintDown, hintsShown, hintUp, holdMenuShown, isHintModifier, projectStepKey } from "./hints";
import { groupKeys } from "./keymap";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const key = (code: string, k = "Alt") => ({ code, key: k }) as KeyboardEvent;

afterEach(() => hintUp());

describe("hold hints", () => {
  test("holding the modifier alone long enough draws them; letting go hides them", async () => {
    hintDown();
    await wait(HINT_HOLD_MS + 30);
    expect(hintsShown()).toBe(true);
    hintUp();
    expect(hintsShown()).toBe(false);
  });

  test("a chord pressed inside the hold never draws them, however long the modifier stays down", async () => {
    hintDown();
    hintChord();
    await wait(HINT_HOLD_MS + 30);
    expect(hintsShown()).toBe(false);
    // Releasing and holding again is a fresh gesture.
    hintUp();
    hintDown();
    await wait(HINT_HOLD_MS + 30);
    expect(hintsShown()).toBe(true);
  });

  test("a key after the hints are up leaves them up until the modifier is released", async () => {
    hintDown();
    await wait(HINT_HOLD_MS + 30);
    hintChord();
    expect(hintsShown()).toBe(true);
    hintUp();
    expect(hintsShown()).toBe(false);
  });

  test("only the Hotkey Modifier itself counts; AltGr and other keys do not", () => {
    expect(isHintModifier(key("AltLeft"))).toBe(true);
    expect(isHintModifier(key("AltRight"))).toBe(true);
    expect(isHintModifier(key("AltRight", "AltGraph"))).toBe(false);
    expect(isHintModifier(key("KeyW", "w"))).toBe(false);
  });

  test("the hold opens the New Window menu until a key is pressed or the modifier released", async () => {
    hintDown();
    await wait(HINT_HOLD_MS + 30);
    expect(holdMenuShown()).toBe(true);
    hintChord(true); // Shift alone: a chord is starting, and the menu shows Shift's chords too
    expect(holdMenuShown()).toBe(true);
    hintChord();
    expect(holdMenuShown()).toBe(false);
    expect(hintsShown()).toBe(true);
    hintUp();
    hintDown();
    await wait(HINT_HOLD_MS + 30);
    hintUp();
    expect(holdMenuShown()).toBe(false);
  });

  test("a chord inside the hold never opens the menu", async () => {
    hintDown();
    hintChord();
    await wait(HINT_HOLD_MS + 30);
    expect(holdMenuShown()).toBe(false);
  });

  test("a group of keys prints a modifier they all share once, and every key when they differ", () => {
    expect(groupKeys(["swap-left", "swap-down"])).toEqual(["Shift", "H", "J"]);
    expect(groupKeys(["gap-less", "gap-more"])).toEqual([",", "."]);
    expect(groupKeys(["close", "restore-last"])).toEqual(["W", "Shift", "N"]);
    expect(groupKeys([])).toEqual([]);
  });

  test("the step keys mark the projects either side of the active one, going round", () => {
    const ids = ["a", "b", "c", "d"];
    expect(projectStepKey(ids, "a", "b")).toBe("project-next");
    expect(projectStepKey(ids, "a", "d")).toBe("project-prev");
    expect(projectStepKey(ids, "a", "c")).toBeUndefined();
    expect(projectStepKey(ids, "a", "a")).toBeUndefined();
    expect(projectStepKey(["a"], "a", "a")).toBeUndefined();
    expect(projectStepKey(ids, null, "a")).toBeUndefined();
  });
});

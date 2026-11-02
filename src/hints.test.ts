// bun test: when the Hold Hints clock starts, and what cancels it (src/hints.ts).

import { afterEach, describe, expect, test } from "bun:test";
import { HINT_HOLD_MS, hintChord, hintDown, hintsShown, hintUp, isHintModifier } from "./hints";

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
});

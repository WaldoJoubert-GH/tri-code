import { expect, test } from "bun:test";
import { isEnter } from "./enterkey";

test("a plain Enter is an action", () => {
  expect(isEnter({ key: "Enter", isComposing: false, keyCode: 13 })).toBe(true);
});

test("Enter confirming IME composition is not", () => {
  expect(isEnter({ key: "Enter", isComposing: true, keyCode: 229 })).toBe(false);
});

test("WebKit's confirming Enter, after compositionend, is not", () => {
  expect(isEnter({ key: "Enter", isComposing: false, keyCode: 229 })).toBe(false);
});

test("other keys are not", () => {
  expect(isEnter({ key: "a", isComposing: false, keyCode: 65 })).toBe(false);
});

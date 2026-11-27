import { expect, test } from "bun:test";
import { age, ago } from "./ago";

const now = 100 * 86_400_000;
const min = 60_000;

test("age: a chip's worth, largest whole unit", () => {
  expect(age(now, now)).toBe("now");
  expect(age(now - 59_000, now)).toBe("now");
  expect(age(now - 5 * min, now)).toBe("5m");
  expect(age(now - 3 * 60 * min - 59 * min, now)).toBe("3h");
  expect(age(now - 2 * 1440 * min, now)).toBe("2d");
});

test("ago: says ago, narrow or long", () => {
  expect(ago(now, "narrow", now)).toBe("now");
  expect(ago(now - 5 * min, "narrow", now)).toBe("5m ago");
  expect(ago(now - 90 * min, "narrow", now)).toBe("1h ago");
  expect(ago(now - 5 * min, "long", now)).toBe("5 minutes ago");
  expect(ago(now - 1440 * min, "long", now)).toBe("1 day ago");
});

test("a clock that runs behind reads as now, not the future", () => {
  expect(age(now + 5 * min, now)).toBe("now");
  expect(ago(now + 5 * min, "narrow", now)).toBe("now");
});

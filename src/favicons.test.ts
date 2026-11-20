import { expect, test } from "bun:test";
import { guessIcon, hostHue, monogram, originOf } from "./favicons";

test("a site's icon is guessed at its origin's /favicon.ico", () => {
  expect(guessIcon("https://github.com/WaldoJoubert-GH/tri-code/pull/74?x=1#y")).toBe("https://github.com/favicon.ico");
  expect(guessIcon("http://localhost:5173/src/App.tsx")).toBe("http://localhost:5173/favicon.ico");
});

test("pages that aren't http(s) have no icon to guess", () => {
  for (const url of ["", "about:blank", "file:///C:/a.html", "not a url"]) expect(guessIcon(url)).toBe("");
  expect(originOf("data:text/html,hi")).toBe("");
});

test("the letter skips www. and is empty without a host", () => {
  expect(monogram("https://www.example.com/")).toBe("E");
  expect(monogram("http://localhost:3000")).toBe("L");
  expect(monogram("about:blank")).toBe("");
});

test("two ports on one host get different colours", () => {
  expect(hostHue("http://localhost:3000")).not.toBe(hostHue("http://localhost:5173"));
  expect(hostHue("http://localhost:3000/a")).toBe(hostHue("http://localhost:3000/b"));
});

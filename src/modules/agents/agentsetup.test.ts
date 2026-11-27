// bun test: which agents the setup banner asks about (agentsetup.tsx). Asked only when an agent is
// installed here, not set up, and has no remembered answer, and not put off with Not now.

import { describe, expect, test } from "bun:test";
import { type Setup, askAbout } from "./agentsetup";

const ready = (state: "missing" | "installed" | "stale", present = true) => ({ present, state });
const setup = (over: Partial<Setup> = {}): Setup => ({ node: true, claude: ready("missing"), pi: ready("missing"), ...over });

describe("setup banner", () => {
  test("asks about each installed agent that is not set up", () => {
    expect(askAbout(setup(), {}, [])).toEqual(["claude", "pi"]);
  });

  test("an agent that is not installed here is never asked about", () => {
    expect(askAbout(setup({ pi: ready("missing", false) }), {}, [])).toEqual(["claude"]);
  });

  test("an agent already set up, or pointing at another path, is not asked about", () => {
    expect(askAbout(setup({ claude: ready("installed") }), {}, [])).toEqual(["pi"]);
    expect(askAbout(setup({ claude: ready("stale") }), {}, [])).toEqual(["pi"]);
  });

  test("a remembered answer stops the question", () => {
    expect(askAbout(setup(), { claude: "installed" }, [])).toEqual(["pi"]);
    expect(askAbout(setup(), { claude: "never", pi: "never" }, [])).toEqual([]);
  });

  test("Not now hides it for this launch only", () => {
    expect(askAbout(setup(), {}, ["pi"])).toEqual(["claude"]);
  });

  test("nothing to ask before the first check", () => {
    expect(askAbout(null, {}, [])).toEqual([]);
  });
});

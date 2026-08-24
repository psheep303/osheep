import assert from "node:assert/strict";
import test from "node:test";
import {
  hideInstalledFromLibrary,
  nextOpenGroup,
  type SkillGroup,
} from "./skills-view-behavior.js";

test("nextOpenGroup opens a group when none is open", () => {
  assert.equal(nextOpenGroup(null, "user"), "user");
});

test("nextOpenGroup switches groups so only one stays open", () => {
  assert.equal(nextOpenGroup("user", "enabled"), "enabled");
});

test("nextOpenGroup collapses the group that is clicked while open", () => {
  const open: SkillGroup = "user";
  assert.equal(nextOpenGroup(open, "user"), null);
});

test("hideInstalledFromLibrary drops skills already staged or enabled by name", () => {
  const library = [{ name: "grill-me" }, { name: "brainstorming" }, { name: "tdd" }];
  assert.deepEqual(hideInstalledFromLibrary(library, new Set(["brainstorming", "tdd"])), [
    { name: "grill-me" },
  ]);
});

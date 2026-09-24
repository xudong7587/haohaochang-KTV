import test from "node:test";
import assert from "node:assert/strict";
import { revealFocusedCard } from "../src/playback/tv-navigation.js";

test("TV card focus scrolls only when the whole card leaves the visible area", () => {
  const scroller = {
    scrollHeight: 1200,
    clientHeight: 500,
    scrollTop: 100,
    getBoundingClientRect: () => ({ top: 0, bottom: 500 }),
  };
  let bounds = { top: 180, bottom: 360 };
  const card = { getBoundingClientRect: () => bounds };
  const target = {
    closest: (selector) => (selector === "main" ? scroller : card),
  };
  revealFocusedCard(target);
  assert.equal(scroller.scrollTop, 100);
  bounds = { top: 380, bottom: 550 };
  revealFocusedCard(target);
  assert.equal(scroller.scrollTop, 158);
  bounds = { top: -50, bottom: 120 };
  revealFocusedCard(target);
  assert.equal(scroller.scrollTop, 100);
});

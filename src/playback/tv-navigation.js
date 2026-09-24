import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { handleTvBack } from "../tv-back.js";

const selector =
  "button:not(:disabled),input,a[href],select,textarea,summary,[tabindex]";
export function focusable(root) {
  return [...root.querySelectorAll(selector)].filter(
    (el) =>
      el.tabIndex >= 0 &&
      el.getClientRects().length &&
      !el.closest('[inert],[aria-hidden="true"]') &&
      getComputedStyle(el).visibility !== "hidden",
  );
}

// Prefer the same row/column before considering diagonal neighbours. A large
// hero or a missing cover must never pull focus past the next row of songs.
export function nextInDirection(active, items, key) {
  const a = active.getBoundingClientRect();
  const horizontal = key === "ArrowLeft" || key === "ArrowRight";
  const forward = key === "ArrowRight" || key === "ArrowDown" ? 1 : -1;
  let best,
    score = Infinity;
  for (const item of items) {
    if (item === active) continue;
    const b = item.getBoundingClientRect();
    const dx = b.left + b.width / 2 - a.left - a.width / 2;
    const dy = b.top + b.height / 2 - a.top - a.height / 2;
    const main = (horizontal ? dx : dy) * forward;
    if (main <= 4) continue;
    const overlap = horizontal
      ? Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
      : Math.min(a.right, b.right) - Math.max(a.left, b.left);
    const value =
      (overlap > 0 ? 0 : 100000) + main + Math.abs(horizontal ? dy : dx) * 2.5;
    if (value < score) {
      best = item;
      score = value;
    }
  }
  return best;
}

export function revealFocusedCard(target) {
  if (!target) return;
  const card = target.closest(".song-poster-card,.artist-card") || target;
  const scroller = target.closest("main");
  if (!scroller || scroller.scrollHeight <= scroller.clientHeight) {
    card.scrollIntoView({ block: "nearest" });
    return;
  }
  const visible = scroller.getBoundingClientRect();
  const bounds = card.getBoundingClientRect();
  const margin = 8;
  if (bounds.bottom > visible.bottom - margin)
    scroller.scrollTop += bounds.bottom - visible.bottom + margin;
  else if (bounds.top < visible.top + margin)
    scroller.scrollTop += bounds.top - visible.top - margin;
}

export function useTvNavigation({
  enabled,
  nested,
  tab,
  artist,
  showQR,
  authenticated,
  query,
  tag,
  setTab,
  setArtist,
  setShowQR,
  setQuery,
  setTag,
}) {
  const [entered, setEntered] = useState(false);
  const restore = useRef(null);
  const savedArtist = useRef("");
  useLayoutEffect(() => {
    if (!enabled) return;
    if (!entered) {
      if (restore.current) {
        restore.current.focus({ preventScroll: true });
        restore.current = null;
      }
      return;
    }
    const root = document.querySelector("main");
    if (
      root.contains(document.activeElement) &&
      document.activeElement !== root &&
      document.activeElement.closest(".song-poster-grid,.artist-grid")
    )
      return;
    const focus = () => {
      const candidates =
        tab === "artist-library"
          ? [...root.querySelectorAll(".song-poster-card > button")]
          : tab === "artists"
            ? [...root.querySelectorAll(".artist-card")]
            : focusable(root);
      const target =
        candidates.find((el) => el.dataset.artist === savedArtist.current) ||
        candidates[0];
      if (!target) return false;
      target.focus({ preventScroll: true });
      revealFocusedCard(target);
      return true;
    };
    // Artist songs arrive asynchronously; keep focus within the content while
    // waiting, then land on the first song instead of the browser's body.
    root.focus({ preventScroll: true });
    if (focus()) return;
    const observer = new MutationObserver(() => {
      if (focus()) observer.disconnect();
    });
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [enabled, entered, tab, artist]);

  useEffect(() => {
    if (!enabled) return;
    window.haohaochangBack = handleTvBack;
    const key = (event) => {
      if (event.defaultPrevented) return;
      document.body.classList.add("keyboard");
      const dialog = document.querySelector("dialog[open]");
      const full =
        document.querySelector(".tv-player.is-full") ||
        document.fullscreenElement;
      if (["Escape", "BrowserBack"].includes(event.key)) {
        if (!authenticated || dialog || full) return;
        if (!showQR && !artist && !query && !tag && !entered && tab === "stage")
          return;
        event.preventDefault();
        if (event.repeat) return;
        if (showQR) setShowQR(false);
        else if (entered) {
          restore.current =
            document.querySelector("nav button.selected") ||
            document.querySelector("nav button");
          setEntered(false);
        } else if (artist) {
          savedArtist.current = artist;
          setArtist("");
          setTab("artists");
        } else if (query || tag) {
          setQuery("");
          setTag("");
        } else {
          setTab("stage");
          document.querySelector("nav button")?.focus();
        }
        return;
      }
      if (
        !["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)
      )
        return;
      const active = document.activeElement;
      if (
        (["INPUT", "TEXTAREA"].includes(active?.tagName) &&
          ["ArrowLeft", "ArrowRight"].includes(event.key)) ||
        active?.tagName === "SELECT"
      )
        return;
      if (
        !full &&
        active?.matches(".video-stage") &&
        event.key === "ArrowDown"
      ) {
        const controls =
          document.querySelector(
            ".play-controls .play-toggle:not(:disabled)",
          ) || document.querySelector("[data-open-fullscreen]");
        if (controls) {
          event.preventDefault();
          controls.focus({ preventScroll: true });
          return;
        }
      }
      if (
        nested &&
        !entered &&
        !dialog &&
        !full &&
        tab !== "stage" &&
        event.key === "ArrowRight" &&
        active?.closest(".sidebar")
      ) {
        event.preventDefault();
        savedArtist.current = "";
        setEntered(true);
        return;
      }
      const root = dialog || full || document;
      const items = focusable(root).filter(
        (el) => !entered || dialog || full || !el.closest(".sidebar"),
      );
      event.preventDefault();
      const grid = active?.closest(".song-poster-grid,.artist-grid");
      const target = items.includes(active)
        ? (grid && nextInDirection(active, focusable(grid), event.key)) ||
          nextInDirection(active, items, event.key)
        : items[0];
      target?.focus({ preventScroll: true });
      revealFocusedCard(target);
    };
    const pointer = () => document.body.classList.remove("keyboard");
    document.addEventListener("keydown", key);
    document.addEventListener("pointerdown", pointer);
    return () => {
      delete window.haohaochangBack;
      document.removeEventListener("keydown", key);
      document.removeEventListener("pointerdown", pointer);
    };
  }, [
    enabled,
    nested,
    entered,
    tab,
    artist,
    showQR,
    authenticated,
    query,
    tag,
  ]);
  return {
    entered,
    onContentFocus(event) {
      if (
        nested &&
        tab !== "stage" &&
        !entered &&
        event.target !== event.currentTarget &&
        !event.target.closest("header")
      )
        setEntered(true);
    },
  };
}

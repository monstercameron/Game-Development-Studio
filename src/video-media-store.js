import { useSyncExternalStore } from 'react';

// First and last frame files chosen on the video page. They are File objects, which cannot be
// saved with a draft, so (like the reference images) they are kept here until the render is queued.
let frames = { first: null, last: null };
const listeners = new Set();
const subscribe = (listener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
export const getVideoFrames = () => frames;
export function setVideoFrame(slot, file) {
  if (slot !== 'first' && slot !== 'last') {
    return;
  }
  frames = { ...frames, [slot]: file || null };
  listeners.forEach((listener) => listener());
}
export function clearVideoFrames() {
  frames = { first: null, last: null };
  listeners.forEach((listener) => listener());
}
export const useVideoFrames = () => useSyncExternalStore(subscribe, getVideoFrames);

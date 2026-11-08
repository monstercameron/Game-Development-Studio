// Word-timing display helper for the speech-to-text panel.
const clock = (seconds) => {
  const total = Math.max(0, seconds);
  const minutes = Math.floor(total / 60);
  return `${minutes}:${(total - minutes * 60).toFixed(2).padStart(5, '0')}`;
};
// Word timings as readable lines, e.g. "0:01.36  adventurer,".
export function formatWordTimes(words) {
  return (Array.isArray(words) ? words : [])
    .filter((entry) => typeof entry?.word === 'string' && Number.isFinite(entry.start))
    .map((entry) => `${clock(entry.start)}  ${entry.word}`)
    .join('\n');
}

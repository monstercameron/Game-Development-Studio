// Windows reports a fail-fast abort (STATUS_STACK_BUFFER_OVERRUN, 0xC0000409) as exit 3221226505.
// Two of six default renders ended this way at step 7 of 8 and the same seeds passed later, right
// after another process failed to fork under memory pressure (see docs/WINDOWS_ARM64.md).
const FAIL_FAST_EXIT = /engine exit 3221226505|0xC0000409/i;

// H3 reports only "engine exit N" when a render fails. Turn the two failures whose cause Forge can
// name into an instruction; anything else keeps H3's own text.
export function failureMessage(current) {
  const reason = String(current.message || 'H3 Studio failed.');
  const details = String(current.details || '');
  if (FAIL_FAST_EXIT.test(reason) || FAIL_FAST_EXIT.test(details)) {
    return 'The video engine crashed (0xC0000409), often under memory pressure. Retry; if it repeats, offload other models and lower max GPU memory/size.';
  }
  if (
    /failed to encode MiniMax-H3 reference/.test(details) &&
    /cannot make enough memory/.test(details)
  ) {
    const advice =
      'Forge could not fit a reference clip or picture in the GPU memory budget. Raise the GPU memory budget under Fine-tune video (12 GiB was enough in testing) and retry.';
    return `${advice} H3 said: ${reason}`.slice(0, 2000);
  }
  return reason.slice(0, 2000);
}

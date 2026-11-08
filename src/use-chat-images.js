import { useCallback, useEffect, useRef, useState } from 'react';
import { checkAttachmentRoom, prepareChatImage } from './chat-images';

const VISION_REFRESH_MS = 15000;

/**
 * Pictures chosen for the next message. They live only in memory: `dataUrl` is sent once with the
 * message and is never written to browser storage.
 */
export function useChatImages() {
  const [attachments, setAttachments] = useState([]);
  const [preparing, setPreparing] = useState(false);
  const latest = useRef([]);
  latest.current = attachments;

  const addFiles = useCallback(async (files) => {
    const chosen = [...files];
    if (!chosen.length) {
      return '';
    }
    setPreparing(true);
    try {
      const prepared = [];
      for (const file of chosen) {
        prepared.push(await prepareChatImage(file));
        checkAttachmentRoom(latest.current, prepared);
      }
      setAttachments((current) => [...current, ...prepared]);
      return '';
    } catch (reason) {
      return reason.message || 'Could not attach the picture.';
    } finally {
      setPreparing(false);
    }
  }, []);
  const remove = useCallback((id) => {
    setAttachments((current) => current.filter((image) => image.id !== id));
  }, []);
  const clear = useCallback(() => setAttachments([]), []);

  return { attachments, preparing, addFiles, remove, clear };
}

/**
 * Asks the studio whether the chat server accepts pictures right now. The answer comes from the
 * running server (llama.cpp /props), refreshed while the page is open and when its status changes.
 * @returns {{ available: boolean, state: string, message: string } | null} Null until known.
 */
export function useChatVision({ provider, endpoint, serverStatus }) {
  const [vision, setVision] = useState(null);
  useEffect(() => {
    let alive = true;
    const controller = new AbortController();
    async function refresh() {
      try {
        const response = await fetch('/api/chat/vision', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Forge-Request': 'chat' },
          body: JSON.stringify({ provider, endpoint }),
          signal: controller.signal,
        });
        const data = await response.json();
        if (alive && response.ok && typeof data.available === 'boolean') {
          setVision(data);
        }
      } catch {
        // The next interval or status change tries again; the last known answer stays.
      }
    }
    refresh();
    const timer = setInterval(refresh, VISION_REFRESH_MS);
    return () => {
      alive = false;
      controller.abort();
      clearInterval(timer);
    };
  }, [provider, endpoint, serverStatus]);
  return vision;
}

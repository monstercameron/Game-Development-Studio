import { EngineOwnershipJournal } from '../../runtime/engine-ownership.js';
let held;
process.on('message', async (message) => {
  if (message.type !== 'start') {
    return;
  }
  try {
    const journal = new EngineOwnershipJournal({ directory: message.directory });
    held = await journal.acquireLock();
    void held;
    if (message.record) {
      await journal.prepare(message.record);
    }
    process.send?.({ type: 'locked' });
  } catch {
    process.send?.({ type: 'failed' });
  }
});

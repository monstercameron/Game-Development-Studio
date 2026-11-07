import { saveAsset } from '../../runtime/job-io.js';

process.once('message', async ({ root, id, url }) => {
  try {
    const output = await saveAsset(root, 'images', id, 'png', url);
    process.send?.({ output });
  } catch (error) {
    process.send?.({ error: error.message });
  }
});

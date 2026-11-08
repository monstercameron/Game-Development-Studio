import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fsyncFile } from './durable-file.js';

const maxBytes = 1024 * 1024;
function inside(root, target) {
  const relative = path.relative(root, target);
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

async function assertCurrentAsset(project, asset) {
  if (typeof asset.id !== 'string' || asset.id.includes('\\') || asset.id.includes(':')) {
    throw Error('Invalid thumbnail asset.');
  }
  const root = await fs.realpath(project.folder),
    file = path.resolve(root, ...asset.id.split('/')),
    relative = path.relative(root, file);
  if (!inside(root, file) || relative.split(path.sep).some((part) => part.startsWith('.'))) {
    throw Error('Invalid thumbnail asset.');
  }
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || !inside(root, await fs.realpath(file))) {
    throw Error('Invalid thumbnail asset.');
  }
  if (stat.size !== asset.size || stat.mtime.toISOString() !== asset.modified) {
    throw Error('Asset changed while its thumbnail was being created.');
  }
}

export function thumbnailKey(asset) {
  return createHash('sha256')
    .update(JSON.stringify([asset.id, asset.size, asset.modified]))
    .digest('hex');
}
async function cachePath(project, asset, create = false) {
  const folder = path.join(project.folder, '.forge-thumbnails');
  if (create) {
    await fs.mkdir(folder, { recursive: true });
  }
  const info = await fs.lstat(folder);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw Error('Invalid thumbnail folder.');
  }
  const root = await fs.realpath(project.folder),
    real = await fs.realpath(folder),
    rel = path.relative(root, real);
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw Error('Invalid thumbnail folder.');
  }
  return path.join(real, `${thumbnailKey(asset)}.png`);
}
export async function readThumbnail(project, asset) {
  try {
    const file = await cachePath(project, asset);
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) {
      return null;
    }
    return await fs.readFile(file);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}
export async function saveThumbnail(project, asset, input) {
  if (input.modified !== asset.modified || input.size !== asset.size) {
    throw Error('Asset changed while its thumbnail was being created.');
  }
  if (
    typeof input.image !== 'string' ||
    !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(input.image) ||
    input.image.length > maxBytes * 1.4
  ) {
    throw Error('Invalid thumbnail image.');
  }
  const image = Buffer.from(input.image.slice('data:image/png;base64,'.length), 'base64');
  if (
    image.length > maxBytes ||
    image.length < 24 ||
    !image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    image.toString('ascii', 12, 16) !== 'IHDR' ||
    image.readUInt32BE(16) > 512 ||
    image.readUInt32BE(20) > 512 ||
    !image.readUInt32BE(16) ||
    !image.readUInt32BE(20)
  ) {
    throw Error('Invalid thumbnail image.');
  }
  await assertCurrentAsset(project, asset);
  const target = await cachePath(project, asset, true),
    temp = path.join(path.dirname(target), `.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temp, image, { flag: 'wx' });
    await fsyncFile(temp);
    try {
      await fs.link(temp, target);
    } catch (error) {
      if (error.code !== 'EEXIST') {
        throw error;
      }
    }
  } finally {
    await fs.unlink(temp).catch(() => {});
  }
  return { saved: true };
}

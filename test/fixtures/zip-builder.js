// Builds small ZIP archives in memory for tests. It can also build hostile ones (path traversal,
// symbolic links, understated sizes) that real tools refuse to create.
import zlib from 'node:zlib';

/**
 * @param {{ name: string, data?: Buffer | string, method?: 'store' | 'deflate', unixMode?: number,
 * flags?: number, declaredSize?: number, crc32?: number }[]} entries
 * @param {{ comment?: string }} [options]
 */
export function buildZip(entries, { comment = '' } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.from(entry.data ?? '');
    const deflate = (entry.method ?? 'deflate') === 'deflate';
    const stored = deflate ? zlib.deflateRawSync(data) : data;
    const crc = entry.crc32 ?? zlib.crc32(data);
    const flags = (entry.flags ?? 0) | 0x800;
    const size = entry.declaredSize ?? data.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(crc >>> 0, 14);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, stored);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(((entry.unixMode ? 3 : 0) << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(deflate ? 8 : 0, 10);
    central.writeUInt32LE(crc >>> 0, 16);
    central.writeUInt32LE(stored.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((entry.unixMode ?? 0) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + stored.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  const tail = Buffer.from(comment);
  end.writeUInt16LE(tail.length, 20);
  return Buffer.concat([...locals, directory, end, tail]);
}

/** A minimal valid binary glTF (GLB) with an empty scene. */
export function tinyGlb() {
  const json = Buffer.from('{"asset":{"version":"2.0"},"scenes":[{}],"scene":0}');
  const padded = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
  const header = Buffer.alloc(20);
  header.write('glTF', 0, 'latin1');
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(20 + padded.length, 8);
  header.writeUInt32LE(padded.length, 12);
  header.write('JSON', 16, 'latin1');
  return Buffer.concat([header, padded]);
}

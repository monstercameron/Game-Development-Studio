import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  IMPORT_LIMITS,
  ImportError,
  checkModelFile,
  cleanUploadName,
  ensureFreeSpace,
  planArchive,
  runImport,
  safeSegments,
  slugify,
} from '../runtime/megascans-import.js';
import { ZipError, extractZipEntry, readZipDirectory } from '../runtime/zip-reader.js';
import { buildZip, tinyGlb } from './fixtures/zip-builder.js';

async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-megascans-import-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

async function stage(t, bytes, name = 'upload.zip') {
  const root = await temporaryDirectory(t);
  const project = path.join(root, 'project');
  const staging = path.join(
    project,
    '.forge-staging',
    'megascans',
    'abcdef12-0000-4000-8000-000000000000',
  );
  await fs.mkdir(staging, { recursive: true });
  const uploadPath = path.join(staging, name);
  await fs.writeFile(uploadPath, bytes);
  return { root, project: await fs.realpath(project), staging, uploadPath };
}

async function entriesOf(t, zip) {
  const root = await temporaryDirectory(t);
  const file = path.join(root, 'a.zip');
  await fs.writeFile(file, zip);
  return (await readZipDirectory(file)).entries;
}

async function listFiles(directory) {
  const relativePaths = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) {
      relativePaths.push(
        path.relative(directory, path.join(entry.parentPath, entry.name)).replaceAll('\\', '/'),
      );
    }
  }
  return relativePaths.sort();
}

const plyBytes = Buffer.from('ply\nformat ascii 1.0\nend_header\n');

test('safeSegments accepts relative names and rejects traversal, absolute paths and Windows hazards', () => {
  assert.deepEqual(safeSegments('rock/Textures\\albedo.png'), ['rock', 'Textures', 'albedo.png']);
  assert.deepEqual(safeSegments('./a//b.glb'), ['a', 'b.glb']);
  for (const bad of [
    '../evil.fbx',
    'a/../../evil.fbx',
    'a\\..\\..\\evil.fbx',
    '/etc/passwd',
    '\\\\server\\share\\x.fbx',
    'C:/Windows/x.fbx',
    'c:evil.fbx',
    'model.fbx:stream',
    'CON.fbx',
    'folder/aux',
    'name.',
    'bad<name>.glb',
    'tab\tname.glb',
    'a\0b.glb',
    '',
    '///',
    `${'x'.repeat(130)}.glb`,
  ]) {
    assert.throws(() => safeSegments(bad), ImportError, JSON.stringify(bad));
  }
});

test('cleanUploadName keeps the base name and enforces the extension allowlist', () => {
  assert.equal(cleanUploadName('C:\\Users\\me\\Downloads\\Rock_01.ZIP'), 'Rock_01.ZIP');
  assert.equal(cleanUploadName('a/b/scan.glb'), 'scan.glb');
  for (const bad of [
    'setup.exe',
    'scan.uasset',
    'noextension',
    'x.glb.exe',
    '',
    'CON.glb',
    'a?.glb',
  ]) {
    assert.throws(() => cleanUploadName(bad), ImportError, bad);
  }
});

test('slugify produces short Windows-safe names', () => {
  assert.equal(
    slugify('Historic Miscellaneous Stand Wood Old 05'),
    'historic-miscellaneous-stand-wood-old-05',
  );
  assert.equal(slugify('  ../..\\Évil//Name!! '), 'evil-name');
  assert.equal(slugify('***'), 'model');
  assert.ok(slugify('a'.repeat(200)).length <= 48);
});

test('the zip reader extracts stored and deflated members and checks CRC and size', async (t) => {
  const zip = buildZip([
    { name: 'rock/model.glb', data: tinyGlb(), method: 'deflate' },
    { name: 'rock/note.txt', data: 'hello', method: 'store' },
    { name: 'rock/empty.txt', data: '' },
    { name: 'rock/', data: '' },
  ]);
  const root = await temporaryDirectory(t);
  const file = path.join(root, 'a.zip');
  await fs.writeFile(file, zip);
  const { size, entries } = await readZipDirectory(file);
  assert.equal(entries.length, 4);
  for (const entry of entries.filter((item) => !item.isDirectory)) {
    const destination = path.join(root, path.basename(entry.name));
    await extractZipEntry(file, entry, destination, { archiveSize: size });
  }
  assert.deepEqual(await fs.readFile(path.join(root, 'model.glb')), tinyGlb());
  assert.equal(await fs.readFile(path.join(root, 'note.txt'), 'utf8'), 'hello');
  assert.equal((await fs.stat(path.join(root, 'empty.txt'))).size, 0);
});

test('the zip reader rejects damaged, ZIP64, multi-part and lying archives', async (t) => {
  const root = await temporaryDirectory(t);
  const write = async (name, bytes) => {
    const file = path.join(root, name);
    await fs.writeFile(file, bytes);
    return file;
  };
  await assert.rejects(readZipDirectory(await write('tiny.zip', 'PK')), ZipError);
  await assert.rejects(readZipDirectory(await write('text.zip', Buffer.alloc(100, 65))), ZipError);

  const good = buildZip([{ name: 'a.glb', data: tinyGlb() }]);
  const truncated = good.subarray(0, good.length - 10);
  await assert.rejects(readZipDirectory(await write('cut.zip', truncated)), ZipError);

  const multi = Buffer.from(good);
  multi.writeUInt16LE(1, multi.length - 22 + 4);
  await assert.rejects(readZipDirectory(await write('multi.zip', multi)), /Multi-part/);

  const zip64 = Buffer.from(good);
  zip64.writeUInt32LE(0xffffffff, zip64.length - 22 + 16);
  await assert.rejects(readZipDirectory(await write('zip64.zip', zip64)), /ZIP64/);

  // Declared size smaller than the real data: the extractor must stop, not trust the directory.
  const liar = buildZip([{ name: 'a.glb', data: tinyGlb(), declaredSize: 10 }]);
  const liarFile = await write('liar.zip', liar);
  const { size, entries } = await readZipDirectory(liarFile);
  await assert.rejects(
    extractZipEntry(liarFile, entries[0], path.join(root, 'out.glb'), { archiveSize: size }),
    /larger than the archive says/,
  );

  const badCrc = buildZip([{ name: 'a.glb', data: tinyGlb(), crc32: 12345 }]);
  const crcFile = await write('crc.zip', badCrc);
  const crc = await readZipDirectory(crcFile);
  await assert.rejects(
    extractZipEntry(crcFile, crc.entries[0], path.join(root, 'crc.glb'), { archiveSize: crc.size }),
    /integrity/,
  );
});

test('planArchive keeps models, textures and notes, skips other files and drops one wrapper folder', async (t) => {
  const entries = await entriesOf(
    t,
    buildZip([
      { name: 'Pack/rock.fbx', data: 'Kaydara FBX Binary' },
      { name: 'Pack/Textures/albedo.PNG', data: 'x' },
      { name: 'Pack/Textures/height.exr', data: 'x' },
      { name: 'Pack/info.json', data: '{}' },
      { name: 'Pack/readme.pdf', data: 'x' },
      { name: 'Pack/Textures/', data: '' },
    ]),
  );
  const plan = planArchive(entries);
  assert.equal(plan.skipped, 1);
  assert.deepEqual(plan.files.map((file) => file.segments.join('/')).sort(), [
    'Textures/albedo.PNG',
    'Textures/height.exr',
    'info.json',
    'rock.fbx',
  ]);
});

test('planArchive rejects the whole archive for hostile or unusable content', async (t) => {
  const cases = [
    [[{ name: '../evil.fbx', data: 'x' }], /outside its folder/],
    [[{ name: 'a/../../evil.fbx', data: 'x' }], /outside its folder/],
    [[{ name: '/abs/evil.fbx', data: 'x' }], /absolute path/],
    [[{ name: 'C:/evil.fbx', data: 'x' }], /absolute path/],
    [
      [
        { name: 'rock.fbx', data: 'x' },
        { name: 'installer.exe', data: 'MZ' },
      ],
      /executable or script/,
    ],
    [
      [
        { name: 'rock.fbx', data: 'x' },
        { name: 'tools/run.PS1', data: 'x' },
      ],
      /executable or script/,
    ],
    [
      [
        { name: 'rock.fbx', data: 'x' },
        { name: 'lib.dll', data: 'x' },
      ],
      /executable or script/,
    ],
    [[{ name: 'rock.fbx', data: 'x', unixMode: 0xa1ff }], /symbolic link/],
    [[{ name: 'rock.fbx', data: 'x', flags: 1 }], /Encrypted/],
    [
      [
        { name: 'Rock.fbx', data: 'x' },
        { name: 'rock.FBX', data: 'y' },
      ],
      /twice/,
    ],
    [[{ name: 'texture.png', data: 'x' }], /No supported 3D model/],
    [[{ name: 'package.uasset', data: 'x' }], /No supported 3D model/],
  ];
  for (const [files, pattern] of cases) {
    const entries = await entriesOf(t, buildZip(files));
    assert.throws(() => planArchive(entries), pattern);
  }
});

test('planArchive enforces entry count, per-file size, total size and the compression ratio', async (t) => {
  const entries = await entriesOf(
    t,
    buildZip([
      { name: 'a.glb', data: tinyGlb() },
      { name: 'b.glb', data: tinyGlb() },
    ]),
  );
  assert.throws(() => planArchive(entries, { maxEntries: 1 }), /more than 1 files/);
  assert.throws(() => planArchive(entries, { maxFileBytes: 10 }), /4 GiB/);
  assert.throws(() => planArchive(entries, { maxExpandedBytes: 100 }), /6 GiB/);
  const bomb = buildZip([{ name: 'a.glb', data: Buffer.alloc(200_000, 0) }]);
  const bombEntries = await entriesOf(t, bomb);
  assert.throws(
    () => planArchive(bombEntries, { ratioFloorBytes: 1000, maxRatio: 50 }),
    /expands far more/,
  );
  assert.ok(IMPORT_LIMITS.maxUploadBytes >= 2 * 1024 ** 3);
});

test('checkModelFile recognizes each format and rejects mismatches', async (t) => {
  const root = await temporaryDirectory(t);
  const write = async (name, bytes) => {
    const file = path.join(root, name);
    await fs.writeFile(file, bytes);
    return file;
  };
  assert.ok(await checkModelFile(await write('a.glb', tinyGlb()), '.glb'));
  assert.ok(await checkModelFile(await write('a.ply', plyBytes), '.ply'));
  assert.ok(await checkModelFile(await write('a.obj', 'v 0 0 0\n'), '.obj'));
  assert.ok(await checkModelFile(await write('a.gltf', ' {"asset":{}}'), '.gltf'));
  assert.ok(await checkModelFile(await write('a.fbx', 'Kaydara FBX Binary  \0'), '.fbx'));
  await assert.rejects(checkModelFile(await write('b.glb', 'not a glb'), '.glb'), ImportError);
  await assert.rejects(
    checkModelFile(await write('b.obj', Buffer.from([0, 1, 2, 3])), '.obj'),
    ImportError,
  );
  await assert.rejects(checkModelFile(await write('empty.glb', ''), '.glb'), /empty/);
});

test('ensureFreeSpace refuses an impossible size without touching the disk', async (t) => {
  const root = await temporaryDirectory(t);
  await assert.rejects(ensureFreeSpace(root, Number.MAX_SAFE_INTEGER), /free disk space/);
  await ensureFreeSpace(root, 1024);
});

test('runImport extracts an archive into 3d/ atomically and leaves only the staged upload', async (t) => {
  const zip = buildZip([
    { name: 'Rock_01/Rock_01.fbx', data: 'Kaydara FBX Binary  \0data' },
    { name: 'Rock_01/Textures/albedo.png', data: Buffer.alloc(2048, 7) },
    { name: 'Rock_01/Rock_01.json', data: JSON.stringify({ name: 'Mossy Rock 01' }) },
    { name: 'Rock_01/license.pdf', data: 'x' },
  ]);
  const { project, staging, uploadPath } = await stage(t, zip);
  const updates = [];
  const result = await runImport({
    id: 'abcdef12-0000-4000-8000-000000000000',
    projectFolder: project,
    uploadPath,
    stagingDirectory: staging,
    filename: 'Rock_01.zip',
    title: '',
    onProgress: (progress) => updates.push(progress),
  });
  assert.equal(result.folder, '3d/megascans-mossy-rock-01-abcdef12');
  assert.deepEqual(result.files, ['3d/megascans-mossy-rock-01-abcdef12/Rock_01.fbx']);
  assert.equal(result.skipped, 1);
  assert.equal(result.suggestedTitle, 'Mossy Rock 01');
  assert.deepEqual(await listFiles(path.join(project, '3d')), [
    'megascans-mossy-rock-01-abcdef12/Rock_01.fbx',
    'megascans-mossy-rock-01-abcdef12/Rock_01.json',
    'megascans-mossy-rock-01-abcdef12/Textures/albedo.png',
  ]);
  await assert.rejects(fs.stat(path.join(staging, 'work')));
  assert.ok((await fs.stat(uploadPath)).isFile());
  assert.ok(updates.length > 0 && updates.at(-1).bytesDone === updates.at(-1).bytesTotal);
});

test('runImport imports one model file and validates its header', async (t) => {
  const staged = await stage(t, tinyGlb(), 'upload.glb');
  const result = await runImport({
    id: 'abcdef12-0000-4000-8000-000000000000',
    projectFolder: staged.project,
    uploadPath: staged.uploadPath,
    stagingDirectory: staged.staging,
    filename: 'scan.glb',
    title: 'Old Basket',
  });
  assert.deepEqual(result.files, ['3d/old-basket-abcdef12.glb']);
  assert.deepEqual(
    await fs.readFile(path.join(staged.project, '3d', 'old-basket-abcdef12.glb')),
    tinyGlb(),
  );

  const bad = await stage(t, 'definitely not a glb', 'upload.glb');
  await assert.rejects(
    runImport({
      id: 'abcdef12-0000-4000-8000-000000000000',
      projectFolder: bad.project,
      uploadPath: bad.uploadPath,
      stagingDirectory: bad.staging,
      filename: 'scan.glb',
      title: '',
    }),
    /valid \.glb/,
  );
  assert.ok(
    (await fs.stat(bad.uploadPath)).isFile(),
    'a rejected upload stays for the user to dismiss',
  );
});

test('runImport writes nothing outside the project for a zip-slip archive', async (t) => {
  const zip = buildZip([
    { name: 'rock.fbx', data: 'Kaydara FBX Binary  \0' },
    { name: '../../escaped.txt', data: 'owned' },
  ]);
  const { root, project, staging, uploadPath } = await stage(t, zip);
  await assert.rejects(
    runImport({
      id: 'abcdef12-0000-4000-8000-000000000000',
      projectFolder: project,
      uploadPath,
      stagingDirectory: staging,
      filename: 'evil.zip',
      title: '',
    }),
    /outside its folder/,
  );
  assert.deepEqual(await listFiles(root), [
    'project/.forge-staging/megascans/abcdef12-0000-4000-8000-000000000000/upload.zip',
  ]);
});

test('runImport removes partial output when cancelled mid-extraction', async (t) => {
  const zip = buildZip(
    Array.from({ length: 5 }, (_, index) => ({
      name: `part/file${index}.png`,
      data: Buffer.alloc(4096, index),
    })).concat([{ name: 'part/model.glb', data: tinyGlb() }]),
  );
  const { project, staging, uploadPath } = await stage(t, zip);
  const controller = new AbortController();
  await assert.rejects(
    runImport({
      id: 'abcdef12-0000-4000-8000-000000000000',
      projectFolder: project,
      uploadPath,
      stagingDirectory: staging,
      filename: 'part.zip',
      title: '',
      signal: controller.signal,
      onProgress: ({ bytesDone }) => {
        if (bytesDone > 0) {
          controller.abort();
        }
      },
    }),
    (error) => error.name === 'AbortError',
  );
  assert.deepEqual(await listFiles(path.join(project, '3d')), []);
  await assert.rejects(fs.stat(path.join(staging, 'work')));
  assert.ok((await fs.stat(uploadPath)).isFile());
});

test('runImport reports damaged archives without leaking paths', async (t) => {
  const good = buildZip([{ name: 'a.glb', data: tinyGlb() }]);
  const damaged = Buffer.from(good);
  damaged.writeUInt32LE(0xdeadbeef, 0);
  const { project, staging, uploadPath } = await stage(t, damaged);
  await assert.rejects(
    runImport({
      id: 'abcdef12-0000-4000-8000-000000000000',
      projectFolder: project,
      uploadPath,
      stagingDirectory: staging,
      filename: 'broken.zip',
      title: '',
    }),
    (error) => error instanceof ImportError && !error.message.includes(project),
  );
});

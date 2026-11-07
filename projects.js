import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  stageReference,
  stageProjectAsset,
  stagePose,
  stageProjectPose,
  MAX_REFERENCE_BYTES,
} from './runtime/references.js';
import {
  readAssetMetadata,
  updateAsset,
  renameAsset,
  trashAsset,
  restoreAsset,
  listTrash,
  clearTrash,
  saveGeneratedText,
} from './project-assets.js';
import { convertAsset } from './runtime/transcode.js';
import { readThumbnail, saveThumbnail } from './runtime/thumbnails.js';

const appRoot = path.dirname(fileURLToPath(import.meta.url));
const projectsRoot = process.env.FORGE_PROJECTS_DIR || path.join(appRoot, 'projects');
const metadataFile = '.forge-project.json';
const directories = ['images', 'video', 'music', 'sfx', 'voices', 'masks', '3d', 'motion'];
const types = {
  '.txt': ['Text', 'text/plain; charset=utf-8'],
  '.json': ['Text', 'application/json; charset=utf-8'],
  '.png': ['Images', 'image/png'],
  '.jpg': ['Images', 'image/jpeg'],
  '.jpeg': ['Images', 'image/jpeg'],
  '.webp': ['Images', 'image/webp'],
  '.bmp': ['Images', 'image/bmp'],
  '.tga': ['Images', 'image/x-tga'],
  '.gif': ['Images', 'image/gif'],
  '.wav': ['Audio', 'audio/wav'],
  '.mp3': ['Audio', 'audio/mpeg'],
  '.flac': ['Audio', 'audio/flac'],
  '.ogg': ['Audio', 'audio/ogg'],
  '.opus': ['Audio', 'audio/ogg'],
  '.mp4': ['Video', 'video/mp4'],
  '.webm': ['Video', 'video/webm'],
  '.glb': ['3D', 'model/gltf-binary'],
  '.gltf': ['3D', 'model/gltf+json'],
  '.fbx': ['3D', 'application/octet-stream'],
  '.bvh': ['3D', 'application/octet-stream'],
  '.ply': ['3D', 'application/octet-stream'],
};
function json(res, data, status = 200) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(data));
}
function slug(name) {
  let value = name
    // Windows filenames cannot contain control characters.
    // eslint-disable-next-line no-control-regex -- Sanitize the full reserved character range.
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
    .slice(0, 70);
  if (!value || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)) {
    value = 'Project';
  }
  return value;
}
async function listProjects() {
  await fs.mkdir(projectsRoot, { recursive: true });
  const entries = await fs.readdir(projectsRoot, { withFileTypes: true });
  const found = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      continue;
    }
    const folder = path.join(projectsRoot, entry.name);
    try {
      const meta = JSON.parse(await fs.readFile(path.join(folder, metadataFile), 'utf8'));
      if (
        typeof meta.id !== 'string' ||
        !/^[a-f0-9-]{36}$/i.test(meta.id) ||
        typeof meta.name !== 'string'
      ) {
        continue;
      }
      const assets = [];
      let assetMetadata = {};
      try {
        assetMetadata = await readAssetMetadata(folder);
      } catch (error) {
        console.error('Asset metadata read error:', error.message);
      }
      async function walk(dir, relative = '', depth = 0) {
        if (depth > 5) {
          return;
        }
        for (const item of await fs.readdir(dir, { withFileTypes: true })) {
          if (item.name.startsWith('.') || item.isSymbolicLink()) {
            continue;
          }
          const rel = relative ? `${relative}/${item.name}` : item.name;
          const full = path.join(dir, item.name);
          if (item.isDirectory()) {
            await walk(full, rel, depth + 1);
            continue;
          }
          const spec = types[path.extname(item.name).toLowerCase()];
          if (!item.isFile() || !spec) {
            continue;
          }
          const stat = await fs.stat(full);
          assets.push({
            id: rel,
            name: item.name,
            category: rel.toLowerCase().startsWith('masks/') ? 'Masks' : spec[0],
            type: spec[1],
            size: stat.size,
            modified: stat.mtime.toISOString(),
            url: `/api/projects/${meta.id}/asset?path=${encodeURIComponent(rel)}`,
          });
        }
      }
      await walk(folder);
      for (const asset of assets) {
        asset.kept = assetMetadata[asset.id]?.kept === true;
        asset.rating = Number.isInteger(assetMetadata[asset.id]?.rating)
          ? assetMetadata[asset.id].rating
          : null;
        asset.sourceOutput =
          typeof assetMetadata[asset.id]?.sourceOutput === 'string'
            ? assetMetadata[asset.id].sourceOutput
            : null;
      }
      assets.sort((a, b) => b.modified.localeCompare(a.modified));
      found.push({ ...meta, folder, assets, updatedAt: assets[0]?.modified || meta.createdAt });
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) {
        console.error('Project read error:', error.message);
      }
    }
  }
  return found.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
export function projectsService() {
  function attach(server) {
    server.middlewares.use('/api/projects', async (req, res) => {
      try {
        const url = new URL(req.url, 'http://127.0.0.1');
        if ((url.pathname === '/' || url.pathname === '') && req.method === 'GET') {
          return json(res, { root: projectsRoot, projects: await listProjects() });
        }
        if ((url.pathname === '/' || url.pathname === '') && req.method === 'POST') {
          const host = req.headers.host;
          if (
            !/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host || '') ||
            req.headers.origin !== `http://${host}` ||
            req.headers['x-forge-request'] !== 'project'
          ) {
            return json(res, { error: 'Local studio requests only.' }, 403);
          }
          let body = '';
          for await (const chunk of req) {
            body += chunk;
            if (body.length > 10000) {
              return json(res, { error: 'Request too large.' }, 413);
            }
          }
          let input;
          try {
            input = JSON.parse(body);
          } catch {
            return json(res, { error: 'Invalid request.' }, 400);
          }
          if (!input || typeof input !== 'object' || Array.isArray(input)) {
            return json(res, { error: 'Invalid request.' }, 400);
          }
          const name = typeof input.name === 'string' ? input.name.trim() : '';
          if (!name || name.length > 80) {
            return json(res, { error: 'Enter a project name of up to 80 characters.' }, 400);
          }
          await fs.mkdir(projectsRoot, { recursive: true });
          const base = slug(name);
          let folder;
          for (let n = 1; n < 10000; n++) {
            const candidate = path.join(projectsRoot, n === 1 ? base : `${base} (${n})`);
            try {
              await fs.mkdir(candidate);
              folder = candidate;
              break;
            } catch (e) {
              if (e.code !== 'EEXIST') {
                throw e;
              }
            }
          }
          if (!folder) {
            throw Error('Could not find an available project folder.');
          }
          const project = { id: randomUUID(), name, createdAt: new Date().toISOString() };
          await fs.writeFile(path.join(folder, metadataFile), JSON.stringify(project, null, 2), {
            flag: 'wx',
          });
          await Promise.all(directories.map((dir) => fs.mkdir(path.join(folder, dir))));
          return json(
            res,
            { project: { ...project, folder, assets: [], updatedAt: project.createdAt } },
            201,
          );
        }
        const textAsset = /^\/([a-f0-9-]{36})\/assets\/create-text$/i.exec(url.pathname);
        if (textAsset && req.method === 'POST') {
          const host = req.headers.host;
          if (
            !/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host || '') ||
            req.headers.origin !== `http://${host}` ||
            req.headers['x-forge-request'] !== 'project'
          ) {
            return json(res, { error: 'Local studio requests only.' }, 403);
          }
          const project = (await listProjects()).find((item) => item.id === textAsset[1]);
          if (!project) {
            return json(res, { error: 'Project not found.' }, 404);
          }
          const chunks = [];
          let size = 0;
          for await (const chunk of req) {
            size += chunk.length;
            if (size > 500000) {
              return json(res, { error: 'Text asset is too large.' }, 413);
            }
            chunks.push(chunk);
          }
          try {
            return json(
              res,
              await saveGeneratedText(project, JSON.parse(Buffer.concat(chunks).toString('utf8'))),
              201,
            );
          } catch (error) {
            return json(res, { error: error.message || 'Could not save text.' }, 400);
          }
        }
        const assetAction =
          /^\/([a-f0-9-]{36})\/assets\/(metadata|rename|trash|restore|clear-trash|convert)$/i.exec(
            url.pathname,
          );
        if (assetAction && assetAction[2] === 'trash' && req.method === 'GET') {
          const project = (await listProjects()).find((item) => item.id === assetAction[1]);
          if (!project) {
            return json(res, { error: 'Project not found.' }, 404);
          }
          try {
            return json(res, await listTrash(project));
          } catch (error) {
            return json(res, { error: error.message }, 400);
          }
        }
        if (assetAction && req.method === 'POST') {
          const host = req.headers.host;
          if (
            !/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host || '') ||
            req.headers.origin !== `http://${host}` ||
            req.headers['x-forge-request'] !== 'project'
          ) {
            return json(res, { error: 'Local studio requests only.' }, 403);
          }
          const project = (await listProjects()).find((item) => item.id === assetAction[1]);
          if (!project) {
            return json(res, { error: 'Project not found.' }, 404);
          }
          let body = '';
          for await (const chunk of req) {
            body += chunk;
            if (body.length > 10000) {
              return json(res, { error: 'Request too large.' }, 413);
            }
          }
          try {
            const input = JSON.parse(body);
            const result =
              assetAction[2] === 'metadata'
                ? await updateAsset(project, input.path, input)
                : assetAction[2] === 'rename'
                  ? await renameAsset(project, input.path, input.name)
                  : assetAction[2] === 'trash'
                    ? await trashAsset(project, input.path)
                    : assetAction[2] === 'clear-trash'
                      ? await clearTrash(project, input.confirmation)
                      : assetAction[2] === 'convert'
                        ? await convertAsset(project, input)
                        : await restoreAsset(project, input.trashId);
            return json(res, result);
          } catch (error) {
            return json(res, { error: error.message || 'Could not update asset.' }, 400);
          }
        }
        const thumbMatch = /^\/([a-f0-9-]{36})\/thumbnail$/i.exec(url.pathname);
        if (thumbMatch && (req.method === 'GET' || req.method === 'POST')) {
          if (req.method === 'POST') {
            const host = req.headers.host;
            if (
              !/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host || '') ||
              req.headers.origin !== `http://${host}` ||
              req.headers['x-forge-request'] !== 'project'
            ) {
              return json(res, { error: 'Local studio requests only.' }, 403);
            }
          }
          const project = (await listProjects()).find((item) => item.id === thumbMatch[1]);
          if (!project) {
            return json(res, { error: 'Project not found.' }, 404);
          }
          const asset = project.assets.find((item) => item.id === url.searchParams.get('path'));
          if (!asset || !['Images', 'Masks', 'Video', '3D'].includes(asset.category)) {
            return json(res, { error: 'Visual asset not found.' }, 404);
          }
          if (req.method === 'GET') {
            const image = await readThumbnail(project, asset);
            if (!image) {
              return json(res, { error: 'Thumbnail not available yet.' }, 404);
            }
            res.writeHead(200, {
              'Content-Type': 'image/png',
              'Content-Length': image.length,
              'Cache-Control': 'private, max-age=31536000, immutable',
              'X-Content-Type-Options': 'nosniff',
            });
            return res.end(image);
          }
          let body = '';
          for await (const chunk of req) {
            body += chunk;
            if (body.length > 1500000) {
              return json(res, { error: 'Thumbnail is too large.' }, 413);
            }
          }
          try {
            return json(res, await saveThumbnail(project, asset, JSON.parse(body)), 201);
          } catch (error) {
            return json(res, { error: error.message || 'Could not save thumbnail.' }, 400);
          }
        }
        const referenceMatch = /^\/([a-f0-9-]{36})\/(references|poses)(?:\/(from-asset))?$/i.exec(
          url.pathname,
        );
        if (referenceMatch && req.method === 'POST') {
          const host = req.headers.host;
          if (
            !/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host || '') ||
            req.headers.origin !== `http://${host}` ||
            req.headers['x-forge-request'] !== 'project'
          ) {
            return json(res, { error: 'Local studio requests only.' }, 403);
          }
          const project = (await listProjects()).find((item) => item.id === referenceMatch[1]);
          if (!project) {
            return json(res, { error: 'Project not found.' }, 404);
          }
          const limit = referenceMatch[3] ? 10000 : MAX_REFERENCE_BYTES;
          if (Number(req.headers['content-length']) > limit) {
            return json(res, { error: 'Reference is too large.' }, 413);
          }
          const chunks = [];
          let size = 0;
          for await (const chunk of req) {
            size += chunk.length;
            if (size > limit) {
              return json(res, { error: 'Reference is too large.' }, 413);
            }
            chunks.push(chunk);
          }
          try {
            const bytes = Buffer.concat(chunks),
              pose = referenceMatch[2].toLowerCase() === 'poses',
              reference = referenceMatch[3]
                ? pose
                  ? await stageProjectPose(project.folder, JSON.parse(bytes.toString('utf8')).path)
                  : await stageProjectAsset(project.folder, JSON.parse(bytes.toString('utf8')).path)
                : pose
                  ? await stagePose(project.folder, bytes)
                  : await stageReference(project.folder, bytes);
            return json(res, { reference }, 201);
          } catch (error) {
            return json(res, { error: `Could not stage reference: ${error.message}` }, 400);
          }
        }
        const match = /^\/([a-f0-9-]{36})\/asset$/i.exec(url.pathname);
        if (match && req.method === 'GET') {
          const project = (await listProjects()).find((item) => item.id === match[1]);
          if (!project) {
            return json(res, { error: 'Project not found.' }, 404);
          }
          const rel = url.searchParams.get('path');
          const asset = project.assets.find((item) => item.id === rel);
          if (!asset) {
            return json(res, { error: 'Asset not found.' }, 404);
          }
          const full = path.resolve(project.folder, ...rel.split('/'));
          const real = await fs.realpath(full);
          const folderReal = await fs.realpath(project.folder);
          if (
            path.relative(folderReal, real).startsWith('..') ||
            path.isAbsolute(path.relative(folderReal, real))
          ) {
            return json(res, { error: 'Asset not found.' }, 404);
          }
          const stat = await fs.stat(real);
          let start = 0,
            end = stat.size - 1;
          const range = req.headers.range;
          if (range) {
            const m = /^bytes=(\d*)-(\d*)$/.exec(range);
            if (!m || (!m[1] && !m[2])) {
              res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
              return res.end();
            }
            if (!m[1]) {
              const suffix = Number(m[2]);
              if (!Number.isSafeInteger(suffix) || suffix <= 0) {
                res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
                return res.end();
              }
              start = Math.max(0, stat.size - suffix);
            } else {
              start = Number(m[1]);
              if (m[2]) {
                end = Math.min(end, Number(m[2]));
              }
            }
            if (
              !Number.isSafeInteger(start) ||
              !Number.isSafeInteger(end) ||
              start > end ||
              start >= stat.size
            ) {
              res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
              return res.end();
            }
          }
          const headers = {
            'Content-Type': asset.type,
            'Content-Length': end - start + 1,
            'Accept-Ranges': 'bytes',
            'X-Content-Type-Options': 'nosniff',
          };
          if (range) {
            headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
          }
          res.writeHead(range ? 206 : 200, headers);
          createReadStream(real, { start, end })
            .on('error', () => res.destroy())
            .pipe(res);
          return;
        }
        return json(res, { error: 'Not found.' }, 404);
      } catch (error) {
        console.error('Project service error:', error.message);
        return json(res, { error: 'Project service failed. Check Diagnostics.' }, 500);
      }
    });
  }
  return { name: 'forge-projects', configureServer: attach, configurePreviewServer: attach };
}

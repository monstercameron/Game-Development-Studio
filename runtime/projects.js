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
} from './references.js';
import { stageProjectClip } from './clips.js';
import { atomicWriteFile } from './durable-file.js';
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
import { convertAsset } from './transcode.js';
import { readGlbStats } from './glb-stats.js';
import { readThumbnail, saveThumbnail } from './thumbnails.js';
import {
  backfillAssetMeta,
  readAssetMeta,
  readMetaIndex,
  searchAssetMeta,
} from './asset-metadata.js';
import { createLogger } from './app-log.js';

const log = createLogger('projects');
// This file lives in runtime/; the repository root is its parent folder.
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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
  '.obj': ['3D', 'text/plain; charset=utf-8'],
  '.stl': ['3D', 'model/stl'],
  // The material file written beside a converted OBJ.
  '.mtl': ['Text', 'text/plain; charset=utf-8'],
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
        log.warn('projects.metadata.read.failed', {
          errorClass: error?.name,
          errorCode: error?.code,
        });
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
        log.warn('projects.project.read.failed', {
          errorClass: error?.name,
          errorCode: error?.code,
        });
        console.error('Project read error:', error.message);
      } else {
        log.debug('projects.project.skipped', {
          errorClass: error?.name,
          errorCode: error?.code,
        });
      }
    }
  }
  return found.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
// Runs one asset mutation for POST /api/projects/:id/assets/:action. The route regex is
// case-insensitive, but the switch compares exact names, so any other spelling falls through to
// restore. Keep it that way: normalising the case here would change behaviour.
async function runAssetAction(action, project, input) {
  switch (action) {
    case 'metadata':
      return updateAsset(project, input.path, input);
    case 'rename':
      return renameAsset(project, input.path, input.name);
    case 'trash':
      return trashAsset(project, input.path);
    case 'clear-trash':
      return clearTrash(project, input.confirmation);
    case 'trash-all': {
      if (input.confirmation !== project.name) {
        throw Error('Type the exact project name to confirm.');
      }
      const failures = [];
      let moved = 0;
      for (const asset of project.assets) {
        try {
          await trashAsset(project, asset.id);
          moved += 1;
        } catch (error) {
          log.warn('projects.assets.batch.failed', {
            projectId: project.id,
            errorClass: error?.name,
          });
          failures.push({ path: asset.id, error: error.message || 'Could not move this asset.' });
        }
      }
      log.info('projects.assets.batch.trashed', {
        projectId: project.id,
        count: moved,
        failedCount: failures.length,
      });
      return { moved, failures };
    }
    case 'convert':
      return convertAsset(project, input);
    default:
      return restoreAsset(project, input.trashId);
  }
}

// Stages one reference, pose or clip for a request. kind is 'references', 'poses' or 'clips'.
// fromAsset means bytes is JSON that names a project asset instead of an uploaded file.
async function stageRequestReference(folder, kind, fromAsset, bytes) {
  if (kind === 'clips') {
    return stageProjectClip(folder, JSON.parse(bytes.toString('utf8')).path);
  }
  const isPose = kind === 'poses';
  if (fromAsset) {
    const assetPath = JSON.parse(bytes.toString('utf8')).path;
    return isPose ? stageProjectPose(folder, assetPath) : stageProjectAsset(folder, assetPath);
  }
  return isPose ? stagePose(folder, bytes) : stageReference(folder, bytes);
}

/**
 * Returns the /api/projects service. It is mounted by both vite.config.js and
 * runtime/http-server.js, so a change to its routes applies to the dev and production hosts.
 */
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
            log.warn('projects.request.rejected', {
              route: '/api/projects',
              reason: 'not_local',
            });
            return json(res, { error: 'Local studio requests only.' }, 403);
          }
          let body = '';
          for await (const chunk of req) {
            body += chunk;
            if (body.length > 10000) {
              log.warn('projects.request.rejected', {
                route: '/api/projects',
                reason: 'too_large',
              });
              return json(res, { error: 'Request too large.' }, 413);
            }
          }
          let input;
          try {
            input = JSON.parse(body);
          } catch (error) {
            log.warn('projects.request.rejected', {
              route: '/api/projects',
              reason: 'invalid_json',
              errorClass: error?.name,
            });
            return json(res, { error: 'Invalid request.' }, 400);
          }
          if (!input || typeof input !== 'object' || Array.isArray(input)) {
            log.warn('projects.request.rejected', {
              route: '/api/projects',
              reason: 'wrong_type',
            });
            return json(res, { error: 'Invalid request.' }, 400);
          }
          const name = typeof input.name === 'string' ? input.name.trim() : '';
          if (!name || name.length > 80) {
            log.warn('projects.request.rejected', {
              route: '/api/projects',
              reason: 'invalid_name',
            });
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
          // Staged and flushed: a half-written project file would hide the project from the list.
          await atomicWriteFile(path.join(folder, metadataFile), JSON.stringify(project, null, 2));
          await Promise.all(directories.map((dir) => fs.mkdir(path.join(folder, dir))));
          log.info('projects.project.created', { projectId: project.id });
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
            log.warn('projects.request.rejected', {
              route: '/api/projects/:id/assets/create-text',
              reason: 'not_local',
            });
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
              log.warn('projects.request.rejected', {
                route: '/api/projects/:id/assets/create-text',
                reason: 'too_large',
              });
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
            log.warn('projects.request.failed', {
              route: '/api/projects/:id/assets/create-text',
              errorClass: error?.name,
              errorCode: error?.code,
            });
            return json(res, { error: error.message || 'Could not save text.' }, 400);
          }
        }
        // Generation details (model, prompt, settings) live in the project's own SQLite file.
        // Older assets are filled in lazily from the job queue history on first read.
        const details = /^\/([a-f0-9-]{36})\/assets\/(details|details-index|search)$/i.exec(
          url.pathname,
        );
        if (details && req.method === 'GET') {
          const project = (await listProjects()).find((item) => item.id === details[1]);
          if (!project) {
            return json(res, { error: 'Project not found.' }, 404);
          }
          const action = details[2].toLowerCase();
          try {
            if (action === 'search') {
              const query = (url.searchParams.get('q') || '').slice(0, 200);
              return json(res, { paths: searchAssetMeta(project.folder, query) });
            }
            backfillAssetMeta(project.folder, project.id, project.assets);
            if (action === 'details-index') {
              return json(res, { assets: readMetaIndex(project.folder) });
            }
            const rel = url.searchParams.get('path');
            if (!project.assets.some((item) => item.id === rel)) {
              return json(res, { error: 'Asset not found.' }, 404);
            }
            const metadata = readAssetMeta(project.folder, rel);
            // A GLB's size and triangle count are read from the file, so older files have them too.
            const output = /\.glb$/i.test(rel)
              ? readGlbStats(path.join(project.folder, ...rel.split('/')))
              : null;
            return json(res, { metadata: metadata && output ? { ...metadata, output } : metadata });
          } catch (error) {
            log.warn('projects.request.failed', {
              route: '/api/projects/:id/assets/:action',
              errorClass: error?.name,
              errorCode: error?.code,
            });
            console.error('Asset details error:', error.message);
            return json(
              res,
              action === 'search'
                ? { paths: [], unavailable: true }
                : action === 'details-index'
                  ? { assets: {}, unavailable: true }
                  : { metadata: null, unavailable: true },
            );
          }
        }
        const assetAction =
          /^\/([a-f0-9-]{36})\/assets\/(metadata|rename|trash|trash-all|restore|clear-trash|convert)$/i.exec(
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
            log.warn('projects.request.failed', {
              route: '/api/projects/:id/assets/trash',
              errorClass: error?.name,
              errorCode: error?.code,
            });
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
            log.warn('projects.request.rejected', {
              route: '/api/projects/:id/assets/:action',
              reason: 'not_local',
            });
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
              log.warn('projects.request.rejected', {
                route: '/api/projects/:id/assets/:action',
                reason: 'too_large',
              });
              return json(res, { error: 'Request too large.' }, 413);
            }
          }
          try {
            const input = JSON.parse(body);
            const result = await runAssetAction(assetAction[2], project, input);
            return json(res, result);
          } catch (error) {
            log.warn('projects.request.failed', {
              route: '/api/projects/:id/assets/:action',
              action: assetAction[2],
              errorClass: error?.name,
              errorCode: error?.code,
            });
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
              log.warn('projects.request.rejected', {
                route: '/api/projects/:id/thumbnail',
                reason: 'not_local',
              });
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
              log.warn('projects.request.rejected', {
                route: '/api/projects/:id/thumbnail',
                reason: 'too_large',
              });
              return json(res, { error: 'Thumbnail is too large.' }, 413);
            }
          }
          try {
            return json(res, await saveThumbnail(project, asset, JSON.parse(body)), 201);
          } catch (error) {
            log.warn('projects.request.failed', {
              route: '/api/projects/:id/thumbnail',
              errorClass: error?.name,
              errorCode: error?.code,
            });
            return json(res, { error: error.message || 'Could not save thumbnail.' }, 400);
          }
        }
        const referenceMatch =
          /^\/([a-f0-9-]{36})\/(references|poses|clips)(?:\/(from-asset))?$/i.exec(url.pathname);
        if (referenceMatch && req.method === 'POST') {
          const host = req.headers.host;
          if (
            !/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host || '') ||
            req.headers.origin !== `http://${host}` ||
            req.headers['x-forge-request'] !== 'project'
          ) {
            log.warn('projects.request.rejected', {
              route: '/api/projects/:id/:kind',
              reason: 'not_local',
            });
            return json(res, { error: 'Local studio requests only.' }, 403);
          }
          const project = (await listProjects()).find((item) => item.id === referenceMatch[1]);
          if (!project) {
            return json(res, { error: 'Project not found.' }, 404);
          }
          // Reference videos and audio are chosen from the project's own assets, never uploaded.
          if (referenceMatch[2].toLowerCase() === 'clips' && !referenceMatch[3]) {
            return json(res, { error: 'Choose a clip from the project assets.' }, 400);
          }
          const limit = referenceMatch[3] ? 10000 : MAX_REFERENCE_BYTES;
          if (Number(req.headers['content-length']) > limit) {
            log.warn('projects.request.rejected', {
              route: '/api/projects/:id/:kind',
              reason: 'too_large',
            });
            return json(res, { error: 'Reference is too large.' }, 413);
          }
          const chunks = [];
          let size = 0;
          for await (const chunk of req) {
            size += chunk.length;
            if (size > limit) {
              log.warn('projects.request.rejected', {
                route: '/api/projects/:id/:kind',
                reason: 'too_large',
              });
              return json(res, { error: 'Reference is too large.' }, 413);
            }
            chunks.push(chunk);
          }
          try {
            const bytes = Buffer.concat(chunks);
            const reference = await stageRequestReference(
              project.folder,
              referenceMatch[2].toLowerCase(),
              Boolean(referenceMatch[3]),
              bytes,
            );
            return json(res, { reference }, 201);
          } catch (error) {
            log.warn('projects.request.failed', {
              route: '/api/projects/:id/:kind',
              errorClass: error?.name,
              errorCode: error?.code,
            });
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
            log.warn('projects.request.rejected', {
              route: '/api/projects/:id/asset',
              reason: 'traversal',
            });
            return json(res, { error: 'Asset not found.' }, 404);
          }
          const stat = await fs.stat(real);
          let start = 0;
          let end = stat.size - 1;
          const range = req.headers.range;
          if (range) {
            const rangeMatch = /^bytes=(\d*)-(\d*)$/.exec(range);
            if (!rangeMatch || (!rangeMatch[1] && !rangeMatch[2])) {
              res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
              return res.end();
            }
            if (!rangeMatch[1]) {
              const suffix = Number(rangeMatch[2]);
              if (!Number.isSafeInteger(suffix) || suffix <= 0) {
                res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
                return res.end();
              }
              start = Math.max(0, stat.size - suffix);
            } else {
              start = Number(rangeMatch[1]);
              if (rangeMatch[2]) {
                end = Math.min(end, Number(rangeMatch[2]));
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
        log.error('projects.request.failed', {
          errorClass: error?.name,
          errorCode: error?.code,
        });
        console.error('Project service error:', error.message);
        return json(res, { error: 'Project service failed. Check Diagnostics.' }, 500);
      }
    });
  }
  return { name: 'forge-projects', configureServer: attach, configurePreviewServer: attach };
}

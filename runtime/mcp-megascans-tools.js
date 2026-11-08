// MCP tools for the Megascans cache, library and import queue. They only call Forge's own
// loopback routes; the studio decides if and when Fab is asked, slowly (see docs/MEGASCANS.md).
import { z } from 'zod';

const listingId = z.string().uuid().describe('The Fab listing id (a UUID).');
const projectId = z.string().uuid().describe('The Forge project id.');

export function registerMegascansTools(server, { read, write, readonly }) {
  server.registerTool(
    'forge_megascans_search',
    {
      description:
        'Search the local cache of free Quixel Megascans 3D models read from Fab (plus listings the user saved by hand). Text search covers title, tags, category and notes. Returns a page of listings with Fab address, licence, formats, file-size range and attribution text, and the tags in use. This call fetches nothing from Fab. If the cache is empty or old, call forge_megascans_refresh or ask the user to run the catalog scan.',
      inputSchema: {
        query: z.string().max(200).optional().describe('Words to match in title, tags and notes.'),
        tag: z.string().max(30).optional().describe('Only listings with this exact tag.'),
        sort: z.enum(['newest', 'title', 'recent']).default('newest'),
        page: z.number().int().min(1).max(10000).default(1),
        pageSize: z.number().int().min(1).max(60).default(24),
      },
      annotations: readonly,
    },
    ({ query, tag, sort, page, pageSize }) => {
      const params = new URLSearchParams({ sort, page: String(page), pageSize: String(pageSize) });
      if (query) {
        params.set('q', query);
      }
      if (tag) {
        params.set('tag', tag);
      }
      return read(`/api/megascans/listings?${params}`);
    },
  );

  server.registerTool(
    'forge_megascans_refresh',
    {
      description:
        "Read page one of Fab's newest free Megascans 3D models into the local cache (one slow request; at most once a minute). Returns how many listings were added and updated and the cache state, including whether Fab is blocking automated requests. If Fab blocks Forge, stop and tell the user; do not retry. Pass id instead to read one listing's description and file list.",
      inputSchema: {
        id: listingId.optional().describe('Read this listing in detail instead of a page.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    ({ id }) =>
      id
        ? write(`/api/megascans/listings/${id}/refresh`, {}, 60000, 'megascans')
        : write('/api/megascans/refresh', {}, 60000, 'megascans'),
  );

  server.registerTool(
    'forge_megascans_scan',
    {
      description:
        'Control the background catalog scan that fills the cache with free Megascans 3D models, a page at a time (slow, capped at about 10 pages per run, resumable). action=status reports progress; start begins a new scan; resume continues from where the last run stopped; cancel stops it. A scan stops by itself if Fab blocks Forge.',
      inputSchema: { action: z.enum(['status', 'start', 'resume', 'cancel']) },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    ({ action }) =>
      action === 'status'
        ? read('/api/megascans/scan')
        : write('/api/megascans/scan', { action }, 10000, 'megascans'),
  );

  server.registerTool(
    'forge_megascans_listing',
    {
      description:
        'Return one Megascans listing from the local cache (Fab address, licence, seller, attribution text, tags, notes, and details when they were read) and the files imported from it.',
      inputSchema: { id: listingId },
      annotations: readonly,
    },
    ({ id }) => read(`/api/megascans/listings/${id}`),
  );

  server.registerTool(
    'forge_megascans_add_listing',
    {
      description:
        'Save a reference to a Fab listing in the local library, or add notes and tags to a cached one. Pass the listing address the user gave you (https://www.fab.com/listings/<id>) and a title. Only the id is read from the address. This does not download or import anything: the user downloads the model from Fab themselves and imports the file on the Megascans page.',
      inputSchema: {
        url: z.string().max(500),
        title: z.string().min(1).max(120),
        tags: z.array(z.string().max(30)).max(12).default([]),
        notes: z.string().max(2000).default(''),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    (input) => write('/api/megascans/listings', input, 10000, 'megascans'),
  );

  server.registerTool(
    'forge_megascans_download',
    {
      description:
        "Queue a download of one file of a cached Megascans listing into a project (the file is fetched from Fab's delivery network, saved in the project's 3d folder with its source and licence recorded, and queued behind at most 2 simultaneous transfers). Choose the file by fileUid (listed in forge_megascans_listing under detail.groups) or by format (glb, gltf, fbx) and quality (low, mid, high, raw); the recommended default is glb at mid quality. This is refused until the USER has ticked the Fab license-agreement confirmation on the Megascans page; never try to confirm it for them. Files over 100 MB need confirmLarge=true: only set it after the user agreed to that size. Returns the queue entry; poll forge_megascans_downloads. If Fab blocks Forge, stop and tell the user.",
      inputSchema: {
        projectId,
        listingId,
        fileUid: z.string().uuid().optional(),
        format: z.enum(['glb', 'gltf', 'fbx', 'ue']).optional(),
        quality: z.enum(['low', 'mid', 'high', 'raw']).optional(),
        confirmLarge: z.boolean().default(false),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (input) =>
      write(
        '/api/megascans/downloads',
        {
          project: input.projectId,
          listing: input.listingId,
          fileUid: input.fileUid,
          format: input.format,
          quality: input.quality,
          confirmLarge: input.confirmLarge,
        },
        120000,
        'megascans',
      ),
  );

  server.registerTool(
    'forge_megascans_downloads',
    {
      description:
        'Show the Megascans downloads and imports queue, with status (queued, running, completed, failed, cancelled, interrupted), progress bytes, speed and estimated seconds remaining, the saved project paths, and any error. At most 2 imports run at once. Pass an id to see one import. It lists both downloads Forge made from Fab (source `fab`) and files the user imported themselves (source `upload`).',
      inputSchema: { id: z.string().uuid().optional() },
      annotations: readonly,
    },
    ({ id }) => read(id ? `/api/megascans/imports/${id}` : '/api/megascans/imports'),
  );
}

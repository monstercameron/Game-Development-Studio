# Megascans portal (Fab)

The **Megascans** page lists the free Quixel Megascans 3D models that [Fab](https://www.fab.com/sellers/Quixel%20Megascans)
offers, keeps what it reads in a local cache so you can search it offline, downloads the files you
choose into a project (or imports files you downloaded yourself), and records their source, licence
and attribution.

* **Automated:** reading Fab's public listing data (slowly, cached), thumbnails, a resumable catalog
  scan, **downloading a file you choose** (after you confirm Fab's license agreement once), safe
  import of any file (downloaded or your own), a durable queue (2 transfers at a time), provenance in
  the asset details.
* **Manual:** the one-time license confirmation (a checkbox only you can tick), choosing which file
  to download, and, if you prefer, downloading on Fab yourself and importing the file.

Read [Studio guide: Megascans](STUDIO_GUIDE.md#megascans) for the steps. This document records the
research, the decision and the limits.

## Feasibility research (checked 2026-11-08)

Research used the in-app browser as an anonymous, signed-out visitor, plus `curl` with the User-Agent
`Forge-Studio/0.1.0`. No account, cookie, token or credential was used or stored.

### Endpoints the Fab website itself calls for a signed-out visitor

| Purpose | Request | Notes |
| --- | --- | --- |
| Seller listings | `GET https://www.fab.com/i/listings/search?seller=Quixel+Megascans&listing_types=3d-model&is_free=1&sort_by=-firstPublishedAt&count=24[&cursor=<token>]` | JSON `{ results[], cursors: { next }, next, previous, aggregations }`. Paged by an opaque `cursor` (`cursors.next`), not by page number. `count` is honored. The `q` parameter is **ignored** when filtered by seller (checked live: the same results with and without it), so Forge searches its own cache instead. `is_free=1` is the website's "Only show free products" filter; Forge still keeps only results with `startingPrice.price === 0`, seller `Quixel Megascans` and type `3d-model`. |
| One listing | `GET https://www.fab.com/i/listings/<uid>` | JSON with `description` (HTML), `licenses[]` (group `standard`), `assetFormats[]`, `tags`, `thumbnails`, `firstPublishedAt`. |
| Files of one format | `GET https://www.fab.com/i/listings/<uid>/asset-formats/<code>` | JSON `files[]` with `name`, `size` (bytes), `faceCount`, `vertexCount`, `status`, plus `techDetails.threeDModel` (texture count and resolution range, triangle range). The file entries have a `uid` (used for `download-info` below) but no download address. |
| Thumbnails | `GET https://media.fab.com/image_previews/gallery_images/<preview>/<variant>` | JPEG, about 50 to 120 KB. The search result lists variants (for example 144x81, 160x90, 320x180); Forge uses the widest. |
| All files of a listing | `GET https://www.fab.com/i/listings/<uid>/asset-formats` | JSON array `[{ assetFormatType: { code, extensions, name }, files: [{ uid, name, fileSize, ... }] }]`. Codes seen: `fbx` (zips `_raw/_high/_mid/_low`), `converted-files` (`.glb`, `_gltf_<q>.zip`, `.usdz`), `gltf` (`_ue_<q>.zip`, Unreal-oriented glTF), `additional-files` (an EXR texture zip of about 1.9 GB). |
| Signed download address | `GET https://www.fab.com/i/listings/<uid>/asset-formats/<code>/files/<fileUid>/download-info` | `{ downloadInfo: [{ assetFormat, downloadUrl, expires, type: "binary" }] }` for a signed-out visitor, no cookie. `downloadUrl` is an HTTPS address on Epic's delivery network (`*.epicgames.com` or `*.epicgamescdn.com`, host varies) with a `cf_token` or `f_token`; it **expires in about five minutes**. |
| The file | `GET <downloadUrl>` | Plain GET, no cookies; the server honors `Range` requests (Forge checks the answer rather than assuming). |
| Licence taxonomy | `GET https://www.fab.com/i/taxonomy/licenses` | "Standard License" links to `/eula`; "CC-BY" to `https://creativecommons.org/licenses/by/4.0/`. Forge uses this mapping without calling the endpoint. |
| Listing page | `https://www.fab.com/listings/<uid>` | HTML with a schema.org `Product` block. Not used by Forge. |

Result fields Forge keeps (search): `uid`, `title`, category, tags, asset formats with file-size ranges
(`fileSizesRange`), thumbnail address, `firstPublishedAt`, price, licence group. Detail adds
description, licence group and the file list with face and vertex counts, texture count and maximum
resolution, triangle range. A free Megascans listing such as "Historic Miscellaneous Stand Wood Old 05"
offers FBX (four zip files of 7.2 MB to 393 MB), converted glTF/GLB/USDZ files (the GLBs are 3.2 MB low,
11.4 MB mid, 41.9 MB high and 177 MB raw) and additional files. Free downloads need **no sign-in**.

### Robots.txt, terms and bot detection

* `https://www.fab.com/robots.txt` for `User-agent: *` says `Disallow: /i/*`, `/e/*`, `/p/*`,
  `/search?*`. **Every endpoint above is under `/i/` and is therefore disallowed for automated
  clients.** It also declares `Content-Signal: search=yes,ai-train=no,use=reference` and names many
  crawlers (including `ClaudeBot` and `anthropic-ai`) as fully disallowed.
* [Fab Terms of Service](https://www.fab.com/terms-of-service) (updated 2024-10-09), section 1.8: Fab
  "should be accessed through the interfaces that are provided or approved by Epic" and may not be
  accessed "through automated means, including use of scripts, crawlers or similar technologies
  allowing automated systems or software to extract data from Fab" for purposes including "monitoring,
  measuring, analyzing, copying".
* Every Fab page loads Cloudflare challenge scripts. During the research anonymous requests with the
  honest User-Agent were answered normally (HTTP 200, `application/json`), without a challenge.

### The user's decision

The user decided that Fab's `robots.txt` and terms of service do not bind their own **personal, local
use** of this tool, and asked for the metadata feature to be built. That decision is theirs, and so are
the consequences: Fab may rate-limit or block this computer's address, and the terms apply to the
account holder. Forge does not claim Fab's permission. The limits below are engineering safeguards,
not policy compliance.

### Downloads: how they work

* On the website a signed-out visitor who clicks **Download** gets the *Fab End User License Agreement*
  dialog (checkbox, **Cancel**, **Accept**). Acceptance is a legal act, so **Forge never clicks or
  ticks anything on Fab**, and never ticks its own confirmation either.
* Forge's equivalent is a **one-time confirmation on the Megascans page**: a checkbox reading *I have
  read and accept the Fab End User License Agreement, the Fab Terms of Service, Epic's Acceptable Use
  Policy and this listing's licence*, with working links to each. Only a person's click sets it. It
  is saved in `megascans.sqlite` with a timestamp and the agreement version, can be withdrawn by
  unticking, and every download route refuses (HTTP 403, `needsConfirmation`) until it is set. There
  is no MCP tool, API default or test fixture that ticks it for the user.
* A download then runs as: (1) the user presses **Download** on a file in the listing dialog (the
  recommended file is the GLB at mid quality); (2) Forge queues it (never contacting Fab at that
  moment); (3) when a slot is free, Forge asks `download-info` for a fresh signed address **right
  then** and uses it once; (4) it streams the file to `<project>/.forge-staging/megascans/<id>/upload.<ext>.part`,
  checks the size against Fab's file list, renames it, and (5) runs the same validation and safe
  extraction as an import, saving into the project's `3d/` folder with provenance (listing id and
  link, file uid and name, seller, licence name and link, attribution, download time).
* The signed address is a secret: it is never stored (not in SQLite, not in the queue, not in logs),
  never shown, and error messages never contain it. The host must be HTTPS on `*.epicgames.com` or
  `*.epicgamescdn.com` and a redirect is never followed.
* A broken transfer keeps its `.part` file. **Retry** asks for a new signed address and continues with
  a `Range` request when the server answers `206` with the right offset; otherwise it starts over,
  so a file is never corrupted by a server that ignores `Range`.
* Files over 100 MB need a second confirmation in the page (and `confirmLarge` over MCP). Formats
  Forge cannot open (`.usdz`) and the extra EXR texture zip (about 1.9 GB, no model inside) are listed
  but have no Download button; the EXR zip sits under an **Advanced** disclosure with a size warning.
* If the download server (or `download-info`) answers 401/403, redirects, or sends an HTML page, the
  download fails with the blocked message and **all Fab requests pause for an hour**; nothing is
  retried or worked around.

## What is automated and what is manual

| Step | Who |
| --- | --- |
| Reading the newest free Megascans models (**Refresh**), their details and file lists, and thumbnails | Forge, slowly and cached |
| Reading more of the catalog (**Scan catalog**, 10 pages per run, resumable) | Forge, when you start it |
| Searching, filtering and sorting what is cached | Forge, offline |
| Ticking the license confirmation (once) and choosing a file | **You** |
| Fetching the chosen file from Epic's delivery network, size check, resume, safe extraction, free-disk check, atomic save | Forge (queued, 2 at a time) |
| Alternatively: downloading on Fab yourself and choosing the file with Import file | You, then Forge |
| Recording source, licence, seller and attribution | Forge |

## Politeness and safety limits (all enforced in code and tested against a fake Fab on loopback)

| Limit | Value |
| --- | --- |
| User-Agent | `Forge-Studio/<version>` (from `package.json`). Never imitates a browser. No cookies, tokens, referrers or other identity headers are sent. |
| In flight | One request at a time, shared by refresh, detail, scan and thumbnails |
| Spacing | At least 1.5 s after any listing request (`MIN_INTERVAL_MS`); at least 0.5 s after an image request from the media CDN (`IMAGE_MIN_INTERVAL_MS`). Images are fetched only when displayed and cached on disk, so this is a deliberate, documented exception to the 1.5 s rule. |
| Timeout and size | 20 s per request; 8 MiB for JSON, 512 KiB for an image |
| Retries | 429 and 5xx: up to 3 attempts with exponential backoff that honors `Retry-After` (up to 120 s). A longer `Retry-After`, or a 429 that persists, becomes a **rate-limited** pause (at least 10 minutes) instead of more attempts |
| Block detection | 401/403, a redirect, or an HTML page where JSON is expected (challenge, captcha, login wall) stops everything and records a **blocked** pause of one hour. While paused no request is made, the UI says *Fab is blocking automated requests. Try again later, or download from Fab yourself and use Import.* and the cache and the Import flow keep working. Forge never solves a challenge, sets browser-like headers, uses a proxy or reuses cookies |
| Hosts | Only the configured Fab origin and `media.fab.com` for data; only HTTPS `*.epicgames.com` and `*.epicgamescdn.com` for downloads; redirects are never followed |
| Downloads | `download-info` is paced like any listing request (at least 1.5 s). The file transfer itself is a plain GET to Epic's delivery network with the honest User-Agent and no cookies, at most 2 at once (the queue cap), 20 s to receive headers and 60 s without data before it stops |
| Cache first | Browsing reads SQLite only. One automatic **Refresh** when you open the page and the cache is older than 24 h (or empty); otherwise only when you press Refresh (at most once a minute) |
| TTL | Search pages 24 h; listing details 7 days (one read per listing per 30 s at most) |
| Scan | Started by you; at most `SCAN_MAX_PAGES = 10` pages (240 listings) per run; progress saved after every page; **Cancel** and **Resume**; a scan left running by a restart becomes *interrupted*; refresh is refused while a scan runs |
| Thumbnails | Served from `/api/megascans/thumbs/<id>`; fetched once, checked by file signature (JPEG, PNG, WebP), capped at 200 MiB on disk (oldest removed), failures remembered for 10 minutes |

The page footer says: *Fab data is fetched slowly and cached locally; downloads start only after you confirm Fab's license agreement.*

## Caching, offline use and lazy loading

* **Cached in SQLite:** search pages, listing rows (title, category, tags, formats, size range,
  thumbnail reference), listing details (description, licence name and link, triangle and texture
  details) and the **file list of every format** (file uid, name, size, format code, quality), and
  thumbnails on disk. TTLs: search pages 24 h, details and file lists 7 days (the dialog shows
  *Details cached 2 days ago* with **Refresh details**), thumbnails revalidated after 30 days.
* **Never cached:** the signed download address from `download-info`. It is requested immediately
  before each transfer (a resume asks again) and exists only in memory for that transfer.
* **Revalidation:** when Fab sends an `ETag` or `Last-Modified`, Forge stores only that validator and
  asks `If-None-Match` / `If-Modified-Since` next time; a `304` renews the cached copy's age without
  downloading it again (search pages, details, file lists and thumbnails). Fab did not send validators
  in the checks made so far, so in practice every refresh is a full read; the code is ready for when it
  does.
* **Single flight:** identical requests that are in flight at once (the same page, the same listing,
  the same thumbnail) share one transfer.
* **Offline:** everything except starting a download works from the cache. When Fab cannot be
  reached, the page says *Fab could not be reached at 10:32. Everything saved here still works;
  starting a download needs a connection.* Being offline is not a block and sets no pause. Old
  thumbnails are still served.
* **Lazy loading:** the page shows 24 cached models at a time, appends the next 24 with **Load more**
  or when the end of the list scrolls into view (an announcement says *24 more models loaded*, and
  keyboard focus stays on the button or moves to the first new model when the button goes away), and
  only when the whole cache is shown offers **Read more from Fab**, which reads one more page and only
  after the person has scrolled or clicked. Previews load lazily with a placeholder and a visible
  *No preview* state. A listing's details and file list are read only when its dialog opens, and
  `download-info` only when a download is queued by the user's click.

## What gets stored

`.forge-runtime/megascans.sqlite` (tables `listings`, `listings_fts` (FTS5), `search_pages`, `kv`,
`imports`) and `.forge-runtime/megascans-thumbs/`. Neither is committed. Deleting them clears the
cache and the import queue; project files are untouched. Listings you add by address are stored with
`source = 'user'`; a listing later read from Fab becomes `source = 'fab'` and keeps your notes and tags.

## Import rules

| Rule | Value |
| --- | --- |
| Accepted | `.zip`, `.glb`, `.gltf`, `.fbx`, `.obj`, `.ply`, `.stl` |
| Maximum upload | 2 GiB per file (`IMPORT_LIMITS.maxUploadBytes`); the upload must declare its length |
| Maximum expanded size | 6 GiB total, 4 GiB per file, 5000 files per archive |
| Compression ratio | Rejected when a member expands by more than 200 times and 100 MiB |
| Kept from an archive | Models (`.glb .gltf .fbx .obj .mtl .ply .stl .bin`), textures (`.png .jpg .jpeg .webp .tga .bmp .exr`), `.json` and `.txt` notes up to 1 MiB |
| Skipped silently | Any other non-executable file (reported as "skipped") |
| Rejects the whole archive | Executables and scripts (`.exe .dll .bat .cmd .ps1 .sh .js .msi .com .scr .vbs .jar .lnk ...`), encrypted entries, symbolic links, ZIP64, absolute paths, `..` segments, drive letters, alternate data streams, reserved Windows names |
| No model inside | Rejected: "no supported 3D model". Unreal Engine packages (`.uasset`) are not supported. |
| Output | `<project>/3d/megascans-<name>-<id>/` (archives) or `<project>/3d/<name>-<id>.<ext>` (single files). Written to a hidden `.forge-staging` folder inside the project first and renamed into place. |
| Free disk | At least the expanded size plus 256 MiB must be free on the project volume |
| Concurrency | `MAX_CONCURRENT_IMPORTS = 2`, enforced inside an immediate SQLite transaction |

Imported assets show up in the Asset library and their details read
`Source: Imported from Fab / Quixel Megascans` with the listing, licence, seller and attribution. The
3D viewer opens GLB, glTF, FBX and OBJ; it loads each file on its own, so FBX textures may not
appear. Texture images from an archive also appear in the library as images.

### Queue states

`queued` -> `running` -> `completed`, or `failed`, `cancelled`, `interrupted`. A running import found
at start-up becomes `interrupted` and is never restarted by itself. **Retry** discards the partial
extraction and starts again from the saved upload (when it still exists). **Dismiss** removes the
record and the staged upload and never deletes assets already in a project.

## HTTP interface

All routes are under `/api/megascans`, loopback only. Writes require the studio origin and
`X-Forge-Request: megascans`.

| Route | Purpose |
| --- | --- |
| `GET /status` | Limits, what is automated, cache and scan state, block state, queue summary |
| `GET /listings?q=&tag=&sort=&page=&pageSize=` | Search the cache (`sort`: `newest`, `title`, `recent`) |
| `GET /listings/<id>` | One listing and its imports |
| `POST /listings` | Add a listing by address, or add notes and tags `{ url, title, tags, notes }` |
| `POST /listings/<id>/refresh` | Read the description and file list from Fab (cached 7 days); `{ force: true }` re-reads now |
| `POST /listings/<id>/remove` | Remove the listing from the library. Imported project files are untouched. |
| `POST /refresh` | Read page one of the newest free models (once a minute) |
| `POST /more` | Read one more page beyond the cache (used by *Read more from Fab*) |
| `POST /downloads/confirm { accepted: true }`, `POST /downloads/revoke` | The one-time license confirmation (the page's checkbox) |
| `POST /downloads { project, listing, fileUid \| (format, quality), confirmLarge }` | Queue a download. Refused with 403 until confirmed; the file name and size come from the cached file list, never from the request |
| `GET /scan`, `POST /scan { action: start \| resume \| cancel }` | Catalog scan |
| `POST /fab/recheck` | Clear an expired pause |
| `GET /thumbs/<id>` | Cached preview image |
| `POST /imports?project=<uuid>&filename=<name>&listing=<id>` | Upload the downloaded file (raw body) and queue it |
| `GET /imports`, `GET /imports/<id>` | Queue state |
| `POST /imports/<id>/cancel`, `/retry`, `/dismiss` | Queue controls (a download's Retry resumes from its `.part`) |

The studio server (`runtime/http-server.js`) must be restarted to load these routes. `vite.config.js`
also registers the service for `npm run dev`.

## MCP tools

`forge_megascans_search`, `forge_megascans_listing`, `forge_megascans_refresh`,
`forge_megascans_scan`, `forge_megascans_add_listing`, `forge_megascans_download` and
`forge_megascans_downloads` (see [MCP](MCP.md)). `forge_megascans_download` queues a download by file
uid or by format and quality and **refuses until the user has ticked the confirmation in the page**;
no tool can tick it. There is intentionally no tool that imports a file by path: the HTTP API accepts
only uploaded bytes, never a client-supplied path.

## Files, cleanup and recovery

* An upload is written to `<project>/.forge-staging/megascans/<import id>/upload.<ext>.part`, renamed
  when complete, and queued. The folder name starts with a dot, so the Asset library ignores it.
* A **completed** import removes its staging folder. A **failed**, **cancelled** or **interrupted**
  import keeps the staged upload (up to 2 GiB) so Retry works; **Dismiss** removes it. The partial
  extraction folder is always removed. At start-up, staging folders no queue row owns and that are
  over an hour old are removed.
* Final output never replaces an existing file or folder. Delete imported files through the Asset
  library (recoverable trash).
* Errors shown in the page never include local paths; the studio log has the detail.

## Licences and terms on the page

The page footer and every listing dialog show a **Licences and terms** block with external links
(`target="_blank"`, `rel="noopener noreferrer"`, an icon and "opens in a new tab" for screen readers):
the listing's own licence (name and link from the listing data; the Standard License is the Fab
EULA), the listing page on Fab, the [Fab End User License Agreement](https://www.fab.com/eula), the
[Fab Terms of Service](https://www.fab.com/terms-of-service), Epic's
[Acceptable Use Policy](https://dev.epicgames.com/en-US/services/terms/aup) and the Quixel Megascans
seller page. The confirmation checkbox links to the same documents. Each card shows its licence
name, and an imported asset's details record the licence name and link.

## Licence and legal notes

* Megascans on Fab are licensed under Fab's terms, not by Forge. You are responsible for complying
  with the [Fab EULA](https://www.fab.com/eula), the Fab Terms of Service and Epic's other terms.
  Epic staff have said the Fab Standard licence does not require attribution; the recorded
  attribution text ("<title> by Quixel Megascans (Epic Games), via Fab: <address>") lets you credit
  the work anyway. Check each listing's licence: Creative Commons listings differ.
* Redistributing the raw asset files, including re-uploading them to a marketplace, is generally not
  allowed by the Fab licence. Keep project files that contain Megascans content out of public
  repositories unless you have checked.
* Forge cannot verify that an imported file is a genuine Megascans asset or that you are entitled to
  it. The recorded source is what you told Forge.
* Reading Fab's endpoints is against Fab's `robots.txt` and terms (see above) and happens on the
  user's decision. If Fab answers with a challenge or a refusal Forge stops and does not retry for an
  hour.

## Verification status

See [test/README.md](../test/README.md#megascans-cache-library-and-import-queue). The automated tests
use a fake Fab and a fake delivery network on loopback and temporary directories; **no test
contacts fab.com**.

Checked live against fab.com (anonymous, honest User-Agent, listing calls at least 1.5 s apart):
seller search (24 per page, two pages by the scan), the listing detail, the full file list and one
`download-info` response shape (read by the coordinator with plain `curl`), about two dozen
thumbnails. All answered normally.

**Not yet verified by Forge itself:** an end-to-end real download through the new code path. It needs
the license confirmation to be ticked by a person in the scratch studio's page (an agent must not
tick it), after which two small files are downloaded (the 3.2 MB low GLB and the 7 MB low FBX zip of
listing `854ffc09-e07f-45c2-9569-37cb7c4ab9c2`) and opened in the viewer. Until that is done, the
download path is covered by the fake server tests only.

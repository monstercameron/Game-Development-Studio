// The local library of Fab listing references the user has saved for Megascans models.
//
// Forge does not fetch anything from Fab (see docs/MEGASCANS.md). Every field here is typed
// or pasted by the user; the Fab address is only parsed for its listing id, never requested.
import { transaction } from './megascans-db.js';

export const FAB_SELLER = 'Quixel Megascans';
export const DEFAULT_LICENSE = 'Fab Standard License';
export const FAB_SELLER_URL =
  'https://www.fab.com/sellers/Quixel%20Megascans?listing_types=3d-model&is_free=1';
export const LIBRARY_LIMITS = Object.freeze({
  description: 2000,
  title: 120,
  notes: 2000,
  license: 80,
  tags: 12,
  tagLength: 30,
  pageSize: 60,
  maxListings: 20000,
});
const LISTING_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// eslint-disable-next-line no-control-regex -- Matching the control range is the point.
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g;
const FAB_HOSTS = new Set(['fab.com', 'www.fab.com']);

export class LibraryError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'LibraryError';
    this.status = status;
  }
}

/**
 * Reads the listing id out of a Fab listing address (or a bare id). Nothing is requested.
 * @param {unknown} input
 * @returns {{ id: string, url: string } | null} The canonical id and address, or null.
 */
export function parseFabListing(input) {
  const text = typeof input === 'string' ? input.trim() : '';
  if (!text || text.length > 500) {
    return null;
  }
  let id = null;
  if (LISTING_ID.test(text)) {
    id = text;
  } else {
    try {
      const url = new URL(text);
      const match = /^\/listings\/([0-9a-f-]{36})\/?$/i.exec(url.pathname);
      if (url.protocol === 'https:' && FAB_HOSTS.has(url.hostname) && match) {
        id = match[1];
      }
    } catch {
      return null;
    }
  }
  if (!id || !LISTING_ID.test(id)) {
    return null;
  }
  const lower = id.toLowerCase();
  return { id: lower, url: `https://www.fab.com/listings/${lower}` };
}

export function normalizeTags(input) {
  const raw = Array.isArray(input) ? input : typeof input === 'string' ? input.split(',') : [];
  const tags = [];
  for (const item of raw) {
    const tag = String(item ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9 _-]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, LIBRARY_LIMITS.tagLength);
    if (tag && !tags.includes(tag)) {
      tags.push(tag);
    }
  }
  return tags.slice(0, LIBRARY_LIMITS.tags);
}

function plainText(value, max) {
  // Drops control characters except tab and newline.
  return String(value ?? '')
    .replace(CONTROL_CHARACTERS, '')
    .trim()
    .slice(0, max);
}

export function attributionText(listing) {
  return `${listing.title} by ${listing.seller} (Epic Games), via Fab: ${listing.url}`;
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(value) ?? fallback;
  } catch {
    return fallback;
  }
}

function unionTags(...lists) {
  return [...new Set(lists.flat())];
}

function publicListing(row) {
  const detail = parseJson(row.detail, null);
  const listing = {
    id: row.id,
    title: row.title,
    url: row.url,
    license: row.license,
    seller: row.seller,
    // 'fab' rows were read from Fab's public data; 'user' rows are references typed by the user.
    source: row.source,
    tags: unionTags(parseJson(row.tags, []), parseJson(row.user_tags, [])),
    fabTags: parseJson(row.tags, []),
    userTags: parseJson(row.user_tags, []),
    notes: row.notes,
    category: row.category,
    formats: parseJson(row.formats, []),
    sizeMin: row.size_min,
    sizeMax: row.size_max,
    publishedAt: row.published_at,
    fetchedAt: row.fetched_at,
    detailFetchedAt: row.detail_fetched_at,
    // Served from the local thumbnail cache, never straight from Fab.
    thumbnailUrl: row.thumbnail_url ? `/api/megascans/thumbs/${row.id}` : null,
    detail,
    licenseUrl: detail?.licenseUrl || 'https://www.fab.com/eula',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  return { ...listing, attribution: attributionText(listing) };
}

function ftsQuery(text) {
  const words = plainText(text, 200)
    .split(/\s+/)
    .map((word) => word.replace(/[^\p{L}\p{N}_-]/gu, ''))
    .filter(Boolean)
    .slice(0, 8);
  return words.map((word) => `"${word}"*`).join(' ');
}

const SORTS = {
  newest: '(published_at IS NULL), published_at DESC, title COLLATE NOCASE, id',
  title: 'title COLLATE NOCASE ASC, id',
  recent: 'updated_at DESC, id',
};

export class MegascansLibrary {
  /**
   * @param {{ db: import('node:sqlite').DatabaseSync, hasFts: boolean }} handle
   * @param {{ now?: () => Date }} [options]
   */
  constructor({ db, hasFts }, { now = () => new Date() } = {}) {
    this.db = db;
    this.hasFts = hasFts;
    this.now = now;
  }

  reindex(id) {
    if (!this.hasFts) {
      return;
    }
    const row = this.db.prepare('SELECT * FROM listings WHERE id=?').get(id);
    this.db.prepare('DELETE FROM listings_fts WHERE id=?').run(id);
    if (row) {
      const tags = unionTags(parseJson(row.tags, []), parseJson(row.user_tags, []));
      this.db
        .prepare('INSERT INTO listings_fts (id,title,tags,notes) VALUES (?,?,?,?)')
        .run(id, row.title, [...tags, row.category || ''].join(' '), row.notes);
    }
  }

  assertRoom() {
    const { count } = this.db.prepare('SELECT COUNT(*) AS count FROM listings').get();
    if (count >= LIBRARY_LIMITS.maxListings) {
      throw new LibraryError('The library is full. Remove listings you no longer need.');
    }
  }

  /**
   * Adds a listing reference typed by the user, or updates the user's own fields. A listing that
   * was read from Fab keeps Fab's title and licence; only notes and tags change.
   */
  upsert(input) {
    const parsed = parseFabListing(input?.url ?? input?.id);
    if (!parsed) {
      throw new LibraryError(
        'Enter a Fab listing address such as https://www.fab.com/listings/<id>.',
      );
    }
    const title = plainText(input?.title, LIBRARY_LIMITS.title);
    const notes = plainText(input?.notes, LIBRARY_LIMITS.notes);
    const userTags = normalizeTags(input?.tags);
    const stamp = this.now().toISOString();
    transaction(this.db, () => {
      const existing = this.db.prepare('SELECT source FROM listings WHERE id=?').get(parsed.id);
      if (existing?.source === 'fab') {
        this.db
          .prepare('UPDATE listings SET notes=?, user_tags=?, updated_at=? WHERE id=?')
          .run(notes, JSON.stringify(userTags), stamp, parsed.id);
      } else {
        if (!title) {
          throw new LibraryError('Enter a title for this listing.');
        }
        if (!existing) {
          this.assertRoom();
        }
        const license = plainText(input?.license, LIBRARY_LIMITS.license) || DEFAULT_LICENSE;
        this.db
          .prepare(
            `INSERT INTO listings (id,title,url,license,seller,tags,user_tags,notes,source,
               created_at,updated_at) VALUES (?,?,?,?,?,'[]',?,?,'user',?,?)
             ON CONFLICT(id) DO UPDATE SET title=excluded.title, license=excluded.license,
               user_tags=excluded.user_tags, notes=excluded.notes, updated_at=excluded.updated_at`,
          )
          .run(
            parsed.id,
            title,
            parsed.url,
            license,
            FAB_SELLER,
            JSON.stringify(userTags),
            notes,
            stamp,
            stamp,
          );
      }
      this.reindex(parsed.id);
    });
    return this.get(parsed.id);
  }

  /**
   * Stores listings read from Fab. Existing rows keep the user's notes and tags.
   * @param {object[]} listings Output of normalizeListing.
   * @returns {{ added: number, updated: number }}
   */
  upsertFab(listings) {
    const stamp = this.now().toISOString();
    let added = 0;
    let updated = 0;
    transaction(this.db, () => {
      for (const item of listings) {
        const existing = this.db.prepare('SELECT 1 FROM listings WHERE id=?').get(item.id);
        if (!existing) {
          this.assertRoom();
        }
        this.db
          .prepare(
            `INSERT INTO listings (id,title,url,license,seller,tags,user_tags,notes,source,
               thumbnail_url,category,formats,size_min,size_max,published_at,fetched_at,
               created_at,updated_at)
             VALUES (?,?,?,?,?,?,'[]','','fab',?,?,?,?,?,?,?,?,?)
             ON CONFLICT(id) DO UPDATE SET title=excluded.title, license=excluded.license,
               tags=excluded.tags, source='fab', thumbnail_url=excluded.thumbnail_url,
               category=excluded.category, formats=excluded.formats, size_min=excluded.size_min,
               size_max=excluded.size_max, published_at=excluded.published_at,
               fetched_at=excluded.fetched_at`,
          )
          .run(
            item.id,
            item.title,
            `https://www.fab.com/listings/${item.id}`,
            item.license,
            FAB_SELLER,
            JSON.stringify(normalizeTags(item.tags)),
            item.thumbnailUrl,
            item.category,
            JSON.stringify(item.formats),
            item.sizeMin,
            item.sizeMax,
            item.publishedAt,
            stamp,
            stamp,
            stamp,
          );
        this.reindex(item.id);
        if (existing) {
          updated++;
        } else {
          added++;
        }
      }
    });
    return { added, updated };
  }

  /** Stores the extra fields read from a listing's detail endpoints. */
  setDetail(id, detail) {
    const stamp = this.now().toISOString();
    const result = this.db
      .prepare('UPDATE listings SET detail=?, detail_fetched_at=?, license=? WHERE id=?')
      .run(JSON.stringify(detail), stamp, detail.license || DEFAULT_LICENSE, id);
    return Number(result.changes) > 0;
  }

  /** Renews the age of the cached details after Fab confirmed they are unchanged. */
  touchDetail(id) {
    this.db
      .prepare('UPDATE listings SET detail_fetched_at=? WHERE id=?')
      .run(this.now().toISOString(), id);
  }

  /** The address Forge may fetch a thumbnail from, or null. Not part of the public record. */
  thumbnailSource(id) {
    return (
      this.db.prepare('SELECT thumbnail_url FROM listings WHERE id=?').get(String(id))
        ?.thumbnail_url || null
    );
  }

  get(id) {
    const row = this.db.prepare('SELECT * FROM listings WHERE id=?').get(String(id));
    return row ? publicListing(row) : null;
  }

  /** Removes the reference only. Files already imported into projects are not touched. */
  remove(id) {
    return transaction(this.db, () => {
      const result = this.db.prepare('DELETE FROM listings WHERE id=?').run(String(id));
      if (this.hasFts) {
        this.db.prepare('DELETE FROM listings_fts WHERE id=?').run(String(id));
      }
      return Number(result.changes) > 0;
    });
  }

  count({ source } = {}) {
    return source
      ? this.db.prepare('SELECT COUNT(*) AS count FROM listings WHERE source=?').get(source).count
      : this.db.prepare('SELECT COUNT(*) AS count FROM listings').get().count;
  }

  /**
   * Full-text search over the local library and the Fab cache, with an optional exact tag filter.
   * @param {{ q?: string, tag?: string, sort?: 'newest' | 'title' | 'recent', page?: number, pageSize?: number }} query
   */
  search({ q = '', tag = '', sort = 'newest', page = 1, pageSize = 24 } = {}) {
    const size = Math.min(
      Math.max(Number.parseInt(pageSize, 10) || 24, 1),
      LIBRARY_LIMITS.pageSize,
    );
    const requested = Math.max(Number.parseInt(page, 10) || 1, 1);
    const where = [];
    const params = [];
    const match = ftsQuery(q);
    if (match && this.hasFts) {
      where.push('listings.id IN (SELECT id FROM listings_fts WHERE listings_fts MATCH ?)');
      params.push(match);
    } else if (match) {
      const like = `%${plainText(q, 100).replace(/[%_\\]/g, '\\$&')}%`;
      where.push(
        "(title LIKE ? ESCAPE '\\' OR notes LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\' OR user_tags LIKE ? ESCAPE '\\')",
      );
      params.push(like, like, like, like);
    }
    const cleanTag = normalizeTags([tag])[0];
    if (cleanTag) {
      where.push(
        `(EXISTS (SELECT 1 FROM json_each(listings.tags) WHERE value = ?)
          OR EXISTS (SELECT 1 FROM json_each(listings.user_tags) WHERE value = ?))`,
      );
      params.push(cleanTag, cleanTag);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = this.db
      .prepare(`SELECT COUNT(*) AS count FROM listings ${clause}`)
      .get(...params).count;
    const pageCount = Math.max(Math.ceil(total / size), 1);
    const current = Math.min(requested, pageCount);
    const order = SORTS[sort] || SORTS.newest;
    const rows = this.db
      .prepare(`SELECT * FROM listings ${clause} ORDER BY ${order} LIMIT ? OFFSET ?`)
      .all(...params, size, (current - 1) * size);
    return {
      listings: rows.map(publicListing),
      total,
      page: current,
      pageSize: size,
      pageCount,
    };
  }

  /** Tags in use, most used first. Fab's tags and the user's own are counted together. */
  tagCounts(limit = 40) {
    return this.db
      .prepare(
        `SELECT tag, COUNT(*) AS count FROM (
           SELECT listings.id AS id, value AS tag FROM listings, json_each(listings.tags)
           UNION
           SELECT listings.id, value FROM listings, json_each(listings.user_tags)
         ) GROUP BY tag ORDER BY count DESC, tag LIMIT ?`,
      )
      .all(limit)
      .map((row) => ({ tag: row.tag, count: row.count }));
  }
}

import { useCallback, useEffect } from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router';

export const panels = new Set([
  'overview',
  'chat',
  'images',
  '3d',
  'vegetation',
  'world',
  'motion',
  'video',
  'music',
  'sfx',
  'voices',
  'segmentation',
  'game',
  'queue',
  'assets',
  'megascans',
  'models',
  'diagnostics',
]);

export function useNav() {
  const { section: pathSection } = useParams();
  const location = useLocation();
  const route = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const section = pathSection || (location.pathname === '/' ? 'overview' : null);
  useEffect(() => {
    // Redirect links created by the old hash navigation without adding a history entry.
    if (location.pathname !== '/' || !location.hash) {
      return;
    }
    const oldHash = location.hash.slice(1);
    if (panels.has(oldHash)) {
      route(
        {
          pathname: oldHash === 'overview' ? '/' : '/' + oldHash,
          search: location.search,
        },
        { replace: true },
      );
    }
  }, [location.pathname, location.hash, location.search, route]);
  const navigate = useCallback(
    (panel, options = {}) => {
      if (!panels.has(panel)) {
        return;
      }
      route(panelLocation(panel, searchParams, options));
      window.scrollTo(0, 0);
    },
    [route, searchParams],
  );
  return [panels.has(section) ? section : null, navigate, searchParams, setSearchParams];
}

/**
 * Replace frequently typed fields; discrete selections make navigable history entries.
 * A null, undefined or empty value removes the key from the URL.
 *
 * @param {Function} setSearchParams The setter returned by useSearchParams.
 * @param {Record<string, unknown>} changes Keys to set or remove.
 * @param {{ replace?: boolean }} [options] Use replace to avoid a history entry.
 */
export function updateSearch(setSearchParams, changes, { replace = false } = {}) {
  setSearchParams(
    (current) => {
      const next = new URLSearchParams(current);
      for (const [key, value] of Object.entries(changes)) {
        if (value === null || value === undefined || value === '') {
          next.delete(key);
        } else {
          next.set(key, String(value));
        }
      }
      return next;
    },
    { replace },
  );
}

/**
 * Panel changes carry project context, while page-specific filters stay on their page.
 * options.project of undefined inherits the current project; null or '' drops it.
 */
export function panelLocation(panel, current, options = {}) {
  const params = new URLSearchParams();
  const project = options.project === undefined ? current.get('project') : options.project;
  if (project) {
    params.set('project', project);
  }
  if (options.model) {
    params.set('model', options.model);
  }
  return {
    pathname: panel === 'overview' ? '/' : '/' + panel,
    search: params.toString() ? '?' + params : '',
  };
}

// Shareable open/closed UI state. Opening and closing are navigations, never actions.
// The URL is the source of truth, so the state survives reloads and history traversal.
export function useRouteToggle(key) {
  const [params, setParams] = useSearchParams();
  const open = params.get(key) === '1';
  const setOpen = (value) =>
    updateSearch(setParams, {
      [key]: (typeof value === 'function' ? value(open) : value) ? '1' : null,
    });
  return [open, setOpen];
}

// Keeps a native <details> element in sync with the URL-backed open state.
// Only write when the DOM differs, so a re-render does not add history entries.
export function routeDetails(open, setOpen) {
  return {
    open,
    onToggle: (event) => {
      if (event.currentTarget.open !== open) {
        setOpen(event.currentTarget.open);
      }
    },
  };
}

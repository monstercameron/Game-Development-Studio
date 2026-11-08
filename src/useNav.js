import { useCallback, useEffect } from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router';

export const panels = new Set([
  'overview',
  'chat',
  'images',
  '3d',
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
    const old = location.hash.slice(1);
    if (panels.has(old)) {
      route(
        { pathname: old === 'overview' ? '/' : '/' + old, search: location.search },
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

// Replace frequently typed fields; discrete selections make navigable history entries.
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

// Panel changes carry project context, while page-specific filters stay on their page.
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
export function useRouteToggle(key) {
  const [params, setParams] = useSearchParams();
  const open = params.get(key) === '1';
  const setOpen = (value) =>
    updateSearch(setParams, {
      [key]: (typeof value === 'function' ? value(open) : value) ? '1' : null,
    });
  return [open, setOpen];
}
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

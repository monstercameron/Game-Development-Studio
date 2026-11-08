import { useEffect, useRef, useState } from 'react';
import { Box, Clapperboard, Image as ImageIcon, ImageOff } from 'lucide-react';
import './asset-thumbnail.css';
import './ux-viewer.css';

// Shared in-flight and settled thumbnail work, keyed by request URL or asset identity.
const tasks = new Map();
// Renders run one at a time; each new render waits for the previous one to settle.
let tail = Promise.resolve();
const visual = (asset) => ['Images', 'Masks', 'Video', '3D'].includes(asset.category);
function thumbnailUrl(project, asset) {
  const version = encodeURIComponent(`${asset.modified}:${asset.size}`);
  return `/api/projects/${project.id}/thumbnail?path=${encodeURIComponent(asset.id)}&v=${version}`;
}
function loadThumbnail(project, asset) {
  const key = project
    ? thumbnailUrl(project, asset)
    : JSON.stringify([
        asset.url || asset.file,
        asset.category,
        asset.modified,
        asset.size,
        asset.name,
        asset.title,
      ]);
  if (tasks.has(key)) {
    return tasks.get(key);
  }
  // A failed preview is reported to its caller but must not block later previews.
  const work = tail
    .catch(() => {})
    .then(async () => {
      if (project) {
        const found = await fetch(key);
        if (found.ok) {
          return key;
        }
      }
      const { renderThumbnail } = await import('./thumbnail-renderer');
      const image = await renderThumbnail(asset);
      if (project) {
        const response = await fetch(key, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Forge-Request': 'project' },
          body: JSON.stringify({ image, modified: asset.modified, size: asset.size }),
        });
        if (response.ok) {
          return key;
        }
      }
      return image;
    });
  tail = work;
  tasks.set(key, work);
  work.catch(() => tasks.delete(key));
  return work;
}
export default function AssetThumbnail({ asset, project, className = '' }) {
  const node = useRef(null);
  const [source, setSource] = useState(null);
  const [failed, setFailed] = useState(false);
  const projectId = project?.id;
  const { id, category, modified, size, url, file, name, title } = asset;
  useEffect(() => {
    let active = true;
    setSource(null);
    setFailed(false);
    const selectedAsset = { id, category, modified, size, url, file, name, title };
    const selectedProject = projectId ? { id: projectId } : null;
    if (!visual(selectedAsset)) {
      return;
    }
    const start = () =>
      loadThumbnail(selectedProject, selectedAsset).then(
        (result) => {
          if (active) {
            setSource(result);
          }
        },
        () => {
          if (active) {
            setFailed(true);
          }
        },
      );
    if (!node.current || !('IntersectionObserver' in window)) {
      start();
      return () => {
        active = false;
      };
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          observer.disconnect();
          start();
        }
      },
      { rootMargin: '300px' },
    );
    observer.observe(node.current);
    return () => {
      active = false;
      observer.disconnect();
    };
  }, [projectId, id, category, modified, size, url, file, name, title]);
  const isThreeD = asset.category === '3D';
  const loadingLabel = isThreeD ? 'Rendering 3D preview…' : 'Preparing preview';
  const failedLabel = isThreeD ? 'Preview unavailable · open to inspect' : 'Preview unavailable';
  const Icon =
    asset.category === '3D' ? Box : asset.category === 'Video' ? Clapperboard : ImageIcon;
  return (
    <span
      ref={node}
      className={`asset-visual-thumbnail ${className}`}
      data-category={asset.category}
      aria-hidden="true"
    >
      {source && !failed ? (
        <img src={source} alt="" loading="lazy" onError={() => setFailed(true)} />
      ) : (
        <span
          className="asset-thumbnail-placeholder"
          data-state={failed ? 'failed' : 'loading'}
          data-pending={failed ? undefined : ''}
          title={failed ? 'Preview unavailable' : undefined}
        >
          {failed ? <ImageOff size={30} /> : <Icon size={30} />}
          <small>{failed ? failedLabel : loadingLabel}</small>
        </span>
      )}
    </span>
  );
}
export { visual as isVisualAsset };

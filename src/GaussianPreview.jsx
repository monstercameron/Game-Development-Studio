import ThreeViewer from './ThreeViewer';
import { loadSplatSource } from './viewer-splat';
import './ux-viewer.css';

// Splat scenes are stored y-down; the engine flips its camera frame to match.
const ENGINE_OPTIONS = { flipY: true, powerPreference: 'high-performance' };

export default function GaussianPreview({ onFallback, ...props }) {
  return (
    <ThreeViewer
      {...props}
      source={loadSplatSource}
      engineOptions={ENGINE_OPTIONS}
      onFallback={onFallback}
      fallbackLabel="Show point preview"
    />
  );
}

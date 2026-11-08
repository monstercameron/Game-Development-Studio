import ThreeViewer from './ThreeViewer';
import { loadMotionSource } from './viewer-sources';
import './ux-viewer.css';

// BVH motion capture, drawn as an animated skeleton with playback controls.
export default function MotionPreview(props) {
  return <ThreeViewer {...props} source={loadMotionSource} />;
}

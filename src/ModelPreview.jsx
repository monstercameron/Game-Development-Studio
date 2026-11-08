import { Box } from 'lucide-react';
import ThreeViewer from './ThreeViewer';
import { loadModelSource } from './viewer-sources';
import './ux-viewer.css';

const SUPPORTED = /\.(glb|gltf|fbx|ply|obj|stl)$/i;

// Meshes, point clouds and animated GLB/FBX files share one viewer workbench.
export default function ModelPreview(props) {
  if (!SUPPORTED.test(props.name || '')) {
    return (
      <div className="viewer-message">
        <Box size={26} aria-hidden="true" />
        <strong>Preview unavailable</strong>
        <span>
          GLB, self-contained glTF, FBX, PLY, OBJ and STL files can be previewed here. Download this
          file to open it in a 3D editor.
        </span>
      </div>
    );
  }
  return <ThreeViewer {...props} source={loadModelSource} />;
}

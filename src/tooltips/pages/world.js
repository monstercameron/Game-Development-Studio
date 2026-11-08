const world = {
  'Starting point':
    'WorldGen can start from a text description, one reference photo that it extends all the way around, or a finished 360° panorama that it only lifts into 3D. HY-World can reconstruct from 1–8 views of a scene, or cut one 360° panorama into eight views.',
  'Describe your world':
    'Describe the place, style, lighting and mood. WorldGen first paints a 360° panorama from this text, then lifts it into 3D. Up to 4,000 characters.',
  'Description (optional)':
    'Optional text for the parts of the scene the photo does not show. Leave it blank to let WorldGen continue the photo on its own.',
  'Panorama width':
    'Width of the 2:1 equirectangular panorama WorldGen builds the world from. The height is half. Each panorama pixel becomes one splat or mesh vertex, so 2048 gives about 2.1 million and needs more memory.',
  'Resolution per view':
    'The longest side, in pixels, at which HY-World reconstructs each view. Higher values add detail and splats and use more memory; 952 is HY-World’s own default.',
  Output:
    'A Gaussian splat is a soft point-based scene that previews well. The two mesh options build a vertex-coloured triangle mesh instead, as PLY or as a GLB that game engines and 3D tools import directly.',
  'Generation steps':
    'How many FLUX refinement steps paint the panorama, from 10 to 60. More steps can add detail and take longer; the panorama is only painted for text and photo starts.',
  Seed: 'A whole number that makes the panorama repeatable with the same settings. Leave it blank for a random seed, which Forge records with the world.',
  'Prompt guidance':
    'How strongly FLUX follows your description, from 1 to 50. Blank keeps the model’s own value: 7 for a text start and 30 for a photo start. Very high values can look harsh.',
  'Save the generated panorama':
    'Also saves the 360° image WorldGen painted as a project image. Reuse it with the 360° panorama start to make a mesh or a different resolution without painting it again.',
  'Splat limit':
    'The most Gaussians HY-World writes to the PLY. When the views produce more, the extra detail is thinned out. Lower it for smaller files; raise it to keep everything.',
  'Remove sky':
    'Uses HY-World’s sky model to drop sky pixels before building the splat. Helpful for outdoor views with empty sky; leave it off for indoor scenes.',
  'Drop least-confident points (%)':
    'Removes this percentage of the points HY-World is least sure about, which clears floating specks. 0 keeps every point; the default is 10.',
};

export default world;

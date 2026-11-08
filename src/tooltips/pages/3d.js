const threeD = {
  '3D model':
    'Choose which model makes the 3D asset. Hunyuan creates an untextured shape by default and can optionally paint a texture (experimental); TRELLIS.2 makes a textured model from a transparent image and is experimental. Both save a GLB, which the asset library can convert to OBJ, PLY, STL or glTF.',
  'Creative notes (draft only)':
    'These notes are saved with the draft, but are not sent to either 3D model.',
  'Reference image':
    'The single image the model uses to build the 3D asset. Hunyuan accepts PNG, JPEG, or WebP and treats any transparent pixels as background, so cut the object out first. TRELLIS.2 requires a transparent PNG or WebP. Tick “Remove the background first” to let Forge cut the object out with SAM 3.1 instead.',
  'Choose a reference image':
    'Choose one image to guide the 3D model. TRELLIS.2 requires a transparent PNG or WebP unless you remove the background first; Hunyuan also accepts JPEG.',
  'Remove the background first (uses SAM 3.1)':
    'Queues two renders: SAM 3.1 cuts out the object you name (saved as a transparent PNG in the project), then the 3D model is built from the cutout. The two models load one after the other. Unavailable when the picture already has a transparent background, because there is nothing to remove.',
  'What to isolate':
    'A short description of the object SAM 3.1 should keep, for example “the dragon”. Leave empty for “the main object”. If nothing matches, the 3D render stops with that message.',
  'Describe the object':
    'The object to create. Forge first draws it with Qwen Image 2.1 on a transparent background and saves that picture in your project, then builds the 3D model from it. Describe one object, fully in view.',
  'Image steps':
    'Refinement steps for the Qwen Image picture that the 3D model is built from, from 1 to 100. The default is 25. More steps take longer. The 3D step has its own settings below.',
  'Image seed':
    'Whole number that repeats the picture with the same description and steps. Leave empty for a random seed. The 3D seed is under Advanced settings.',
  Pipeline:
    'TRELLIS.2 resolution. 512 is the default and the fastest; 1024, 1024 cascade and 1536 cascade add detail but take longer, wait for more GPU memory and read about 5 GB of extra checkpoints the first time. They have not been timed on this computer.',
  'Painted views (advanced)':
    'How many views the Hunyuan painter renders and combines into the texture. The painter was trained on 6; more views take longer.',
  'View size (advanced)':
    'Size of each painted view in pixels. In a test here, 8 views at 768 pixels looked no better than 6 at 512, took about twice as long and used about 15 GB more GPU memory.',
  'Octree resolution':
    'Sets the grid density of Hunyuan’s shape mesh. 128 is tested; 256 and 384 are experimental, add detail and triangles, and use more memory and time.',
  'Guidance scale':
    'How strongly Hunyuan follows the reference image, from 1 to 20. The default of 5 is the model’s own setting; higher values can look harsher.',
  'Triangle budget':
    'Optional mesh simplification. Automatic keeps Hunyuan’s raw mesh, or reduces it to 40,000 triangles when painting. TRELLIS.2 defaults to 100,000 triangles instead of the upstream 1,000,000. Fewer triangles suit games but lose detail.',
  '128 · tested':
    'Uses Hunyuan’s tested mesh resolution. Higher resolutions are experimental and may need more memory and time.',
  '256 · experimental':
    'Attempts a more detailed mesh with Hunyuan. This setting is experimental and may use more memory and time.',
  '384 · experimental':
    'Attempts the highest listed mesh detail with Hunyuan. This setting is experimental and may use substantially more memory and time.',
  'Texture size':
    'Sets the texture image size for TRELLIS.2. Larger textures can take longer and use more memory.',
  '512 px': 'Sets the TRELLIS.2 texture size to 512 pixels. The textured model is experimental.',
  '1024 px':
    'Sets the TRELLIS.2 texture size to 1024 pixels. Larger textures can take longer and use more memory.',
  '2048 px':
    'Sets the largest listed TRELLIS.2 texture size. It may take longer and use more memory.',
  'Paint texture (experimental)':
    'Adds a second Hunyuan stage that paints colour and metallic-roughness maps from your reference image. It loads extra models and takes much longer, and seams or soft detail can remain. There is no normal map. Leave it off for the tested untextured shape.',
  'Texture map size':
    'Sets the size of the painted Hunyuan texture maps. 2048 holds more detail than 1024 and makes a larger file.',
  'Denoising steps':
    'Sets how many refinement steps the model runs. More steps can take longer; Hunyuan’s default is 30 and TRELLIS.2’s is 12.',
  'Advanced settings': 'Open the optional seed control for this 3D render.',
  Seed: 'Enter a whole number to help repeat a render with the same model and settings. Leave blank for a random seed.',
};

export default threeD;

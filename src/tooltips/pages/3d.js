const threeD = {
  '3D model': 'Choose which model makes the 3D asset. Hunyuan creates an untextured shape; TRELLIS.2 attempts a textured model and is experimental.',
  'Creative notes (draft only)': 'These notes are saved with the draft, but are not sent to either 3D model.',
  'Reference image': 'The single image the model uses to build the 3D asset. Hunyuan accepts PNG, JPEG, or WebP; TRELLIS.2 requires a transparent PNG or WebP.',
  'Choose a reference image': 'Choose one image to guide the 3D model. TRELLIS.2 requires a transparent PNG or WebP; Hunyuan also accepts JPEG.',
  'Mesh resolution': 'Sets the detail level of Hunyuan’s shape mesh. 128 is tested; 256 and 384 are experimental and can use more memory and time.',
  '128 · tested': 'Uses Hunyuan’s tested mesh resolution. Higher resolutions are experimental and may need more memory and time.',
  '256 · experimental': 'Attempts a more detailed mesh with Hunyuan. This setting is experimental and may use more memory and time.',
  '384 · experimental': 'Attempts the highest listed mesh detail with Hunyuan. This setting is experimental and may use substantially more memory and time.',
  'Texture size': 'Sets the texture image size for TRELLIS.2. Larger textures can take longer and use more memory; full renders have not yet been verified.',
  '512 px': 'Sets the TRELLIS.2 texture size to 512 pixels. The textured model is experimental and a full render is not yet verified.',
  '1024 px': 'Sets the TRELLIS.2 texture size to 1024 pixels. Larger textures can take longer and use more memory; a full render is not yet verified.',
  '2048 px': 'Sets the largest listed TRELLIS.2 texture size. It may take longer and use more memory; a full render is not yet verified.',
  'Denoising steps': 'Sets how many refinement steps the model runs. More steps can take longer; Hunyuan’s default is 30 and TRELLIS.2’s is 12.',
  'Advanced settings': 'Open the optional seed control for this 3D render.',
  'Seed': 'Enter a whole number to help repeat a render with the same model and settings. Leave blank for a random seed.',
};

export default threeD;

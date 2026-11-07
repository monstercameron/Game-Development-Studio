const images = {
  Project: 'Choose the project where this image and its render will be saved.',
  'Describe what you want to create':
    'Describe the subject, visual style, lighting, and mood. This text guides the image render.',
  'Reference images':
    'Optional visual references for the render. Add up to 10 PNG, JPEG, or WebP files; each must be under 10 MiB and together under 40 MiB. Select them again after refreshing the page.',
  'Add reference images':
    'Choose up to 10 PNG, JPEG, or WebP files to guide the image render. Each must be under 10 MiB and all together under 40 MiB.',
  'Aspect ratio':
    'Choose the image shape. This sets the default dimensions; you can override width and height below.',
  'Landscape · 16:9': 'Uses a wide 1024 × 576 image by default.',
  'Square · 1:1': 'Uses a 1024 × 1024 image by default.',
  'Portrait · 9:16': 'Uses a tall 576 × 1024 image by default.',
  Quality:
    'Sets the number of image-generation steps: Draft uses 12, Balanced uses 30, and High quality uses 40. More steps usually take longer.',
  Balanced: 'Uses 30 image-generation steps, a middle ground between speed and detail.',
  Draft: 'Uses 12 image-generation steps for a quicker render.',
  'High quality': 'Uses 40 image-generation steps for more refinement, with a longer render time.',
  'Fine-tune image': 'Set exact dimensions and generation steps, or describe details to avoid.',
  'Width in pixels':
    'Set the output width from 32 to 2048 pixels. Leave blank to use the selected aspect ratio; values must be multiples of 32.',
  'Height in pixels':
    'Set the output height from 32 to 2048 pixels. Leave blank to use the selected aspect ratio; values must be multiples of 32.',
  'Sampling steps':
    'Choose 1–100 generation steps. More steps can improve refinement but take longer; blank uses the selected quality setting.',
  'Negative prompt':
    'Describe elements you want the image to avoid. This is optional and only takes effect when negative prompt guidance is enabled.',
  'Negative prompt guidance':
    'Controls how strongly the render avoids your negative prompt. Must be greater than 1 and at most 10; higher values can increase render time. Blank uses 2.',
  'Advanced settings': 'Open the optional seed control for this image render.',
  Seed: 'Enter a number to make the render repeatable with the same prompt and settings when supported. Leave blank for a random seed.',
};

export default images;

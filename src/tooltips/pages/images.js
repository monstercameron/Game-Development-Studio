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
  'Fine-tune image':
    'Set exact dimensions, steps and seed, ask for a transparent background, match a reference image’s shape, or describe details to avoid.',
  'Width in pixels':
    'Set the output width from 32 to 2752 pixels. Leave blank to use the selected aspect ratio; values must be multiples of 32. Sizes above about 2 megapixels need far more GPU memory.',
  'Height in pixels':
    'Set the output height from 32 to 2752 pixels. Leave blank to use the selected aspect ratio; values must be multiples of 32. Sizes above about 2 megapixels need far more GPU memory.',
  'Sampling steps':
    'Choose 1–100 generation steps. More steps can improve refinement but take longer; blank uses the selected quality setting.',
  'Negative prompt':
    'Describe elements you want the image to avoid. This is optional and only takes effect when negative prompt guidance is enabled.',
  'Negative prompt guidance':
    'Controls how strongly the render avoids your negative prompt. Must be greater than 1 and at most 10; higher values can increase render time. Blank uses 2.',
  Variations:
    'Queue 2 to 4 renders at once with the same settings and different seeds, so you can compare. Each is a separate render in the queue, labelled “variation 1 of N”. The model itself makes one image per render.',
  LoRA: 'Apply a LoRA (a small add-on file that adds a style or subject) to this render only. Choose from the .safetensors files in models/Qwen-Image-2.1-LoRA. It must be made for Qwen Image 2.1 and needs the peft package in the image app.',
  'LoRA strength':
    'How strongly the LoRA is applied, from 0 to 2. Blank uses 1; lower blends it in more gently.',
  'Reference size target':
    'With “Match the last reference’s shape”, the render is sized to about this side length squared while keeping the reference’s aspect ratio. Blank uses 1024. Larger needs much more GPU memory.',
  'Advanced: KV cache':
    'Reuses the prompt and reference computations on every step, which speeds up edits with references. Turn it off only to compare: the same seed then gives a different but equally valid image.',
  'Advanced: custom sampling schedule':
    'Expert. A comma-separated list of falling sigmas from 1 down, for example 1, 0.8, 0.5, 0.2. Their count replaces Sampling steps. Blank uses the model’s own schedule.',
  'Advanced settings': 'Open the optional seed control for this image render.',
  Seed: 'Enter a whole number to repeat a render: the same prompt, references and settings with the same seed gave an identical image in tests. Leave blank for a random seed, which Forge records with the image.',
};

export default images;

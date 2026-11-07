const videoTooltips = {
  'Describe your scene':
    'Describe the subject, what happens, and any camera movement or atmosphere. This text guides the video render.',
  'Reference images':
    'Add 1–9 PNG, JPEG, or WebP images to guide the video. Each file can be up to 10 MiB, with 40 MiB total.',
  'Add reference images':
    'Choose 1–9 PNG, JPEG, or WebP images to guide the video. Each file can be up to 10 MiB, with 40 MiB total.',
  'Aspect ratio':
    'Choose the shape of the video frame: landscape (16:9), square (1:1), or portrait (9:16). The render uses a fixed resolution for each shape.',
  Duration:
    'Choose an approximate clip length. Longer clips contain more frames and usually take longer to render.',
  'Video quality':
    'Choose how many sampling steps H3 uses to create the video. More steps can add detail but increase render time.',
  'Sampling steps':
    'Set the number of generation steps: fewer steps render faster, while more steps can improve detail. The highest setting takes longest.',
  'Video format': 'Rendered videos are saved as WebM files. The format is fixed for this renderer.',
};

export default videoTooltips;

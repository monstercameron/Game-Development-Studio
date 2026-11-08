const videoTooltips = {
  'Describe your scene':
    'Describe what happens, the camera movement and the sounds: H3 also generates the soundtrack. Refer to your reference images as <Picture 1>, <Picture 2> and so on, in the order they are listed; reference videos and audio as <Video 1> and <Audio 1>.',
  'Reference images':
    'Add 1–9 PNG, JPEG, or WebP images that the video is built from. Each file can be up to 10 MiB, with 40 MiB total. This cannot be combined with a first or last frame.',
  'Add reference images':
    'Choose 1–9 PNG, JPEG, or WebP images that the video is built from. Each file can be up to 10 MiB, with 40 MiB total. They are numbered in order: <Picture 1>, <Picture 2> and so on.',
  'First and last frame':
    'Start the video from one picture and, if you like, end it on another. H3 fills in the motion between them. Reference images, videos and audio cannot be used at the same time. MiniMax trains this into a separate FL2VA checkpoint (not installed); Forge uses a minimax_h3_fl2va file from the H3 model folder when present, otherwise it tries the installed Ref2VA weights, which is untested.',
  'Text only (experimental)':
    'Render from the description alone, with no pictures. H3 is built to work from references, so results can vary.',
  'Choose the first frame':
    'The picture the video starts from. It is cropped to the video shape from the centre, never stretched. PNG, JPEG or WebP up to 10 MiB.',
  'Choose the last frame':
    'Optional. The picture the video should end on. It is cropped to the video shape from the centre. PNG, JPEG or WebP up to 10 MiB.',
  'Also use the sound of the reference videos':
    'Gives H3 the sound track of each reference video as well as its pictures. Every reference video must have sound, or the render stops with a message.',
  'Aspect ratio':
    'Choose the shape of the video frame: landscape 16:9, square, portrait 9:16, photo 4:3, photo portrait 3:4 or cinema 21:9. The exact size also depends on the picture size under Fine-tune video (Standard is 608 × 352 for landscape).',
  Duration:
    'Choose a clip length: about 2, 5, 7, 10, 13 or 15 seconds (56, 124, 175, 243, 311 or 362 frames at 24 frames per second). Longer clips take longer and use more memory; free memory fell below 1 GB on a 5-second render, so keep other programs closed for the longest clips.',
  'Fine-tune video':
    'Optional: picture size, sampling steps, a seed, the turbo adapter, an MP4 copy and experimental sampling controls. The defaults (Standard size, 12 steps, random seed) are the tested combination.',
  'Picture size':
    'Standard (about 0.2 megapixels) is the tested size. Medium, Large and 768p give a sharper picture but need roughly 1.5, 2.5 and 5 times as much work; 768p (1344 × 768 for landscape) is very slow and has not been tested on this PC.',
  'Sampling steps':
    'Set the number of generation steps: 8 renders fastest, 12 is the default, and 20 or 30 can add detail but take longer. With the turbo adapter, 4 steps is the default.',
  Seed: 'Enter a whole number from 0 to 2147483647 to repeat a render: the same description, references and settings with the same seed gave an identical video and soundtrack in tests. Leave it blank for a random seed, which Forge records with the video.',
  'Turbo adapter (experimental)':
    'MiniMax’s 4-step speed adapter, already installed with H3. It renders in 4 steps instead of 12 or more at some cost in detail, and cannot be combined with guidance.',
  'Also save an MP4 (H.264)':
    'WebM (VP8) is poorly supported by game engines and editors. This also saves an MP4 with AAC sound next to the WebM, recorded as a converted copy. You can also convert any video later from its Convert menu.',
  'Negative prompt':
    'Experimental. H3 normally runs without guidance, so there is no negative prompt in MiniMax’s own workflow. Entering one turns guidance on (2 unless you set it), which doubles the render time.',
  Guidance:
    '1 turns guidance off (the default). From 1.1 to 6 the model is run twice per step, so renders take about twice as long and results may look worse.',
  Sampler:
    'Experimental. Leave on Engine default unless you want to try something else; MiniMax’s own workflow uses res_multistep.',
  Scheduler:
    'Experimental. Leave on Engine default unless you want to try something else; MiniMax suggests beta or normal (discrete) over simple.',
  'GPU memory budget (GiB)':
    'How much GPU memory the engine may use to keep weights between steps: 4 to 24, default 6. More can be faster but competes with other models loaded on the GPU.',
  'Reference detail':
    'match scales reference images to the video size (faster). max keeps them at full size, up to a 2048 pixel short edge, for stronger likeness at a much higher cost.',
  'Video format':
    'Rendered videos are saved as WebM files (VP8 video with 32 kHz stereo sound). Turn on “Also save an MP4 (H.264)” or use Convert for an MP4 or GIF.',
};

export default videoTooltips;

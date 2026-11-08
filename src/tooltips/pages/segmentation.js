const segmentation = {
  'What would you like to isolate?':
    'Describe the object or objects to select in the reference image. Short, specific descriptions work best.',
  'Reference image':
    'Choose one PNG, JPEG, or WebP image up to 10 MiB and 20 megapixels. SAM finds the objects you describe in this image.',
  'Choose a reference image':
    'Select one PNG, JPEG, or WebP image from your computer. You must select it again after refreshing the page.',
  'Confidence threshold':
    'Set how confident SAM must be before including a match. Lower values may include more objects; higher values are more selective. Use a value from 0 to 1.',
  'Which matches':
    'SAM often finds several matches. Combine them all, keep only the one it is most sure about, keep only the biggest, or keep a chosen number of the best-scoring ones.',
  'Most matches to keep':
    'How many of the highest-scoring matches to keep, from 1 to 50. If SAM finds fewer, all of them are kept.',
  Export:
    'Choose the picture to save: a transparent cutout, a black-and-white mask, the original with the selection outlined, or a cutout trimmed to the selection.',
  'Transparent PNG':
    'Save the original image with unselected areas made transparent. Selected objects keep their original colors.',
  'Mask PNG': 'Save a black-and-white mask: selected areas are white and everything else is black.',
  'Outline overlay PNG':
    'Save the original image with a colored outline around each selected object. Nothing is made transparent; use it to check what SAM selected.',
  'Cropped cutout PNG':
    'Save a transparent cutout trimmed to the selected objects with a small margin, instead of the full image size. It can also feed a chained 3D render.',
  'Add to render queue':
    'Queue this segmentation for the selected project. A reference image and description are required.',
  'Estimated render time':
    'Shows an estimate when Forge has enough history from similar renders. Actual time can vary.',
  'Recent creations': 'Browse and download segmentation results saved in the selected project.',
  Download: 'Save the selected segmentation result to your computer.',
  Preview: 'Open this saved segmentation result in the preview.',
};

export default segmentation;

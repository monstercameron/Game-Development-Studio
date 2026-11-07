const segmentation = {
  'What would you like to isolate?': 'Describe the object or objects to select in the reference image. Short, specific descriptions work best.',
  'Reference image': 'Choose one PNG, JPEG, or WebP image under 10 MiB. SAM finds the objects you describe in this image.',
  'Choose a reference image': 'Select one PNG, JPEG, or WebP image from your computer. You must select it again after refreshing the page.',
  'Confidence threshold': 'Set how confident SAM must be before including a match. Lower values may include more objects; higher values are more selective. Use a value from 0 to 1.',
  'Export': 'Choose whether the result keeps the selected objects or saves only their black-and-white selection mask.',
  'Transparent PNG': 'Save the original image with unselected areas made transparent. Selected objects keep their original colors.',
  'Mask PNG': 'Save a black-and-white mask: selected areas are white and everything else is black.',
  'Add to render queue': 'Queue this segmentation for the selected project. A reference image and description are required.',
  'Estimated render time': 'Shows an estimate when Forge has enough history from similar renders. Actual time can vary.',
  'Recent creations': 'Browse and download segmentation results saved in the selected project.',
  'Download': 'Save the selected segmentation result to your computer.',
  'Preview': 'Open this saved segmentation result in the preview.',
};

export default segmentation;

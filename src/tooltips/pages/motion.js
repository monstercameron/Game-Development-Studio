const motion = {
  'Motion model':
    'Choose how to create motion: HY-Motion makes a human BVH clip from text; MotionBricks makes a transition from poses in a SOMA BVH file.',
  'Describe the motion':
    'Describe the action, pace, and style you want HY-Motion to generate. It creates a 30 fps skeletal BVH clip; it does not rig or retarget a character.',
  'Duration in seconds':
    'Set the HY-Motion clip length from 1 to 12 seconds. Longer clips take more time and memory.',
  'Sampling steps':
    'Set how many refinement steps HY-Motion uses, from 1 to 100. More steps can take longer.',
  Guidance:
    'Set how closely HY-Motion follows your description, from 0 to 20. Higher guidance can constrain the motion more strongly.',
  'Advanced settings': 'Open the optional seed setting for HY-Motion.',
  Seed: 'Use the same number with the same prompt and settings to help reproduce an HY-Motion result. Leave blank to use the default seed.',
  'SOMA motion clip':
    'Choose the source BVH motion file for MotionBricks. It must use a Y-up SOMA skeleton in centimeters, be 30, 60, or 120 fps, and be no larger than 10 MiB.',
  'Choose a SOMA BVH file':
    'Select a BVH motion clip. MotionBricks uses its poses to create a transition; it does not rig or retarget a character.',
  'Remove pose file': 'Clear the selected BVH file so you can choose another one.',
  'Starting window':
    'Choose the zero-based frame where MotionBricks reads the starting pose window. Frame numbers use a 30 fps timebase, and the window needs four frames.',
  'Target window':
    'Choose the zero-based frame where MotionBricks reads the target pose window. Frame numbers use a 30 fps timebase, and the window needs four frames.',
  'Minimum length tokens':
    'Set the shortest generated transition length. One token represents four frames; choose a value from 6 to 16.',
  'Target poses to use':
    'Choose how many of the four target-window poses MotionBricks reads, from 1 to 4. The first pose sets the destination; more poses add velocity and acceleration.',
  Variations:
    'Queue 1 to 4 HY-Motion clips as separate jobs. Each uses the next seed after the seed above, or its own random seed when the seed is blank.',
  'Maximum length tokens':
    'Set the longest generated transition length. One token represents four frames; choose a value from 6 to 16 and no less than the minimum.',
};

export default motion;

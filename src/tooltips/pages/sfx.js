export default {
  'Describe the sound':
    'Describe the sound you want, including its source, texture, timing, and surroundings.',
  Duration: 'Choose the target length for the generated sound effect.',
  Quality:
    'Choose how many generation steps to use. Medium is tuned for 8 steps, so Draft is faster and Detailed takes longer without always sounding better.',
  'Duration in seconds':
    'Set a custom length in seconds (1 to 380). It replaces the Duration preset above.',
  'Generation steps':
    'Set a custom number of generation steps. This overrides the quality preset above.',
  'Start from an existing sound':
    'Begin from a sound already in a project: make a variation of it, replace one part of it, or continue it. Forge copies the sound when you choose it. Replace and Continue re-render the whole sound, so the part you keep follows the source closely but is not an exact copy.',
  'Change amount':
    'How far a variation may move from the source sound, from 0.05 to 1. Low stays close to the source; 1 ignores it. Blank uses 0.9.',
  'Replace from (seconds)':
    'Where the part to regenerate starts, in seconds from the beginning of the source sound.',
  'Replace to (seconds)':
    'Where the part to regenerate ends. It must be after the start and inside the sound duration.',
  Seed: 'Enter a whole number to repeat a render: the same prompt and settings with the same seed gave an identical sound in tests. Leave it blank for a random seed, which Forge records with the sound.',
};

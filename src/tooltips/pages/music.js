export default {
  'Describe the sound and style':
    'Describe the genre, instruments, mood, and how the music should develop. This text guides YuE2’s musical style.',
  Lyrics:
    'Enter the words to sing, with optional section tags such as [Verse] or [Chorus]. Lyrics are required; use [Instrumental] for instrumental music.',
  Duration: 'Set the target length of the track. YuE2 may finish before it reaches this duration.',
  'Duration in seconds':
    'Set a custom target length in seconds. Leave it blank to use the duration preset; the track may finish earlier.',
  Direction:
    'Choose how YuE2 plans the music: a full arrangement, a melody-focused result, or no planning mode.',
  'Synthesis steps':
    'Set how many synthesis steps YuE2 uses. More steps can take longer; the effect on sound quality depends on the model.',
  'Guidance scale':
    'Adjust how strongly YuE2 follows your style and lyrics. The default is automatic; a value other than 1 also enables “Style to avoid.”',
  'Track title': 'Add an optional title for the track.',
  'Style to avoid':
    'List instruments or styles you want YuE2 to steer away from. This takes effect only when Guidance scale is not 1.',
  Seed: 'Use the same seed with the same settings to help reproduce a result. Leave it blank for a new random seed; results may still vary.',
};

export default {
  'Describe the sound and style':
    'Describe the genre, instruments, mood, and how the music should develop. This text guides YuE2’s musical style.',
  Lyrics:
    'Enter the words to sing, with optional section tags such as [Verse] or [Chorus]. Lyrics are required; use [Instrumental] for instrumental music.',
  Duration: 'Set the target length of the track. YuE2 may finish before it reaches this duration.',
  'Duration in seconds':
    'Set a custom target length in seconds (1 to 600). It replaces the Duration preset above; the track may finish earlier.',
  Planning:
    'Full arrangement writes a chord-annotated score before the song, Melody writes a melody-only score, and Off skips planning for a faster but less structured result.',
  'Synthesis steps':
    'Set how many synthesis steps YuE2 uses. More steps can take longer; the effect on sound quality depends on the model.',
  'Guidance scale':
    'Adjust how strongly YuE2 follows your style and lyrics. The default is automatic; a value other than 1 also enables “Style to avoid.”',
  'Track title': 'Add an optional title for the track.',
  'Style to avoid':
    'List instruments or styles you want YuE2 to steer away from. This takes effect only when Guidance scale is not 1.',
  Seed: 'Enter a whole number to repeat a render: the same style, lyrics and settings with the same seed gave an identical track in tests. Leave it blank for a random seed, which Forge records with the track.',
  'ABC score':
    'Paste a melody in ABC notation and YuE2 builds the song around it instead of writing its own score. Requires Planning set to Full arrangement or Melody.',
  Temperature:
    'How adventurous song-token sampling is, from 0 to 5. The YuE2 default is 1; lower values are steadier and higher values are more varied.',
  'Top-p':
    'Nucleus sampling, above 0 up to 1. Only the likeliest choices that add up to this share are considered. The YuE2 default is 0.95.',
  'Top-k':
    'Limits each sampling step to the k likeliest choices (1 to 1000). The YuE2 default is 100.',
  'Repetition penalty':
    'Discourages repeating recent tokens, from 1 (off) to 2. The YuE2 default is 1.2.',
};

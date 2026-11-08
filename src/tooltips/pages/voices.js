export default {
  Project: 'Choose where the generated voice file will be saved.',
  'What should your character say?':
    'Enter the dialogue to turn into speech. The selected voice and language shape the finished audio.',
  Voice:
    'Choose one of nine preset speakers. Each can speak every language, but sounds best in its native one. Preset voices use the CustomVoice checkpoint; cloning and design use their own checkpoints.',
  'Preset voice':
    'Speak with one of the nine built-in speakers, with optional voice direction. Uses the CustomVoice checkpoint, which is installed with the speech worker.',
  'Clone a voice':
    'Copy the voice in a short reference clip (3 to 30 seconds) and speak new text in it. Needs the Base checkpoint (tts-base) and the clip’s exact transcript.',
  'Design a voice':
    'Create a new voice from a written description, then speak your text in it. Needs the VoiceDesign checkpoint (tts-voicedesign).',
  'Voice description':
    'Describe the voice in up to 500 characters: age, gender, tone, accent, pace and emotion. Each render with the same description and seed repeats; without a seed, the voice can vary.',
  'Reference transcript (required)':
    'The exact words spoken in the reference clip. Cloning uses the transcript with the audio to match the voice, so a wrong or partial transcript lowers the match. Up to 1,000 characters.',
  'Only clone voices you have the right to use.':
    'Confirm that you have permission to use this person’s voice. Forge requires this before queuing a clone.',
  Ryan: 'Dynamic, rhythmic English-speaking male voice. Best for English dialogue.',
  Aiden: 'Sunny American English-speaking male voice with a clear midrange.',
  Vivian: 'Bright, slightly edgy young female voice. Native language: Chinese.',
  Serena: 'Warm, gentle young female voice. Native language: Chinese.',
  Uncle_Fu: 'Seasoned male voice with a low, mellow timbre. Native language: Chinese.',
  Dylan: 'Youthful male voice with a Beijing accent. Native language: Chinese.',
  Eric: 'Lively male voice with a Sichuan accent. Native language: Chinese.',
  Ono_Anna: 'Playful female voice with a light, nimble timbre. Native language: Japanese.',
  Sohee: 'Warm female voice with rich emotion. Native language: Korean.',
  Language: 'Choose the language for the spoken text. Auto lets the model identify it.',
  Auto: 'Let the model identify the language from your dialogue.',
  English: 'Generate speech in English.',
  Chinese: 'Generate speech in Chinese.',
  Japanese: 'Generate speech in Japanese.',
  Korean: 'Generate speech in Korean.',
  German: 'Generate speech in German.',
  French: 'Generate speech in French.',
  Russian: 'Generate speech in Russian.',
  Portuguese: 'Generate speech in Portuguese.',
  Spanish: 'Generate speech in Spanish.',
  Italian: 'Generate speech in Italian.',
  'Voice direction': 'Add optional guidance for the delivery, such as tone, pace, or personality.',
  'Fine-tune voice':
    'Optional speech length, variation (temperature, top-p, top-k, repetition penalty) and seed controls.',
  'Speech token limit':
    'Set the maximum tokens used to generate speech, from 64 to 4,096 (about 12.5 tokens per second). Speech that reaches the limit stops mid-sentence.',
  'Add to render queue':
    'Queue the dialogue for voice generation using the selected voice, language, and direction.',
  'Live speech to text':
    'Transcribe speech from your microphone or an audio file with the local English speech recognition model.',
  'Start microphone':
    'Ask for microphone access and transcribe your speech live. Recording begins only after access is granted.',
  'Choose audio file': 'Select an audio file up to two minutes and 25 MiB to transcribe.',
  'Stop & finish': 'Stop recording and wait for the final transcript to appear.',
  Cancel: 'Stop the current recording or transcription and discard its unfinished text.',
  'Copy text': 'Copy the completed transcript to your clipboard.',
  'Recognition options': 'Choose punctuation, word timing and latency for the speech recognizer.',
  'Sampling mode':
    'Sample gives varied takes; Greedy always picks the likeliest speech token, so temperature, top-p and top-k have no effect. Blank uses the model default (sampling).',
  'Fine-detail sampling':
    'Switches sampling on or off for the second-stage model that fills in each frame’s fine acoustic detail. Greedy is repeatable but flatter.',
  'Fine-detail temperature':
    'Randomness of the fine-detail stage, 0.05 to 2. The model default is 0.9; lower is cleaner, higher adds texture.',
  'Fine-detail top-p':
    'Nucleus sampling for the fine-detail stage, above 0 up to 1. The model default is 1.',
  'Fine-detail top-k':
    'Limits the fine-detail stage to the k likeliest choices (1 to 1000). The model default is 50.',
  'Use as voice text':
    'Put the transcript into the voice dialogue field. Voice renders accept up to 1,000 characters.',
};

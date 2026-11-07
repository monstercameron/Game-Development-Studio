export default {
  'Describe the current game state': 'Describe what is happening in the game. This text is sent to Mammoth as the context for its decision.',
  'Question type': 'Choose the kind of answer Mammoth should return: select one choice, score among levels, or estimate the chance of yes.',
  'Response': 'Choose what to display after the decision. Structured shows the full response and metrics; Compact shows only the answers. This does not change the decision.',
  'Question and choices': 'Enter the question on the first line, then at least two choices or score levels on separate lines. Numbered entries are allowed. Choice supports up to 255 options; Score supports up to 10 levels.',
  'Question': 'Ask a yes-or-no question. Mammoth returns its probability for yes.',
  'Start / load Mammoth': 'Start the managed Mammoth service and load its model so it can answer decisions.',
  'Stop managed Mammoth': 'Stop the Mammoth service managed by this studio.',
  'Run decision': 'Send the game state and question to Mammoth and show its answer. The service must be running with the model loaded.',
  'Copy displayed result': 'Copy the result currently shown, using the selected response format.',
};

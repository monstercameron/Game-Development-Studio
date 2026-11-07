// Build only request shapes accepted by the local Mammoth System One service.
export function gameDecisionRequest(draft) {
  if (typeof draft?.prompt !== 'string' || !draft.prompt.trim()) {
    throw Error('Enter a game state.');
  }
  if (typeof draft.second !== 'string' || !draft.second.trim()) {
    throw Error('Enter a question.');
  }
  const mode = draft.options?.[0];
  let question;
  if (mode === 'Yes / No') {
    question = { type: 'noul', instructions: draft.second.trim() };
  } else if (mode === 'Choice' || mode === 'Score') {
    const lines = draft.second
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length < 3) {
      throw Error(
        'Enter a question followed by at least two choices or score levels on separate lines.',
      );
    }
    const values = lines.slice(1).map((line) => line.replace(/^\d+[.)]\s*/, '').trim());
    if (values.some((value) => !value)) {
      throw Error('Every choice or score level needs a description.');
    }
    if (mode === 'Score' && values.length > 10) {
      throw Error('Score questions support up to 10 levels.');
    }
    if (mode === 'Choice' && values.length > 255) {
      throw Error('Choice questions support up to 255 choices.');
    }
    question =
      mode === 'Score'
        ? { type: 'score', instructions: lines[0], criteria: values }
        : {
            type: 'choice',
            instructions: lines[0],
            criteria: Object.fromEntries(
              values.map((value, index) => [`option_${index + 1}`, value]),
            ),
          };
  } else {
    throw Error('Choose a supported question type.');
  }
  return { model: 'mammoth-1', state: draft.prompt, questions: { decision: question } };
}

// The selector changes presentation only; it never changes model inference.
export function presentGameDecision(result, format) {
  return format === 'Compact' && result?.answers ? result.answers : result;
}

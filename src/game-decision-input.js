// Mammoth System One allows up to 16 named questions per request; each question shares one prefill.
export const MAX_GAME_QUESTIONS = 16;

/**
 * Builds one System One question from a question type and its text (first line is the question).
 *
 * @param {'Yes / No' | 'Choice' | 'Score'} mode Question type as shown in the UI.
 * @param {string} text Question on the first line, then one choice or score level per line.
 * @returns {{ type: string, instructions: string, criteria?: object }} Request question shape.
 * @throws {Error} When the text is empty, the mode is unsupported, or the choice or score
 *   count is outside the limits the Mammoth service accepts.
 */
export function gameQuestion(mode, text) {
  if (mode === 'Yes / No') {
    if (typeof text !== 'string' || !text.trim()) {
      throw Error('Enter a question.');
    }
    return { type: 'noul', instructions: text.trim() };
  }
  if (mode !== 'Choice' && mode !== 'Score') {
    throw Error('Choose a supported question type.');
  }
  if (typeof text !== 'string' || !text.trim()) {
    throw Error('Enter a question.');
  }
  const lines = text
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
  if (mode === 'Score') {
    if (values.length > 10) {
      throw Error('Score questions support up to 10 levels.');
    }
    return { type: 'score', instructions: lines[0], criteria: values };
  }
  if (values.length > 255) {
    throw Error('Choice questions support up to 255 choices.');
  }
  return {
    type: 'choice',
    instructions: lines[0],
    criteria: Object.fromEntries(values.map((value, index) => [`option_${index + 1}`, value])),
  };
}

// Build only request shapes accepted by the local Mammoth System One service.
// extraQuestions adds further questions about the same state: [{ mode, text }, ...].
export function gameDecisionRequest(draft, extraQuestions = []) {
  if (typeof draft?.prompt !== 'string' || !draft.prompt.trim()) {
    throw Error('Enter a game state.');
  }
  if (typeof draft.second !== 'string' || !draft.second.trim()) {
    throw Error('Enter a question.');
  }
  const questions = { decision: gameQuestion(draft.options?.[0], draft.second) };
  if (extraQuestions.length + 1 > MAX_GAME_QUESTIONS) {
    throw Error(`Use at most ${MAX_GAME_QUESTIONS} questions per request.`);
  }
  extraQuestions.forEach((extraQuestion, index) => {
    const name = `decision_${index + 2}`;
    try {
      questions[name] = gameQuestion(extraQuestion?.mode, extraQuestion?.text);
    } catch (error) {
      throw Error(`Question ${index + 2}: ${error.message}`, { cause: error });
    }
  });
  return { model: 'mammoth-1', state: draft.prompt, questions };
}

// The selector changes presentation only; it never changes model inference.
export function presentGameDecision(result, format) {
  return format === 'Compact' && result?.answers ? result.answers : result;
}

// Plain-language summary of one answer, derived from the same question and response.
// Returns null when the response does not contain a recognised answer.
export function decisionSummary(result, request) {
  const decision = result?.answers?.decision;
  const question = request?.questions?.decision;
  if (!decision || !question) {
    return null;
  }
  const percent = (value) =>
    Number.isFinite(value) ? `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%` : null;
  if (decision.type === 'noul') {
    const yes = percent(decision.noul);
    return yes
      ? { title: `Yes: ${yes}`, detail: 'Probability that the answer to the question is yes.' }
      : null;
  }
  if (decision.type === 'choice') {
    const label = question.criteria?.[decision.choice] ?? decision.choice;
    if (typeof label !== 'string' || !label) {
      return null;
    }
    const probability = percent(decision.probabilities?.[decision.choice]);
    const confidence = percent(decision.confidence);
    return {
      title: `Selected: ${label}`,
      detail: [
        probability && `probability ${probability}`,
        confidence && `confidence ${confidence}`,
      ]
        .filter(Boolean)
        .join(' · '),
    };
  }
  if (decision.type === 'score' && Number.isFinite(decision.score)) {
    return {
      title: `Score: ${decision.score.toFixed(2)}`,
      detail: `Scored against the ${question.criteria?.length ?? 0} levels you listed.`,
    };
  }
  return null;
}

// One entry per question in the request, in request order: { name, summary }.
export function decisionSummaries(result, request) {
  return Object.keys(request?.questions || {}).map((name) => ({
    name,
    summary: decisionSummary(
      { answers: { decision: result?.answers?.[name] } },
      { questions: { decision: request.questions[name] } },
    ),
  }));
}

// Detail line under the Mammoth status. Only a service that is answering can have been "started
// outside Forge"; a stopped service has nothing for Forge to leave running.
export function mammothStateDetail(service, statusError = '') {
  if (statusError) {
    return statusError;
  }
  if (service?.managed === false && service.state === 'error') {
    return 'Check the Mammoth application for the load failure. Forge cannot manage this service.';
  }
  if (service?.managed === false && service.status === 'reachable') {
    return 'Started outside Forge. Forge will leave this service running when you stop it.';
  }
  if (service?.managed) {
    return service.state === 'error'
      ? 'Stop the managed service, then start Mammoth again to retry the load.'
      : 'Managed by Forge. Stop only unloads the managed Mammoth service.';
  }
  return 'Start or load Mammoth before running a decision.';
}

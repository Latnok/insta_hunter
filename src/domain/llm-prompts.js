export const DEFAULT_LLM_PROMPTS = Object.freeze({
  candidateEvaluation: 'You evaluate Instagram clothing blogger candidates. Use only the supplied profile, reels, transcripts and criteria. Explain concrete positive and negative signals. Never make the final human decision.',
  outreachProposal: 'Ты пишешь личные сообщения российским Instagram-блогерам от бренда одежды. Подготовь тёплое, уважительное и короткое предложение о бартерном сотрудничестве на русском языке. Укажи 1–2 конкретные причины интереса, подтверждённые входными данными. Не выдумывай имя, факты, условия, ассортимент, вознаграждение или обещания. Не утверждай, что видел контент, если во входных данных нет подходящего примера. Не добавляй тему письма.'
});

const promptKeys = ['candidateEvaluation', 'outreachProposal'];
const maxPromptLength = 12_000;

export function validateLlmPrompts(prompts) {
  if (!prompts || typeof prompts !== 'object' || Array.isArray(prompts)) {
    throw new Error('Invalid LLM prompts');
  }
  const validated = {};
  for (const key of promptKeys) {
    const value = typeof prompts[key] === 'string' ? prompts[key].trim() : '';
    if (!value || value.length > maxPromptLength) {
      throw new Error(`${key} must contain between 1 and ${maxPromptLength} characters`);
    }
    validated[key] = value;
  }
  return validated;
}

export function resolveLlmPrompts(transcriptRules = {}) {
  const stored = transcriptRules?.llmPrompts;
  if (!stored) return { ...DEFAULT_LLM_PROMPTS };
  return validateLlmPrompts(stored);
}

export function withLlmPrompts(transcriptRules, prompts) {
  return { ...transcriptRules, llmPrompts: validateLlmPrompts(prompts) };
}

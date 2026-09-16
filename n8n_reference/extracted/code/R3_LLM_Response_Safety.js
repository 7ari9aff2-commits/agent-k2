// R3: LLM response safety - sanitize raw LLM output before downstream parsing
// Strips reasoning blocks (DeepSeek-R1 <think>), markdown code fences, and other artifacts
// Audit fix: null-safe $input.first() so upstream 0-items doesn't crash the chain.
const first = $input.first();
const data = (first && first.json) || {};
let raw = '';
if (typeof data.output === 'string') raw = data.output;
else if (data.output && typeof data.output === 'object') raw = data.output.text || data.output.output || JSON.stringify(data.output);
else if (typeof data.text === 'string') raw = data.text;

const original = raw;
const hadReasoning = /<think>[\s\S]*?<\/think>/i.test(raw) || /<reasoning>[\s\S]*?<\/reasoning>/i.test(raw);
raw = raw.replace(/<think>[\s\S]*?<\/think>/gi, '');
raw = raw.replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '');
raw = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '');
raw = raw.replace(/^[\s\n]+/, '').replace(/[\s\n]+$/, '');

data.output = raw;
data.text = raw;
data.p17_llm_safety = { original_length: original.length, sanitized_length: raw.length, had_reasoning: hadReasoning, stripped_chars: original.length - raw.length };
return { json: data };

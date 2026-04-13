import { generateText, ModelMessage, ToolSet, stepCountIs } from 'ai';
import { google } from '@ai-sdk/google';
import { anthropic } from '@ai-sdk/anthropic';

type Provider = 'gemini' | 'claude' | 'error';

interface CallLLMOptions {
  systemPrompt: string;
  messages: ModelMessage[];
  tools?: ToolSet;
  maxSteps?: number;
}

interface CallLLMResult {
  text: string;
  toolCalls: unknown[];
  toolResults: unknown[];
  provider: Provider;
}

const CANNED_RESPONSE: CallLLMResult = {
  text: "Having trouble pulling your numbers right now. Try again in a bit.",
  toolCalls: [],
  toolResults: [],
  provider: 'error' as const,
};

export async function callLLM({
  systemPrompt,
  messages,
  tools,
  maxSteps = 1,
}: CallLLMOptions): Promise<CallLLMResult> {
  // Primary: Google Gemini
  try {
    const result = await generateText({
      model: google('gemini-2.0-flash'),
      system: systemPrompt,
      messages,
      tools,
      stopWhen: stepCountIs(maxSteps),
    });

    return {
      text: result.text,
      toolCalls: result.toolCalls,
      toolResults: result.toolResults,
      provider: 'gemini',
    };
  } catch (err) {
    console.error('[callLLM] Gemini failed, falling back to Claude:', err);
  }

  // Fallback: Anthropic Claude
  try {
    const result = await generateText({
      model: anthropic('claude-sonnet-4-20250514'),
      system: systemPrompt,
      messages,
      tools,
      stopWhen: stepCountIs(maxSteps),
    });

    return {
      text: result.text,
      toolCalls: result.toolCalls,
      toolResults: result.toolResults,
      provider: 'claude',
    };
  } catch (err) {
    console.error('[callLLM] Claude also failed:', err);
  }

  // Both providers failed
  return CANNED_RESPONSE;
}

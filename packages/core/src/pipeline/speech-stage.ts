/**
 * Speech stage: answer text in, spoken chunks out. Wraps the sentence chunker and one
 * SpeechOutput, and reports when the first chunk went to the voice and when audio started.
 */

import { SentenceChunker } from '../sentence-chunker.js';
import type { SpeechOutput } from '../speech.js';

export interface SpeechStageHooks {
  /** The first speakable chunk was handed to the voice. */
  onFirstSpeech?(): void;
}

export class SpeechStage {
  private readonly chunker: SentenceChunker;
  private spoke = false;

  constructor(
    readonly output: SpeechOutput,
    private readonly hooks: SpeechStageHooks = {},
    chunker = new SentenceChunker(),
  ) {
    this.chunker = chunker;
  }

  /** Feed answer text as it streams. */
  push(text: string): void {
    for (const chunk of this.chunker.push(text)) this.say(chunk);
  }

  /** The answer is complete: flush the last chunk and tell the voice nothing else is coming. */
  end(): void {
    for (const chunk of this.chunker.end()) this.say(chunk);
    this.output.end();
  }

  stop(): void {
    this.output.stop();
  }

  get done(): Promise<void> {
    return this.output.done;
  }

  private say(chunk: string): void {
    if (!this.spoke) {
      this.spoke = true;
      this.hooks.onFirstSpeech?.();
    }
    this.output.say(chunk);
  }
}

import { describe, expect, it } from 'vitest';
import { LatencyRecorder, percentile, stageStats } from './latency.js';

describe('LatencyRecorder', () => {
  it('computes the plan §3.3 spans', () => {
    const r = new LatencyRecorder('i1', () => 0);
    r.mark('keyDown', 1000);
    r.mark('recordingStarted', 1030);
    r.mark('keyUp', 3000);
    r.mark('transcriptFinal', 3250);
    r.mark('firstToken', 3700);
    r.mark('firstPoint', 3710);
    r.mark('firstAudio', 4050);
    r.mark('done', 7000);
    expect(r.summary()).toMatchObject({
      interactionId: 'i1',
      recordingStartMs: 30,
      transcriptMs: 250,
      firstTokenMs: 450,
      tokenToAudioMs: 350,
      keyUpToFirstAudioMs: 1050,
      keyUpToPointMs: 710,
      totalMs: 6000,
    });
  });

  it('splits the answer path into per-stage spans', () => {
    const r = new LatencyRecorder('i3', () => 0);
    r.mark('keyDown', 0);
    r.mark('sttReady', 120);
    r.mark('keyUp', 2000);
    r.mark('transcriptFinal', 2200);
    r.mark('requestSent', 2210);
    r.mark('firstToken', 2600);
    r.mark('firstSpeech', 2750);
    r.mark('firstAudio', 2950);
    expect(r.summary()).toMatchObject({
      sttConnectMs: 120,
      keyUpToRequestMs: 210,
      modelFirstTokenMs: 390,
      tokenToSpeechMs: 150,
      speechToAudioMs: 200,
      keyUpToFirstAudioMs: 950,
    });
  });

  it('counts a request sent before key-up (speculation) as 0 ms after key-up', () => {
    const r = new LatencyRecorder('i4', () => 0);
    r.mark('requestSent', 900);
    r.mark('keyUp', 1000);
    expect(r.summary().keyUpToRequestMs).toBe(0);
  });

  it('records metadata, the first failure and a bounded event log', () => {
    let t = 0;
    const r = new LatencyRecorder('i5', () => t);
    r.setMeta('chat', 'anthropic');
    r.setFailure({ stage: 'answer', kind: 'auth', provider: 'anthropic' });
    r.setFailure({ stage: 'speech', kind: 'network' });
    t = 42;
    r.event('stt', 'connected', { provider: 'assemblyai' });
    for (let i = 0; i < 500; i++) r.event('answer', 'token');
    const s = r.summary();
    expect(s.meta).toEqual({ chat: 'anthropic' });
    expect(s.failure).toEqual({ stage: 'answer', kind: 'auth', provider: 'anthropic' });
    expect(r.events()[0]).toEqual({ t: 42, stage: 'stt', name: 'connected', data: { provider: 'assemblyai' } });
    expect(r.events().length).toBe(200);
  });

  it('keeps the first occurrence and leaves missing spans null', () => {
    let t = 0;
    const r = new LatencyRecorder('i2', () => t);
    r.mark('keyUp');
    t = 100;
    r.mark('firstToken');
    t = 200;
    r.mark('firstToken');
    expect(r.get('firstToken')).toBe(100);
    expect(r.summary().keyUpToFirstAudioMs).toBeNull();
  });
});

describe('percentile', () => {
  it('uses nearest rank', () => {
    const v = [5, 1, 4, 2, 3];
    expect(percentile(v, 50)).toBe(3);
    expect(percentile(v, 95)).toBe(5);
    expect(percentile(v, 0)).toBe(1);
    expect(percentile([], 50)).toBeNull();
  });
});

describe('stageStats', () => {
  it('computes p50/p95 per metric and skips missing values', () => {
    const rows = [
      { keyUpToFirstAudioMs: 900, modelFirstTokenMs: 400 },
      { keyUpToFirstAudioMs: 1100, modelFirstTokenMs: null },
      { keyUpToFirstAudioMs: 700 },
    ];
    const s = stageStats(rows);
    expect(s.keyUpToFirstAudioMs).toEqual({ n: 3, p50: 900, p95: 1100 });
    expect(s.modelFirstTokenMs).toEqual({ n: 1, p50: 400, p95: 400 });
    expect(s.speechToAudioMs).toEqual({ n: 0, p50: null, p95: null });
  });
});

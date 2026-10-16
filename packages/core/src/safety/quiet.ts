/**
 * The quiet gate: when the user is on a call, sharing or presenting their screen, or has Focus
 * (Do Not Disturb) on, Clicky starts nothing by itself (queued tasks, spoken announcements,
 * suggestions). It still answers when the user holds the key. Pure: the app gathers the signals.
 */

export interface QuietSignals {
  /** Open window titles. */
  windows: readonly string[];
  /** Another app is using the microphone (a call app usually is). */
  micInUseByOtherApp?: boolean;
  /** The camera is on. */
  cameraInUse?: boolean;
  /** Windows Focus / Do Not Disturb is on. */
  focusOn?: boolean;
  /** An app in front is full screen (a presentation, a game, a video call). */
  fullscreenInFront?: boolean;
  /** The screen is being shared or recorded (a sharing toolbar or recording indicator is up). */
  screenShared?: boolean;
}

export type QuietVerdict = { quiet: false } | { quiet: true; reason: string };

/** Windows that mean a call or meeting is going on. */
const CALL_WINDOW =
  /\b(zoom meeting|meeting|in call|call with|ongoing call|google meet|meet\.google\.com|teams.*\b(call|meeting)\b|webex|skype call|discord.*voice|facetime|whatsapp.*call|slack huddle|huddle)\b/i;
/** Windows that mean the screen is being shown to others. */
const SHARE_WINDOW =
  /\b(you are (?:screen )?sharing|is sharing your screen|screen sharing|stop sharing|presenting|presenter view|slide ?show|obs studio|recording)\b/i;

export function quietVerdict(s: QuietSignals): QuietVerdict {
  if (s.screenShared) return { quiet: true, reason: 'your screen is being shared' };
  const share = s.windows.find((w) => SHARE_WINDOW.test(w));
  if (share) return { quiet: true, reason: `your screen may be shared ("${share.slice(0, 60)}")` };
  const call = s.windows.find((w) => CALL_WINDOW.test(w));
  if (call) return { quiet: true, reason: `you're on a call ("${call.slice(0, 60)}")` };
  if (s.micInUseByOtherApp) return { quiet: true, reason: 'another app is using the microphone' };
  if (s.cameraInUse) return { quiet: true, reason: 'the camera is on' };
  if (s.focusOn) return { quiet: true, reason: 'Focus (Do not disturb) is on' };
  if (s.fullscreenInFront) return { quiet: true, reason: 'an app is full screen' };
  return { quiet: false };
}

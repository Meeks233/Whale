// Map yt-dlp's PER-STREAM download percent onto one monotonic ring fraction.
//
// A `bv*+ba` download runs two passes, each reported 0→100%: the video-only
// stream, then the audio-only stream (the backend tags them via `phase`). Naively
// holding the max pins the ring at its running cap the instant the VIDEO stream
// finishes and then freezes it there for the whole AUDIO pass — the "stuck at 95%"
// bug. Splitting the ring into contiguous phase bands (video → [0,85], audio →
// [85,cap]) keeps it climbing across the transition and only nears full at true
// completion. A progressive single file (no phase) or an audio-only download maps
// straight through, capped at `cap`.
//
// `sawVideo` is the caller's memory that a video phase has been seen this download,
// so an "audio" frame is recognised as the tail of a two-stream job rather than an
// audio-only download (which should map straight through).
export function ringPercentForPhase(
  percent: number,
  phase: string | null | undefined,
  sawVideo: boolean,
  cap: number,
): number {
  const p = Math.max(0, Math.min(percent, 100));
  if (phase === 'video') return Math.min(p * 0.85, cap); // video stream → [0, 85]
  if (phase === 'audio' && sawVideo) return Math.min(85 + p * 0.1, cap); // audio tail → [85, cap]
  return Math.min(p, cap); // progressive single file, or audio-only download
}

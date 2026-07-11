# CallChat ZMath media E2EE

CallChat's hosted web client can require an additional ZMath factor for live
audio, video, and screen-sharing frames. This profile extends Element Call's
existing MatrixRTC per-participant encryption; it does not replace MatrixRTC,
WebRTC, or LiveKit.

## Key path

1. The CallChat parent client derives a session root from the passphrase and
   SHA-256 hash of the exact pattern image using PBKDF2-SHA-256 (600,000
   iterations) and HKDF-SHA-256.
2. It derives a separate 256-bit factor for each Matrix room with
   HKDF-SHA-256.
3. Element Call combines that room factor with every rotating MatrixRTC sender
   key using HKDF-SHA-256. The participant identity and MatrixRTC key index are
   included as derivation context.
4. The resulting non-extractable key material is passed to LiveKit's frame
   E2EE worker for audio, video, and screen sharing.

Both the normal MatrixRTC key and the ZMath factor are required to reproduce a
frame key. A different passphrase, pattern image, room, participant, rotating
MatrixRTC key, or key index produces different key material.

## Secret handling

- The factor is not placed in a URL, Matrix event, widget data, local storage,
  server request, or telemetry payload.
- The same-origin CallChat parent prepares it in memory before launching the
  call. The embedded call reads it directly from that parent.
- The parent zeroes its byte arrays when ZMath is locked, Matrix-only mode is
  enabled, or a new session is unlocked.
- The hosted client blocks call startup if the required bridge is missing,
  locked, or disabled.
- Existing Element Call password parameters are redacted from URL-parameter
  diagnostic logs by this fork.

## Compatibility and limits

This custom profile is currently interoperable only between CallChat web
clients that include the matching media-key implementation. An unmodified
Element or Matrix client cannot decrypt a ZMath-protected CallChat call.

This is classical authenticated media encryption built from Web Crypto,
MatrixRTC, and LiveKit frame E2EE. It is not a post-quantum key exchange and it
does not claim quantum security. Independent cryptographic review is still
required before treating this experimental profile as a high-assurance
security product.

The focused tests are in `src/e2ee/matrixKeyProvider.test.ts`.

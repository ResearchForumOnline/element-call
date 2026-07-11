# CallChat ZMath media E2EE

CallChat's hosted web client can require an additional ZMath factor for live
audio, video, and screen-sharing frames. This profile extends Element Call's
existing MatrixRTC per-participant encryption; it does not replace MatrixRTC,
WebRTC, or LiveKit.

## Protection model

The CallChat parent prepares a room-scoped factor from the passphrase and exact
pattern. Element Call combines that factor with the rotating MatrixRTC media
key path before LiveKit's frame E2EE worker encrypts audio, video, and screen
sharing.

Both the normal MatrixRTC media context and the ZMath factor are required. The
public documentation describes this security boundary without publishing
private ZMath policy or deployment material.

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

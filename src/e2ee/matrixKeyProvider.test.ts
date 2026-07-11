/*
Copyright 2024 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { describe, expect, test, vi } from "vitest";
import {
  type MatrixRTCSession,
  MatrixRTCSessionEvent,
} from "matrix-js-sdk/lib/matrixrtc";
import { KeyProviderEvent } from "livekit-client";

import {
  deriveZMathMediaKeyBytes,
  MatrixKeyProvider,
} from "./matrixKeyProvider";

function mockRTCSession(): MatrixRTCSession {
  return {
    on: vi.fn(),
    off: vi.fn(),
    reemitEncryptionKeys: vi.fn(),
  } as unknown as MatrixRTCSession;
}

describe("matrixKeyProvider", () => {
  test("initializes", () => {
    const keyProvider = new MatrixKeyProvider();
    expect(keyProvider).toBeTruthy();
  });

  test("listens for key requests and emits existing keys", () => {
    const keyProvider = new MatrixKeyProvider();

    const session = mockRTCSession();

    keyProvider.setRTCSession(session);

    expect(session.on).toHaveBeenCalledWith(
      MatrixRTCSessionEvent.EncryptionKeyChanged,
      expect.any(Function),
    );
    expect(session.off).not.toHaveBeenCalled();
  });

  test("stops listening when session changes", () => {
    const keyProvider = new MatrixKeyProvider();

    const session1 = mockRTCSession();
    const session2 = mockRTCSession();

    keyProvider.setRTCSession(session1);
    expect(session1.off).not.toHaveBeenCalled();

    keyProvider.setRTCSession(session2);
    expect(session1.off).toHaveBeenCalledWith(
      MatrixRTCSessionEvent.EncryptionKeyChanged,
      expect.any(Function),
    );
  });

  test("emits existing keys", () => {
    const keyProvider = new MatrixKeyProvider();
    const setKeyListener = vi.fn();
    keyProvider.on(KeyProviderEvent.SetKey, setKeyListener);

    const session = mockRTCSession();

    keyProvider.setRTCSession(session);

    expect(session.reemitEncryptionKeys).toHaveBeenCalled();
  });

  test("mixes both ZMath and rotating MatrixRTC factors deterministically", async () => {
    const matrixKey = new Uint8Array(32).fill(7);
    const first = await deriveZMathMediaKeyBytes(
      matrixKey,
      "ZMATHCALL1.correct-room-factor",
      "participant-a",
      4,
    );
    const second = await deriveZMathMediaKeyBytes(
      matrixKey,
      "ZMATHCALL1.correct-room-factor",
      "participant-a",
      4,
    );
    const wrongPattern = await deriveZMathMediaKeyBytes(
      matrixKey,
      "ZMATHCALL1.wrong-room-factor",
      "participant-a",
      4,
    );
    const rotatedMatrixKey = await deriveZMathMediaKeyBytes(
      new Uint8Array(32).fill(8),
      "ZMATHCALL1.correct-room-factor",
      "participant-a",
      4,
    );

    expect(first).toEqual(second);
    expect(first).not.toEqual(wrongPattern);
    expect(first).not.toEqual(rotatedMatrixKey);
  });

  test("separates participant identities and key indexes", async () => {
    const matrixKey = new Uint8Array(32).fill(11);
    const base = await deriveZMathMediaKeyBytes(
      matrixKey,
      "ZMATHCALL1.room-factor",
      "participant-a",
      2,
    );
    const otherParticipant = await deriveZMathMediaKeyBytes(
      matrixKey,
      "ZMATHCALL1.room-factor",
      "participant-b",
      2,
    );
    const otherIndex = await deriveZMathMediaKeyBytes(
      matrixKey,
      "ZMATHCALL1.room-factor",
      "participant-a",
      3,
    );

    expect(base).not.toEqual(otherParticipant);
    expect(base).not.toEqual(otherIndex);
  });

  test("rejects unknown ZMath media profiles", async () => {
    await expect(
      deriveZMathMediaKeyBytes(
        new Uint8Array(32),
        "not-zmath",
        "participant-a",
        0,
      ),
    ).rejects.toThrow("Unsupported ZMath media key profile");
  });
});

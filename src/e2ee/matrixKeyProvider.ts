/*
Copyright 2023, 2024 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { BaseKeyProvider } from "livekit-client";
import {
  type MatrixRTCSession,
  MatrixRTCSessionEvent,
} from "matrix-js-sdk/lib/matrixrtc";
import { logger as rootLogger } from "matrix-js-sdk/lib/logger";
import { type CallMembershipIdentityParts } from "matrix-js-sdk/lib/matrixrtc/EncryptionManager";
const logger = rootLogger.getChild("[MatrixKeyProvider]");
const ZMATH_MEDIA_MIX_DOMAIN = "CallChat-ZMath-MatrixRTC-Media-Mix-v1";
const encoder = new TextEncoder();

function joinBytes(
  ...parts: Uint8Array<ArrayBuffer>[]
): Uint8Array<ArrayBuffer> {
  const output = new Uint8Array(
    parts.reduce((length, part) => length + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

/**
 * Domain-separates a ZMath room factor and a rotating MatrixRTC sender key.
 * Both inputs are required to reproduce the LiveKit frame key material.
 */
export async function deriveZMathMediaKeyBytes(
  encryptionKey: Uint8Array<ArrayBuffer>,
  zmathMediaKey: string,
  rtcBackendIdentity: string,
  encryptionKeyIndex: number,
): Promise<Uint8Array<ArrayBuffer>> {
  if (!zmathMediaKey.startsWith("ZMATHCALL1.")) {
    throw new Error("Unsupported ZMath media key profile");
  }

  const secret = encoder.encode(zmathMediaKey);
  const separator = new Uint8Array([0]);
  const ikmBytes = joinBytes(encryptionKey, separator, secret);
  const ikm = await crypto.subtle.importKey("raw", ikmBytes, "HKDF", false, [
    "deriveBits",
  ]);
  const salt = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      encoder.encode(ZMATH_MEDIA_MIX_DOMAIN),
    ),
  );
  const info = encoder.encode(
    `${ZMATH_MEDIA_MIX_DOMAIN}:${rtcBackendIdentity}:${encryptionKeyIndex}`,
  );
  const mixed = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt, info },
      ikm,
      256,
    ),
  );
  secret.fill(0);
  ikmBytes.fill(0);
  salt.fill(0);
  return mixed;
}

export class MatrixKeyProvider extends BaseKeyProvider {
  private rtcSession?: MatrixRTCSession;

  public constructor(private readonly zmathMediaKey?: string) {
    super({ ratchetWindowSize: 10, keyringSize: 256 });
  }

  public setRTCSession(rtcSession: MatrixRTCSession): void {
    if (this.rtcSession) {
      this.rtcSession.off(
        MatrixRTCSessionEvent.EncryptionKeyChanged,
        this.onEncryptionKeyChanged,
      );
    }

    this.rtcSession = rtcSession;

    this.rtcSession.on(
      MatrixRTCSessionEvent.EncryptionKeyChanged,
      this.onEncryptionKeyChanged,
    );

    // The new session could be aware of keys of which the old session wasn't,
    // so emit key changed events
    this.rtcSession.reemitEncryptionKeys();
  }

  private onEncryptionKeyChanged = (
    encryptionKey: Uint8Array<ArrayBuffer>,
    encryptionKeyIndex: number,
    membershipParts: CallMembershipIdentityParts,
    rtcBackendIdentity: string,
  ): void => {
    const keyBytesPromise = this.zmathMediaKey
      ? deriveZMathMediaKeyBytes(
          encryptionKey,
          this.zmathMediaKey,
          rtcBackendIdentity,
          encryptionKeyIndex,
        )
      : Promise.resolve(encryptionKey);

    keyBytesPromise
      .then(async (keyBytes) => {
        try {
          return await crypto.subtle.importKey("raw", keyBytes, "HKDF", false, [
            "deriveBits",
            "deriveKey",
          ]);
        } finally {
          if (this.zmathMediaKey) keyBytes.fill(0);
        }
      })
      .then(
        (keyMaterial) => {
          this.onSetEncryptionKey(
            keyMaterial,
            rtcBackendIdentity,
            encryptionKeyIndex,
          );

          logger.debug(
            `Sent new key to livekit room=${this.rtcSession?.room.roomId} participantId=${rtcBackendIdentity} (before hash: ${membershipParts.userId}:${membershipParts.deviceId}) encryptionKeyIndex=${encryptionKeyIndex}`,
          );
        },
        (e) => {
          logger.error(
            `Failed to create key material from buffer for livekit room=${this.rtcSession?.room.roomId} participantId before hash=${membershipParts.userId}:${membershipParts.deviceId} encryptionKeyIndex=${encryptionKeyIndex}`,
            e,
          );
        },
      );
  };
}

/*
Copyright 2025 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { getTrackReferenceId } from "@livekit/components-core";
import { RoomEvent, type Room as LivekitRoom } from "livekit-client";
import { type RemoteAudioTrack, Track } from "livekit-client";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  useTracks,
  AudioTrack,
  type AudioTrackProps,
} from "@livekit/components-react";
import { logger } from "matrix-js-sdk/lib/logger";
import { Button } from "@vector-im/compound-web";
import { VolumeOnSolidIcon } from "@vector-im/compound-design-tokens/assets/web/icons";

import { useEarpieceAudioConfig } from "../MediaDevicesContext";
import { useReactiveState } from "../useReactiveState";
import * as controls from "../controls";
import styles from "./MatrixAudioRenderer.module.css";

export interface MatrixAudioRendererProps {
  /**
   * The service URL of the LiveKit room.
   */
  url: string;
  livekitRoom: LivekitRoom;
  /**
   * The list of participant identities to render audio for.
   * This list needs to be composed based on the matrixRTC members so that we do not play audio from users
   * that are not expected to be in the rtc session (local user is excluded).
   */
  validIdentities: string[];
  /**
   * If set to `true`, mutes all audio tracks rendered by the component.
   * @remarks
   * If set to `true`, the server will stop sending audio track data to the client.
   */
  muted?: boolean;
}

const prefixedLogger = logger.getChild("[MatrixAudioRenderer]");
/**
 * Takes care of handling remote participants’ audio tracks and makes sure that microphones and screen share are audible.
 *
 * It also takes care of the earpiece audio configuration for iOS devices.
 * This is done by using the WebAudio API to create a stereo pan effect that mimics the earpiece audio.
 * @example
 * ```tsx
 * <LiveKitRoom>
 *   <MatrixAudioRenderer />
 * </LiveKitRoom>
 * ```
 * @public
 */
export function LivekitRoomAudioRenderer({
  url,
  livekitRoom,
  validIdentities,
  muted,
}: MatrixAudioRendererProps): ReactNode {
  const tracks = useTracks(
    [
      Track.Source.Microphone,
      Track.Source.ScreenShareAudio,
      Track.Source.Unknown,
    ],
    {
      updateOnlyOn: [],
      onlySubscribed: true,
      room: livekitRoom,
    },
  )
    // Only keep audio tracks
    .filter((ref) => ref.publication.kind === Track.Kind.Audio)
    // Only keep tracks from participants that are in the validIdentities list
    .filter((ref) => {
      const isValid = validIdentities.includes(ref.participant.identity);
      if (!isValid) {
        // TODO make sure to also skip the warn logging for the local identity
        // Log that there is an invalid identity, that means that someone is publishing audio that is not expected to be in the call.
        prefixedLogger.warn(
          `Audio track ${ref.participant.identity} from ${url} has no matching matrix call member`,
          `current members: ${validIdentities.join()}`,
          `track will not get rendered`,
        );
        return false;
      }
      return true;
    });

  // This component is also (in addition to the "only play audio for connected members" logic above)
  // responsible for mimicking earpiece audio on iPhones.
  // The Safari audio devices enumeration does not expose an earpiece audio device.
  // We alternatively use the audioContext pan node to only use one of the stereo channels.

  // This component does get additionally complicated because of a Safari bug.
  // (see: https://bugs.webkit.org/show_bug.cgi?id=251532
  // and the related issues: https://bugs.webkit.org/show_bug.cgi?id=237878
  // and https://bugs.webkit.org/show_bug.cgi?id=231105)
  //
  // AudioContext gets stopped if the webview gets moved into the background.
  // Once the phone is in standby audio playback will stop.
  // So we can only use the pan trick only works is the phone is not in standby.
  // If earpiece mode is not used we do not use audioContext to allow standby playback.
  // shouldUseAudioContext is set to false if stereoPan === 0 to allow standby bluetooth playback.

  const { pan: stereoPan, volume: volumeFactor } = useEarpieceAudioConfig();
  const shouldUseAudioContext = stereoPan !== 0;

  // initialize the potentially used audio context.
  const [audioContext, setAudioContext] = useState<AudioContext | undefined>(
    undefined,
  );
  useEffect(() => {
    const ctx = new AudioContext();
    setAudioContext(ctx);
    return (): void => {
      void ctx.close();
    };
  }, []);
  const audioNodes = useMemo(
    () => ({
      gain: audioContext?.createGain(),
      pan: audioContext?.createStereoPanner(),
    }),
    [audioContext],
  );

  // Simple effects to update the gain and pan node based on the props
  useEffect(() => {
    if (audioNodes.pan) audioNodes.pan.pan.value = stereoPan;
  }, [audioNodes.pan, stereoPan]);
  useEffect(() => {
    if (audioNodes.gain) audioNodes.gain.gain.value = volumeFactor;
  }, [audioNodes.gain, volumeFactor]);

  return (
    <>
      <AudioPlaybackGate livekitRoom={livekitRoom} />
      {/* Keep media elements out of the visual layout while allowing playback. */}
      <div className={styles.audioElements}>
        {tracks.map((trackRef) => (
          <AudioTrackWithAudioNodes
            key={getTrackReferenceId(trackRef)}
            trackRef={trackRef}
            muted={muted}
            audioContext={shouldUseAudioContext ? audioContext : undefined}
            audioNodes={audioNodes}
          />
        ))}
      </div>
    </>
  );
}

interface AudioPlaybackGateProps {
  livekitRoom: LivekitRoom;
}

/**
 * Safari and other browsers can accept remote tracks while blocking audible
 * playback. Keep that state visible and resume it from an explicit user action.
 */
function AudioPlaybackGate({ livekitRoom }: AudioPlaybackGateProps): ReactNode {
  const [canPlay, setCanPlay] = useState(livekitRoom.canPlaybackAudio);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const onStatusChanged = (): void => {
      setCanPlay(livekitRoom.canPlaybackAudio);
      if (livekitRoom.canPlaybackAudio) setFailed(false);
    };
    livekitRoom.on(RoomEvent.AudioPlaybackStatusChanged, onStatusChanged);
    onStatusChanged();
    return (): void => {
      livekitRoom.off(RoomEvent.AudioPlaybackStatusChanged, onStatusChanged);
    };
  }, [livekitRoom]);

  const startAudio = useCallback(async (): Promise<void> => {
    setBusy(true);
    setFailed(false);
    try {
      await livekitRoom.startAudio();
      setCanPlay(livekitRoom.canPlaybackAudio);
      controls.setPlaybackStarted();
    } catch (error) {
      prefixedLogger.warn("Browser refused to start call audio", error);
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }, [livekitRoom]);

  if (canPlay) return null;

  return (
    <div className={styles.playbackGate} role="status" aria-live="polite">
      <VolumeOnSolidIcon aria-hidden width={22} height={22} />
      <div className={styles.playbackCopy}>
        <strong>Call audio is paused</strong>
        <span>
          {failed
            ? "Your browser still blocked sound. Check site audio permission, then try again."
            : "Your browser needs one tap before it can play the other person."}
        </span>
      </div>
      <Button
        kind="primary"
        size="md"
        disabled={busy}
        aria-busy={busy}
        onClick={() => void startAudio()}
      >
        {busy ? "Starting..." : "Enable sound"}
      </Button>
    </div>
  );
}

interface StereoPanAudioTrackProps {
  muted?: boolean;
  audioContext?: AudioContext;
  audioNodes: {
    gain?: GainNode;
    pan?: StereoPannerNode;
  };
}

/**
 * This wraps `livekit.AudioTrack` to allow adding audio nodes to a track.
 * It main purpose is to remount the AudioTrack component when switching from
 * audioContext to normal audio playback.
 * As of now the AudioTrack component does not support adding audio nodes while being mounted.
 * @param props The component props
 * @param props.trackRef The track reference
 * @param props.muted If the track should be muted
 * @param props.audioContext The audio context to use
 * @param props.audioNodes The audio nodes to use
 * @returns
 */
function AudioTrackWithAudioNodes({
  trackRef,
  muted,
  audioContext,
  audioNodes,
  ...props
}: StereoPanAudioTrackProps &
  AudioTrackProps &
  React.RefAttributes<HTMLAudioElement>): ReactNode {
  // This is used to unmount/remount the AudioTrack component.
  // Mounting needs to happen after the audioContext is set.
  // (adding the audio context when already mounted did not work outside strict mode)
  const [trackReady, setTrackReady] = useReactiveState(
    () => false,
    // We only want the track to reset once both (audioNodes and audioContext) are set.
    // for unsetting the audioContext its enough if one of the two is undefined.
    [audioContext && audioNodes],
  );

  useEffect(() => {
    if (!trackRef || trackReady) return;
    const track = trackRef.publication.track as RemoteAudioTrack;
    const useContext = audioContext && audioNodes.gain && audioNodes.pan;
    track.setAudioContext(useContext ? audioContext : undefined);
    track.setWebAudioPlugins(
      useContext ? [audioNodes.gain!, audioNodes.pan!] : [],
    );
    setTrackReady(true);
    controls.setPlaybackStarted();
  }, [audioContext, audioNodes, setTrackReady, trackReady, trackRef]);

  return (
    trackReady && <AudioTrack trackRef={trackRef} muted={muted} {...props} />
  );
}

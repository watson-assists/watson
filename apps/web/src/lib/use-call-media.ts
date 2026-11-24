"use client";

import { useEffect, useRef, useState } from "react";

/**
 * The camera and microphone of a video call, on either side: opening them, muting the microphone,
 * turning the camera off, and letting them go when the call ends or the page closes.
 */
export function useCallMedia() {
  const media = useRef<MediaStream | null>(null);
  const localVideo = useRef<HTMLVideoElement>(null);
  const remoteVideo = useRef<HTMLVideoElement>(null);
  const [muted, setMuted] = useState(false);
  const [cameraOff, setCameraOff] = useState(false);

  const stop = () => media.current?.getTracks().forEach((track) => track.stop());
  useEffect(() => stop, []);

  /** The camera and microphone, shown in the small picture; null when the browser refuses them. */
  async function open(): Promise<MediaStream | null> {
    try {
      media.current = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    } catch {
      return null;
    }
    if (localVideo.current) localVideo.current.srcObject = media.current;
    return media.current;
  }

  function toggle(kind: "audio" | "video") {
    const tracks = kind === "audio" ? media.current?.getAudioTracks() : media.current?.getVideoTracks();
    const off = kind === "audio" ? !muted : !cameraOff;
    tracks?.forEach((track) => (track.enabled = !off));
    if (kind === "audio") setMuted(off);
    else setCameraOff(off);
  }

  /** Shows the other side's picture and sound. */
  const showRemote = (stream: MediaStream) => {
    if (remoteVideo.current) remoteVideo.current.srcObject = stream;
  };

  return { open, stop, toggle, showRemote, muted, cameraOff, localVideo, remoteVideo };
}

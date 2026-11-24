"use client";

import { Mic, MicOff, PhoneOff, Video, VideoOff } from "lucide-react";
import type { ReactNode, RefObject } from "react";

/** The call's screen, the same for doctor and patient: the other side, a note until connected, a badge, and you. */
export function CallScreen({ remoteVideo, localVideo, remoteLabel, note, badge, selfHidden }: {
  remoteVideo: RefObject<HTMLVideoElement | null>; localVideo: RefObject<HTMLVideoElement | null>;
  remoteLabel: string; note: [string, string?] | null; badge: ReactNode; selfHidden: boolean;
}) {
  return (
    <div className="wa-screen">
      <video ref={remoteVideo} autoPlay playsInline aria-label={remoteLabel} />
      {note && (
        <div className="wa-screen__note">
          <p className="wa-heading" style={{ color: "inherit" }}>{note[0]}</p>
          {note[1] && <p className="wa-text">{note[1]}</p>}
        </div>
      )}
      {badge}
      {/* Hidden until the camera is on: before that it is an empty box over the screen's note. */}
      <div className="wa-screen__self" hidden={selfHidden}><video ref={localVideo} autoPlay playsInline muted aria-label="You" /></div>
    </div>
  );
}

/** Mute, the camera, and leaving: the buttons during a call, on either side. */
export function CallControls({ muted, cameraOff, onToggle, onEnd, endLabel }: {
  muted: boolean; cameraOff: boolean; onToggle: (kind: "audio" | "video") => void; onEnd: () => void; endLabel: string;
}) {
  return (
    <>
      <button type="button" className="wa-button wa-button--secondary" aria-pressed={muted} onClick={() => onToggle("audio")}>
        {muted ? <MicOff aria-hidden className="wa-icon" /> : <Mic aria-hidden className="wa-icon" />}{muted ? "Unmute" : "Mute"}
      </button>
      <button type="button" className="wa-button wa-button--secondary" aria-pressed={cameraOff} onClick={() => onToggle("video")}>
        {cameraOff ? <VideoOff aria-hidden className="wa-icon" /> : <Video aria-hidden className="wa-icon" />}{cameraOff ? "Turn camera on" : "Turn camera off"}
      </button>
      <button type="button" className="wa-button wa-button--danger" onClick={onEnd}>
        <PhoneOff aria-hidden className="wa-icon" />{endLabel}
      </button>
    </>
  );
}

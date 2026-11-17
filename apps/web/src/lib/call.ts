// A consultation call. Video and voice go directly between the two browsers (WebRTC); two private
// Supabase channels carry only the handshake, one for each direction. Free: no media server.
// Who may use them is decided in the database (20261117100000_call_admission.sql, SEC-03): the
// doctor as the consultation's practitioner, the patient's browser once admit_to_call admits it.
import type { Outcome } from "./api";
import { formatOfRecording, type AudioFormat } from "./audio";
import { RELAY } from "./features";
import { patientCallClient, supabase } from "./supabase";

type Role = "doctor" | "patient";
export type CallState = "joining" | "waiting" | "connecting" | "connected" | "reconnecting" | "ended";
type Message =
  | { kind: "hello" | "bye" }
  | { kind: "offer" | "answer"; sdp: RTCSessionDescriptionInit }
  | { kind: "ice"; candidate: RTCIceCandidateInit };
type Signal = Message & { from: Role; session: string };

// Public STUN servers let each browser find its own address; enough on most home and office networks.
const STUN: RTCConfiguration = { iceServers: [{ urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }] };

/**
 * The call's servers from the `ice` edge function: STUN plus, when Watson has its relay, TURN credentials
 * for this call. A phone on a mobile network sits behind its carrier's shared address and cannot reach the
 * other browser directly (owner, 28 Oct: a call from 5G never connected); the relay carries those calls.
 * On one computer (features.ts, RELAY) and whenever the function does not answer, the call keeps STUN alone.
 */
async function iceFor(token: string): Promise<RTCConfiguration> {
  if (!RELAY) return STUN;
  try {
    const { data, error } = await supabase.functions.invoke("ice", { body: { token }, timeout: 8000 });
    if (!error && Array.isArray(data?.iceServers)) return { iceServers: data.iceServers };
  } catch {
    // keep STUN
  }
  return STUN;
}

/** The patient's link, short enough to read out: /j/K7P4QX9M opens their page (app/j). */
export function patientLink(shortCode: string): string {
  return `${window.location.origin}/j/${shortCode}`;
}

/**
 * The patient's browser asks to join: it gets an anonymous session of its own, and the database
 * admits it only to an open, paid consultation, one device at a time. The answer names the call.
 */
export async function admitToCall(token: string): Promise<Outcome<{ consultation_id: string }>> {
  const client = patientCallClient();
  const { data: { session } } = await client.auth.getSession();
  if (!session && (await client.auth.signInAnonymously()).error) return { ok: false, error_category: "STORAGE_UNAVAILABLE" };
  const { data, error } = await client.rpc("admit_to_call", { p_token: token });
  if (error || data === null) return { ok: false, error_category: "STORAGE_UNAVAILABLE" };
  return data as unknown as Outcome<{ consultation_id: string }>;
}

/** Joins the call as doctor or patient. The doctor makes every offer, so either can arrive first. */
export function connect({ consultationId, token, role, local, onRemote, onState }: {
  consultationId: string;
  token: string;
  role: Role;
  local: MediaStream;
  onRemote: (stream: MediaStream) => void;
  onState: (state: CallState) => void;
}) {
  const session = crypto.randomUUID();
  const other: Role = role === "doctor" ? "patient" : "doctor";
  const servers = iceFor(token);
  let peer: RTCPeerConnection | null = null;
  let otherSession: string | null = null;
  let waiting: RTCIceCandidateInit[] = [];
  let queue = Promise.resolve();
  // The doctor uses their own sign-in; the patient the call's anonymous session (admitToCall).
  const client = role === "doctor" ? supabase : patientCallClient();
  // Each side listens on the channel addressed to it and sends on the other's; the database lets
  // only the doctor send to the patient and only the admitted patient send to the doctor.
  const inbox = client.channel(`call:${consultationId}:to-${role}`, { config: { private: true } });
  const outbox = client.channel(`call:${consultationId}:to-${other}`, { config: { private: true } });
  const send = (message: Message) =>
    outbox.send({ type: "broadcast", event: "signal", payload: { ...message, from: role, session } });
  // One message at a time, in order: a handshake step must finish before the next starts.
  const inTurn = (step: () => Promise<void>) => {
    queue = queue.then(step).catch(() => onState("reconnecting"));
  };
  // A candidate for an older connection is refused; that is no reason to call the connection lost.
  const addCandidate = (candidate: RTCIceCandidateInit) => peer?.addIceCandidate(candidate).catch(() => {});

  async function fresh() {
    const configuration = await servers;
    peer?.close();
    waiting = [];
    const created = new RTCPeerConnection(configuration);
    local.getTracks().forEach((track) => created.addTrack(track, local));
    created.onicecandidate = ({ candidate }) => {
      if (candidate) void send({ kind: "ice", candidate: candidate.toJSON() });
    };
    created.ontrack = ({ streams }) => streams[0] && onRemote(streams[0]);
    created.onconnectionstatechange = () => {
      if (created !== peer) return;
      if (created.connectionState === "connected") onState("connected");
      if (created.connectionState === "disconnected" || created.connectionState === "failed") onState("reconnecting");
      // A connection that failed (the network changed, say from Wi-Fi to mobile data) gets a new one:
      // the doctor makes every offer, so the doctor starts it.
      if (created.connectionState === "failed" && role === "doctor") {
        setTimeout(() => inTurn(async () => {
          if (created === peer) await offer();
        }), 1000);
      }
    };
    peer = created;
    onState("connecting");
    return created;
  }

  async function offer() {
    const created = await fresh();
    await created.setLocalDescription(await created.createOffer());
    await send({ kind: "offer", sdp: created.localDescription!.toJSON() });
  }

  async function flush() {
    for (const candidate of waiting) await addCandidate(candidate);
    waiting = [];
  }

  async function handle(signal: Signal) {
    if (signal.from !== other) return;
    if (signal.kind === "hello") {
      // A new session on the other side (it arrived or reloaded) needs a new connection.
      if (signal.session === otherSession && peer) return;
      otherSession = signal.session;
      if (role === "patient") return void (await send({ kind: "hello" }));
      await offer();
    } else if (signal.kind === "offer") {
      otherSession = signal.session;
      const created = await fresh();
      await created.setRemoteDescription(signal.sdp);
      await flush();
      await created.setLocalDescription(await created.createAnswer());
      await send({ kind: "answer", sdp: created.localDescription!.toJSON() });
    } else if (signal.kind === "answer") {
      await peer?.setRemoteDescription(signal.sdp);
      await flush();
    } else if (signal.kind === "ice") {
      if (peer?.remoteDescription) await addCandidate(signal.candidate);
      else waiting.push(signal.candidate);
    } else if (signal.kind === "bye") {
      peer?.close();
      peer = null;
      otherSession = null;
      onState(role === "patient" ? "ended" : "waiting");
    }
  }

  inbox.on("broadcast", { event: "signal" }, ({ payload }) => inTurn(() => handle(payload as Signal)));
  onState("joining");
  let joined = 0;
  const ready = (status: string) => {
    if (status === "SUBSCRIBED" && ++joined === 2) {
      onState("waiting");
      void send({ kind: "hello" });
    }
  };
  // Private channels carry the signed-in session's token, so it is handed over before joining.
  void client.realtime.setAuth().then(() => {
    inbox.subscribe(ready);
    outbox.subscribe(ready);
  });

  return {
    async leave() {
      await send({ kind: "bye" });
      peer?.close();
      peer = null;
      await Promise.all([client.removeChannel(inbox), client.removeChannel(outbox)]);
      onState("ended");
    },
  };
}

export type Recording = { practitioner: Blob; patient: Blob; format: AudioFormat; seconds: number };

/** One live piece of the call: a voice, its number in turn, and when it starts in the recording. */
export type LivePiece = (speaker: "practitioner" | "patient", blob: Blob, seq: number, offsetSeconds: number) => void;
const PIECE_MS = 10_000;

/**
 * Ten-second pieces of one voice, each a file of its own, for the live transcript (owner, 24 Oct:
 * "like it happens in Teams"). Recorded beside the full track, which stays the one that counts.
 */
function pieces(stream: MediaStream, startedAt: number, onPiece: (blob: Blob, seq: number, offset: number) => void) {
  let count = 0;
  let current: MediaRecorder | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = true;
  const next = () => {
    if (!running) return;
    const recorder = new MediaRecorder(stream, { audioBitsPerSecond: 32_000 });
    const parts: Blob[] = [];
    const seq = count++;
    const offset = (performance.now() - startedAt) / 1000;
    recorder.addEventListener("dataavailable", (event) => parts.push(event.data));
    recorder.addEventListener("stop", () => onPiece(new Blob(parts, { type: recorder.mimeType }), seq, offset), { once: true });
    recorder.start();
    current = recorder;
    timer = setTimeout(() => {
      recorder.stop();
      next();
    }, PIECE_MS);
  };
  next();
  return () => {
    running = false;
    clearTimeout(timer);
    if (current?.state === "recording") current.stop();
  };
}

/**
 * Records the call in the doctor's browser as two tracks on one clock: the doctor's microphone,
 * and whatever the patient's side sends. The patient's side goes through a mixer, so a
 * reconnection mid-call keeps recording into the same track.
 */
export function recordCall(local: MediaStream, onPiece?: LivePiece) {
  const context = new AudioContext();
  const patientMix = context.createMediaStreamDestination();
  const options = { audioBitsPerSecond: 32_000 }; // speech needs little; the free storage is small
  const doctorVoice = new MediaStream(local.getAudioTracks());
  const practitioner = new MediaRecorder(doctorVoice, options);
  const patient = new MediaRecorder(patientMix.stream, options);
  const chunks = { practitioner: [] as Blob[], patient: [] as Blob[] };
  practitioner.addEventListener("dataavailable", (event) => chunks.practitioner.push(event.data));
  patient.addEventListener("dataavailable", (event) => chunks.patient.push(event.data));
  let started = 0;
  let stopPieces: (() => void)[] = [];

  const stopped = (recorder: MediaRecorder) =>
    new Promise<void>((resolve) => {
      if (recorder.state === "inactive") return resolve();
      recorder.addEventListener("stop", () => resolve(), { once: true });
      recorder.stop();
    });

  return {
    get started() {
      return started > 0;
    },
    get seconds() {
      return started ? (performance.now() - started) / 1000 : 0;
    },
    addPatient(stream: MediaStream) {
      if (stream.getAudioTracks().length) context.createMediaStreamSource(stream).connect(patientMix);
    },
    start() {
      if (started) return;
      context.resume().catch(() => {}); // a call ended at once closes the mixer while it starts (Firefox)
      practitioner.start(1000);
      patient.start(1000);
      started = performance.now();
      if (onPiece) {
        stopPieces = [
          pieces(doctorVoice, started, (blob, seq, offset) => onPiece("practitioner", blob, seq, offset)),
          pieces(patientMix.stream, started, (blob, seq, offset) => onPiece("patient", blob, seq, offset)),
        ];
      }
    },
    async stop(): Promise<Recording | null> {
      if (!started) return null;
      const seconds = (performance.now() - started) / 1000;
      stopPieces.forEach((stop) => stop());
      await Promise.all([stopped(practitioner), stopped(patient)]);
      context.close().catch(() => {});
      const type = practitioner.mimeType;
      return {
        practitioner: new Blob(chunks.practitioner, { type }),
        patient: new Blob(chunks.patient, { type: patient.mimeType }),
        format: formatOfRecording(type),
        seconds,
      };
    },
  };
}

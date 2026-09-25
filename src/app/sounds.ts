// Звуки звонков: мелодия входящего, гудки, «вошёл/вышел», микрофон. Всё синтезируется
// Web Audio на лету — никаких файлов. Браузер разрешает звук только после действия
// пользователя, поэтому unlock() вызывается на первом нажатии.

let ctx: AudioContext | null = null;

function ac(): AudioContext | null {
  try {
    if (!ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return null;
      ctx = new Ctor();
    }
    if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
    return ctx;
  } catch {
    return null;
  }
}

/** Разбудить звук на действии пользователя (иначе мелодия входящего может не заиграть). */
export function unlock(): void {
  ac();
}

/** Общий AudioContext — для измерения громкости голосов в звонке. */
export function audioContext(): AudioContext | null {
  return ac();
}

type Note = { f: number; at: number; len: number; vol?: number; type?: OscillatorType };

function play(notes: Note[]): void {
  const c = ac();
  if (!c || c.state !== 'running') return;
  const t0 = c.currentTime + 0.02;
  for (const n of notes) {
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = n.type ?? 'sine';
    o.frequency.value = n.f;
    const vol = n.vol ?? 0.12;
    const start = t0 + n.at;
    g.gain.setValueAtTime(0, start);
    g.gain.linearRampToValueAtTime(vol, start + 0.015);
    g.gain.setValueAtTime(vol, start + Math.max(0.02, n.len - 0.06));
    g.gain.exponentialRampToValueAtTime(0.0001, start + n.len);
    o.connect(g).connect(c.destination);
    o.start(start);
    o.stop(start + n.len + 0.05);
  }
}

let loopTimer: number | undefined;
let loopKind: 'ring' | 'back' | null = null;

function loop(kind: 'ring' | 'back', every: number, once: () => void): void {
  if (loopKind === kind) return;
  stopLoop();
  loopKind = kind;
  once();
  loopTimer = window.setInterval(once, every);
}

function stopLoop(): void {
  clearInterval(loopTimer);
  loopTimer = undefined;
  loopKind = null;
}

/** Входящий звонок: весёлое трезвучие дважды, пауза. */
export function ringStart(): void {
  loop('ring', 2600, () => {
    const seq = [659, 831, 988, 831];
    play([
      ...seq.map((f, i) => ({ f, at: i * 0.13, len: 0.16, vol: 0.1, type: 'triangle' as OscillatorType })),
      ...seq.map((f, i) => ({ f, at: 0.7 + i * 0.13, len: 0.16, vol: 0.1, type: 'triangle' as OscillatorType })),
    ]);
  });
}

/** Гудки, пока собеседник не ответил: 425 Гц, секунда звука — три тишины. */
export function backStart(): void {
  loop('back', 4000, () => play([{ f: 425, at: 0, len: 1, vol: 0.06 }]));
}

export function stopTones(): void {
  stopLoop();
}

export function joined(): void {
  play([{ f: 523, at: 0, len: 0.12, vol: 0.09 }, { f: 784, at: 0.1, len: 0.18, vol: 0.09 }]);
}

export function left(): void {
  play([{ f: 784, at: 0, len: 0.12, vol: 0.09 }, { f: 523, at: 0.1, len: 0.2, vol: 0.09 }]);
}

export function hangup(): void {
  play([{ f: 480, at: 0, len: 0.14, vol: 0.08 }, { f: 360, at: 0.16, len: 0.14, vol: 0.08 }, { f: 280, at: 0.32, len: 0.22, vol: 0.08 }]);
}

export function muted(on: boolean): void {
  play(on ? [{ f: 520, at: 0, len: 0.09, vol: 0.07 }, { f: 390, at: 0.08, len: 0.1, vol: 0.07 }]
    : [{ f: 390, at: 0, len: 0.09, vol: 0.07 }, { f: 520, at: 0.08, len: 0.1, vol: 0.07 }]);
}

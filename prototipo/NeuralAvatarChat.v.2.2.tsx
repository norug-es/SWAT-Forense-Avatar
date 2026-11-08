/**
 * NeuralAvatarChat.tsx
 * Avatar 3D de cuadraditos huecos (estilo halftone) con la cabeza reconstruida de las fotos,
 * que "habla" un feed de chat alimentado por el MCP swat-neuralbus.
 *
 * Un solo archivo: el rostro reconstruido va incrustado al final (gzip + base64, ~287 KB).
 * Dependencias:  npm i three @types/three      (React 18+)
 * Uso:
 *   <div style={{ width: "100vw", height: "100vh" }}>
 *     <NeuralAvatarChat apiBaseUrl="/api/v1" />
 *   </div>
 *
 * Voz: Ajustes de voz (⚙) permite elegir idioma (ES/EN/PT), voz de hombre o mujer, voz concreta, velocidad, tono
 * y volumen; se guarda en el navegador. Con `ttsFetch` puedes usar un servicio de voz realista (ver props).
 * Voz en la nube (opcional, la más realista; la clave del proveedor va en tu servidor):
 *   <NeuralAvatarChat ttsFetch={async ({ text, lang, gender, voice }) => {
 *     const r = await fetch("/api/tts", { method: "POST", headers: { "Content-Type": "application/json" },
 *       body: JSON.stringify({ text, lang, gender, voice }) });
 *     if (!r.ok) throw new Error("TTS"); return r.blob();
 *   }} />
 * Si falla, el componente sigue con las voces del navegador.
 * El chat se oculta/muestra con el botón de arriba a la derecha; oculto, la voz se ve como una onda translúcida
 * abajo al centro.
 * Interacción: arrastra para orbitar libremente (también desde arriba y desde abajo), rueda o pellizco para
 * acercarte, doble clic o "Vista frontal" para volver. "Foto a avatar" convierte una foto tuya en avatar
 * (se procesa en el navegador). Toca un nodo para que el avatar lo comente.
 *
 * Conexión REST: GET /feed para el feed y POST /query para las consultas.
 * El gateway devuelve { ok, data: { items }, meta, error }.
 * - Si el navegador no soporta DecompressionStream, usa un busto genérico (se indica en el HUD).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import * as THREE from "three";

/* ───────────────────────────── Tipos ───────────────────────────── */

export interface DataItem {
  id: string;
  label: string;
  category: string;
  risk: number | null; // 0..100 cuando el gateway lo aporta
  detail: string;
  source: string;
}

interface ChatMessage {
  id: number;
  role: "agent" | "user";
  author: string;
  text: string;
  refs: string[];
  risk?: number;
}

type Draft = Omit<ChatMessage, "id">;

export interface NeuralAvatarChatProps {
  apiBaseUrl?: string;
  refreshMs?: number;
  voice?: boolean;
  /** Idioma inicial de la voz y del diálogo (es, en o pt; el usuario puede cambiarlo en Ajustes de voz). */
  lang?: string;
  /** Opcional: proveedor de voz en la nube (audio realista y boca sincronizada con el audio real). */
  ttsFetch?: TtsFetch;
  /** Opcional: URL de un neural-face.bin propio. Por defecto se usa el rostro incrustado en este archivo. */
  faceSrc?: string;
  className?: string;
  style?: CSSProperties;
}

type Json = Record<string, unknown>;
type Source = "connecting" | "live" | "offline";
type Status = "idle" | "thinking" | "speaking";

/* ───────────────────────────── Utilidades ───────────────────────────── */

const TAU = Math.PI * 2;
const isRec = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

function hash32(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const shorten = (s: string, n = 18): string =>
  s.length <= n ? s : `${s.slice(0, 6)}…${s.slice(-4)}`;

function riskColor(r: number): [number, number, number] {
  const ice: [number, number, number] = [0.93, 0.89, 0.8];
  const amber: [number, number, number] = [1.0, 0.76, 0.3];
  const hot: [number, number, number] = [1.0, 0.24, 0.55];
  const t = r < 50 ? r / 50 : (r - 50) / 50;
  const a = r < 50 ? ice : amber;
  const b = r < 50 ? amber : hot;
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

const riskHex = (r: number): string => {
  const [x, y, z] = riskColor(r);
  const h = (v: number) => Math.round(v * 255).toString(16).padStart(2, "0");
  return `#${h(x)}${h(y)}${h(z)}`;
};
const riskValue = (r: number | null): number => r ?? 0;

const AGENTS = [
  { name: "SENTINEL", color: "#ff3d8b" },
  { name: "RISK ARENA", color: "#5cf0ff" },
  { name: "FORENSIQ", color: "#ffc24d" },
  { name: "GEOVIS", color: "#38ffb0" },
];
const agentFor = (category: string) => AGENTS[hash32(category) % AGENTS.length];

const pick = (o: Json, keys: string[]): unknown => {
  for (const k of keys) {
    const v = o[k];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
};

function normalizeRisk(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return Math.round(clamp(v <= 1 ? v * 100 : v, 0, 100));
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return Math.round(clamp(n <= 1 ? n * 100 : n, 0, 100));
  }
  return null;
}

function toItems(result: unknown, source: string): DataItem[] {
  if (!isRec(result) || result.ok !== true || !isRec(result.data) || !Array.isArray(result.data.items)) return [];
  const seen = new Set<string>();
  const out: DataItem[] = [];
  result.data.items.filter(isRec).forEach((rec, i) => {
    const rawId = pick(rec, ["id", "address", "wallet", "hash", "signature", "mint", "pool", "name", "symbol", "key"]);
    const id = rawId !== undefined ? String(rawId) : `${source}-${i}`;
    if (seen.has(id)) return;
    seen.add(id);
    const rawLabel = pick(rec, ["label", "name", "symbol", "title", "address", "wallet", "id"]);
    const label = shorten(rawLabel !== undefined ? String(rawLabel) : id);
    const category = String(pick(rec, ["category", "type", "kind", "chain", "signal", "severity", "status"]) ?? source).toUpperCase();
    const risk = normalizeRisk(pick(rec, ["risk", "risk_score", "riskScore"]));
    const rawDetail = pick(rec, ["description", "detail", "summary", "message", "reason", "text"]);
    const detail =
      rawDetail !== undefined
        ? String(rawDetail)
        : Object.entries(rec)
            .slice(0, 4)
            .map(([k, v]) => `${k}: ${typeof v === "object" ? "…" : String(v)}`)
            .join(", ");
    const itemSource = String(pick(rec, ["source", "origin", "upstream"]) ?? source);
    out.push({ id, label, category, risk, detail: detail.length > 260 ? `${detail.slice(0, 257)}…` : detail, source: itemSource });
  });
  return out;
}

async function gatewayFetch(apiBaseUrl: string, path: string, init?: RequestInit): Promise<unknown> {
  const ctl = new AbortController();
  const timer = window.setTimeout(() => ctl.abort(), 12000);
  try {
    const base = apiBaseUrl.replace(/\/+$/, "");
    const res = await fetch(`${base}${path}`, { ...init, signal: ctl.signal });
    const payload: unknown = await res.json();
    if (!res.ok || !isRec(payload) || payload.ok !== true) {
      const message = isRec(payload) && isRec(payload.error) ? String(payload.error.message ?? "Gateway error") : `HTTP ${res.status}`;
      throw new Error(message);
    }
    return payload;
  } finally {
    window.clearTimeout(timer);
  }
}

const mergeItems = (prev: DataItem[], next: DataItem[], cap = 140): DataItem[] => {
  const map = new Map<string, DataItem>();
  for (const it of [...next, ...prev]) if (!map.has(it.id)) map.set(it.id, it);
  return [...map.values()].slice(0, cap);
};

/* ───────────────────────────── Idioma y voz ───────────────────────────── */

type Lang = "es" | "en" | "pt";
type Gender = "auto" | "male" | "female";

const LANG_BCP: Record<Lang, string> = { es: "es-ES", en: "en-US", pt: "pt-BR" };
const LANG_NAME: Record<Lang, string> = { es: "Español", en: "English", pt: "Português" };
const LANGS: Lang[] = ["es", "en", "pt"];

interface VoiceSettings {
  lang: Lang;
  gender: Gender;
  voiceURI: string;
  rate: number;
  pitch: number;
  volume: number;
  cloud: boolean;
}

/** Proveedor de voz en la nube opcional: devuelve el audio (mp3/wav/ogg) de un texto. Conviene llamarlo vía tu backend. */
type TtsFetch = (req: { text: string; lang: Lang; gender: Gender; voice: string }) => Promise<Blob>;

const trimEnd = (s: string) => s.replace(/[\s.]+$/, "");

interface Dict {
  crit: string;
  warn: string;
  obs: string;
  briefing: (a: DataItem, cat: string) => string;
  connected: (n: number) => string;
  offline: (apiBaseUrl: string) => string;
  busDown: string;
  noMatch: (q: string, note: string) => string;
  results: (count: number, body: string, note: string) => string;
  picked: (it: DataItem, cat: string) => string;
  photoDone: string;
  voiceTest: string;
  addr: (tail: string) => string;
  outOf: string;
  cat: Record<string, string>;
}

const I18N: Record<Lang, Dict> = {
  es: {
    crit: "Alerta crítica:",
    warn: "Atención:",
    obs: "Observación:",
    briefing: (a, c) => `${a.label} (${c})${a.risk === null ? "" : ` marca riesgo ${a.risk}/100`}. ${trimEnd(a.detail)}.`,
    connected: (n) => `NeuralBus conectado. ${n} nodos cargados desde el gateway. Pulsa un nodo o escribe una consulta.`,
    offline: (apiBaseUrl) => `Gateway desconectado en ${apiBaseUrl}. No hay datos reales disponibles.`,
    busDown: " El gateway no respondió.",
    noMatch: (q, note) => `Sin coincidencias para "${q}".${note}`,
    results: (count, body, note) => `${count} resultado(s). ${body}.${note}`,
    picked: (it, cat) => `${it.label}: ${trimEnd(it.detail)}. ${it.risk === null ? "Riesgo no disponible" : `Riesgo ${it.risk}/100`} (${cat}, fuente ${it.source}).`,
    photoDone: "Avatar creado desde tu foto. Arrástralo para orbitarlo desde cualquier ángulo y usa la rueda para acercarte.",
    voiceTest: "Hola, soy tu asistente de NeuralBus. Así suena mi voz.",
    addr: (tail) => `la dirección que termina en ${tail}`,
    outOf: " sobre 100",
    cat: { WALLET: "wallet", POOL: "pool", SIGNAL: "señal", TX: "transacción", CONTRATO: "contrato", TEXTO: "texto" },
  },
  en: {
    crit: "Critical alert:",
    warn: "Attention:",
    obs: "Observation:",
    briefing: (a, c) => `${a.label} (${c})${a.risk === null ? "" : ` scores a risk of ${a.risk}/100`}. ${trimEnd(a.detail)}.`,
    connected: (n) => `NeuralBus connected. ${n} nodes loaded from the gateway. Tap a node or type a query.`,
    offline: (apiBaseUrl) => `Gateway disconnected at ${apiBaseUrl}. No real data is available.`,
    busDown: " The gateway didn't answer.",
    noMatch: (q, note) => `No matches for "${q}".${note}`,
    results: (count, body, note) => `${count} result(s). ${body}.${note}`,
    picked: (it, cat) => `${it.label}: ${trimEnd(it.detail)}. ${it.risk === null ? "Risk unavailable" : `Risk ${it.risk}/100`} (${cat}, source ${it.source}).`,
    photoDone: "Avatar created from your photo. Drag it to orbit from any angle and use the wheel to zoom in.",
    voiceTest: "Hi, I'm your NeuralBus assistant. This is how my voice sounds.",
    addr: (tail) => `the address ending in ${tail}`,
    outOf: " out of 100",
    cat: { WALLET: "wallet", POOL: "pool", SIGNAL: "signal", TX: "transaction", CONTRATO: "contract", TEXTO: "text" },
  },
  pt: {
    crit: "Alerta crítico:",
    warn: "Atenção:",
    obs: "Observação:",
    briefing: (a, c) => `${a.label} (${c})${a.risk === null ? "" : ` marca risco ${a.risk}/100`}. ${trimEnd(a.detail)}.`,
    connected: (n) => `NeuralBus conectado. ${n} nós carregados do gateway. Toque num nó ou escreva uma consulta.`,
    offline: (apiBaseUrl) => `Gateway desconectado em ${apiBaseUrl}. Não há dados reais disponíveis.`,
    busDown: " O gateway não respondeu.",
    noMatch: (q, note) => `Sem correspondências para "${q}".${note}`,
    results: (count, body, note) => `${count} resultado(s). ${body}.${note}`,
    picked: (it, cat) => `${it.label}: ${trimEnd(it.detail)}. ${it.risk === null ? "Risco indisponível" : `Risco ${it.risk}/100`} (${cat}, fonte ${it.source}).`,
    photoDone: "Avatar criado a partir da sua foto. Arraste para orbitar de qualquer ângulo e use a roda para aproximar.",
    voiceTest: "Olá, sou o seu assistente do NeuralBus. É assim que a minha voz soa.",
    addr: (tail) => `o endereço que termina em ${tail}`,
    outOf: " de 100",
    cat: { WALLET: "carteira", POOL: "pool", SIGNAL: "sinal", TX: "transação", CONTRATO: "contrato", TEXTO: "texto" },
  },
};

const catName = (lang: Lang, cat: string): string => I18N[lang].cat[cat] ?? cat.toLowerCase();

/** Prepara el texto para la voz: direcciones, "72/100", paréntesis y abreviaturas que suenan mal letra a letra. */
function speechText(text: string, lang: Lang): string {
  const t = I18N[lang];
  let s = text;
  s = s.replace(/\b[A-Za-z0-9]{3,8}…[A-Za-z0-9]{3,6}\b/g, (m) => t.addr(m.slice(-4)));
  s = s.replace(/\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g, (m) => t.addr(m.slice(-4)));
  s = s.replace(/\b0x[0-9a-fA-F]{8,}\b/g, (m) => t.addr(m.slice(-4)));
  s = s.replace(/(\d+)\s*\/\s*100\b/g, `$1${t.outOf}`);
  s = s.replace(/\b(WALLET|POOL|SIGNAL|TX|CONTRATO|TEXTO)\b/g, (m) => t.cat[m] ?? m);
  s = s.replace(/\s*\(([^)]*)\)/g, ", $1,");
  s = s.replace(/…/g, ", ").replace(/#(\d+)/g, "$1");
  s = s.replace(/\s*,(\s*,)+/g, ",").replace(/,\s*([.!?;:])/g, "$1").replace(/\s+/g, " ").trim();
  return s;
}

/** Divide en frases (y trocea las muy largas) para hablar con pausas naturales y evitar cortes del navegador. */
function splitChunks(s: string): string[] {
  const raw = s.match(/[^.!?;:]+[.!?;:]*\s*/g) ?? [s];
  const merged: string[] = [];
  for (const p of raw) {
    const piece = p.trim();
    if (!piece) continue;
    if (merged.length && merged[merged.length - 1].length < 14) merged[merged.length - 1] += ` ${piece}`;
    else merged.push(piece);
  }
  const out: string[] = [];
  for (const c of merged) {
    if (c.length <= 190) { out.push(c); continue; }
    let cur = "";
    for (const part of c.split(",")) {
      if (cur && cur.length + part.length > 160) { out.push(cur); cur = part.trim(); }
      else cur = cur ? `${cur},${part}` : part;
    }
    if (cur) out.push(cur);
  }
  const fin: string[] = [];
  for (const c of out) {
    if (c.length <= 220) { fin.push(c); continue; }
    let cur = "";
    for (const w of c.split(" ")) {
      if (cur && cur.length + w.length + 1 > 180) { fin.push(cur); cur = w; }
      else cur = cur ? `${cur} ${w}` : w;
    }
    if (cur) fin.push(cur);
  }
  return fin.length ? fin : [s];
}

const NAMES_F = new Set(
  ("monica paulina helena sabina laura elena lucia elvira dalia salome paloma marina camila lupe ximena valentina jimena esperanza " +
    "marisol catalina fernanda luciana joana raquel francisca maria heloisa leticia vitoria thalita ines teresa sofia isabela giovanna " +
    "brenda mariana patricia paola flo sandy shelley grandma samantha victoria karen moira tessa fiona allison ava susan zira aria jenny " +
    "ana emma sonia libby michelle nicole kate serena veena joanna salli kendra kimberly ivy amy nova shimmer alloy").split(" "),
);
const NAMES_M = new Set(
  ("jorge diego juan carlos alvaro pablo raul enrique andres tomas alonso arnau gonzalo mateo emilio santiago luis paco pedro miguel " +
    "gabriel felipe antonio donato daniel cassio duarte fernando ricardo alex fred tom aaron arthur oliver gordon rishi lee guy davis " +
    "mark david ryan brian eric christopher roger steffan jason tony matthew justin joey kevin russell liam thomas james george ravi " +
    "eddy reed rocko grandpa onyx echo fable").split(" "),
);
const NOVELTY =
  /\b(albert|bad news|bahh|bells|boing|bubbles|cellos|deranged|good news|hysterical|jester|organ|superstar|trinoids|whisper|wobble|zarvox|fred|ralph|junior|kathy|princess|agnes|bruce)\b/;

function genderOf(v: SpeechSynthesisVoice): "m" | "f" | "?" {
  const n = v.name.toLowerCase();
  if (/\b(female|mujer|femenin\w*|feminin\w*|mulher|woman)\b/.test(n)) return "f";
  if (/\b(male|hombre|masculin\w*|homem|man)\b/.test(n)) return "m";
  const tokens = n.normalize("NFD").replace(/[\u0300-\u036f]/g, "").split(/[^a-z]+/);
  for (const tk of tokens) {
    if (NAMES_F.has(tk)) return "f";
    if (NAMES_M.has(tk)) return "m";
  }
  if (/google/.test(n)) return "f";
  return "?";
}

function voiceScore(v: SpeechSynthesisVoice): number {
  const n = v.name.toLowerCase();
  let s = 0;
  if (/natural|neural|online|multilingual/.test(n)) s += 50;
  if (/premium|enhanced|siri/.test(n)) s += 45;
  if (/google/.test(n)) s += 30;
  if (!v.localService) s += 8;
  if (/espeak|compact|festival|mbrola|flite/.test(n)) s -= 40;
  if (NOVELTY.test(n)) s -= 80;
  if (v.default) s += 3;
  return s;
}

const voiceTier = (v: SpeechSynthesisVoice): string => {
  const s = voiceScore(v);
  return s >= 45 ? "★★★" : s >= 25 ? "★★" : "★";
};

const normTag = (t: string) => t.toLowerCase().replace("_", "-");
const matchesLang = (v: SpeechSynthesisVoice, lang: Lang) => normTag(v.lang).startsWith(lang);

function rankedVoices(voices: SpeechSynthesisVoice[], lang: Lang): SpeechSynthesisVoice[] {
  const nav = typeof navigator !== "undefined" ? normTag(navigator.language) : "";
  return voices
    .filter((v) => matchesLang(v, lang))
    .map((v) => ({ v, s: voiceScore(v) + (nav && normTag(v.lang) === nav ? 6 : 0) }))
    .sort((a, b) => b.s - a.s || a.v.name.localeCompare(b.v.name))
    .map((x) => x.v);
}

/** Elige la voz: la que fijó el usuario; si no, la mejor del género pedido; si no existe ese género, la mejor con el tono ajustado. */
function pickVoice(voices: SpeechSynthesisVoice[], st: VoiceSettings): { voice: SpeechSynthesisVoice | null; pitchAdj: number } {
  const ranked = rankedVoices(voices, st.lang);
  if (!ranked.length) return { voice: null, pitchAdj: 1 };
  if (st.voiceURI) {
    const chosen = ranked.find((v) => v.voiceURI === st.voiceURI);
    if (chosen) return { voice: chosen, pitchAdj: 1 };
  }
  if (st.gender === "auto") return { voice: ranked[0], pitchAdj: 1 };
  const want = st.gender === "male" ? "m" : "f";
  const match = ranked.find((v) => genderOf(v) === want);
  if (match) return { voice: match, pitchAdj: 1 };
  return { voice: ranked[0], pitchAdj: want === "m" ? 0.8 : 1.12 };
}

const VOICE_KEY = "nab-voice-v1";
const langFromTag = (tag: string): Lang => {
  const p = tag.toLowerCase();
  return p.startsWith("en") ? "en" : p.startsWith("pt") ? "pt" : "es";
};

function loadVoiceSettings(tag: string): VoiceSettings {
  const base: VoiceSettings = { lang: langFromTag(tag), gender: "auto", voiceURI: "", rate: 1, pitch: 1, volume: 1, cloud: true };
  try {
    if (typeof window === "undefined") return base;
    const raw = window.localStorage.getItem(VOICE_KEY);
    if (!raw) return base;
    const j: unknown = JSON.parse(raw);
    if (!isRec(j)) return base;
    if (j.lang === "es" || j.lang === "en" || j.lang === "pt") base.lang = j.lang;
    if (j.gender === "auto" || j.gender === "male" || j.gender === "female") base.gender = j.gender;
    if (typeof j.voiceURI === "string") base.voiceURI = j.voiceURI;
    if (typeof j.rate === "number") base.rate = clamp(j.rate, 0.6, 1.6);
    if (typeof j.pitch === "number") base.pitch = clamp(j.pitch, 0.5, 1.6);
    if (typeof j.volume === "number") base.volume = clamp(j.volume, 0, 1);
    if (typeof j.cloud === "boolean") base.cloud = j.cloud;
  } catch {
    /* sin almacenamiento o datos corruptos: valores por defecto */
  }
  return base;
}

function saveVoiceSettings(st: VoiceSettings): void {
  try {
    window.localStorage.setItem(VOICE_KEY, JSON.stringify(st));
  } catch {
    /* sin almacenamiento */
  }
}

function useVoices(): SpeechSynthesisVoice[] {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  useEffect(() => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    const synth = window.speechSynthesis;
    const load = () => setVoices(synth.getVoices());
    load();
    synth.addEventListener("voiceschanged", load);
    const t1 = window.setTimeout(load, 400);
    const t2 = window.setTimeout(load, 1500);
    return () => {
      synth.removeEventListener("voiceschanged", load);
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, []);
  return voices;
}

interface SpeakHandlers {
  onProgress?: (p: number) => void;
  onEnd: () => void;
  onError?: (why: string) => void;
}

/**
 * Motor de voz: frases una a una con las voces del navegador (o con tu proveedor `ttsFetch`, con
 * amplitud real del audio para mover la boca). Informa del progreso para sincronizar el texto.
 */
class Speaker {
  amp = 0;
  pulse = 0;
  boundarySeen = false;
  cloudLive = false;
  private token = 0;
  private h: SpeakHandlers | null = null;
  private abort: (() => void) | null = null;
  private audio: HTMLAudioElement | null = null;
  private ctx: AudioContext | null = null;
  private keep: SpeechSynthesisUtterance[] = [];
  private cloudBroken = false;

  cancel(): void {
    this.token++;
    this.cloudLive = false;
    this.amp = 0;
    if (typeof window !== "undefined" && "speechSynthesis" in window) window.speechSynthesis.cancel();
    if (this.audio) {
      this.audio.pause();
      this.audio = null;
    }
    const a = this.abort;
    this.abort = null;
    if (a) a();
    const h = this.h;
    this.h = null;
    this.keep = [];
    if (h) h.onEnd();
  }

  async speak(text: string, st: VoiceSettings, h: SpeakHandlers, cloud?: TtsFetch): Promise<void> {
    this.cancel();
    const tok = this.token;
    this.h = h;
    this.boundarySeen = false;
    const chunks = splitChunks(speechText(text, st.lang));
    const total = Math.max(1, chunks.reduce((n, c) => n + c.length + 1, 0));
    const blobs: Promise<Blob>[] = [];
    const getBlob = (i: number): Promise<Blob> => {
      if (!blobs[i] && cloud) {
        blobs[i] = cloud({ text: chunks[i], lang: st.lang, gender: st.gender, voice: st.voiceURI });
        blobs[i].catch(() => undefined);
      }
      return blobs[i];
    };
    await new Promise<void>((r) => window.setTimeout(r, 60));
    let base = 0;
    for (let i = 0; i < chunks.length && tok === this.token; i++) {
      const chunk = chunks[i];
      let done = false;
      if (cloud && st.cloud && !this.cloudBroken) {
        try {
          const cur = getBlob(i);
          if (i + 1 < chunks.length) getBlob(i + 1);
          await this.playBlob(await cur, base, chunk.length, total, tok, h);
          done = true;
        } catch {
          if (tok === this.token) {
            this.cloudBroken = true;
            if (h.onError) h.onError("cloud");
          }
        }
      }
      if (!done && tok === this.token) await this.playBrowser(chunk, base, total, st, tok, h);
      base += chunk.length + 1;
    }
    if (tok === this.token) {
      this.h = null;
      this.keep = [];
      h.onEnd();
    }
  }

  private playBrowser(chunk: string, base: number, total: number, st: VoiceSettings, tok: number, h: SpeakHandlers): Promise<void> {
    return new Promise<void>((resolve) => {
      if (typeof window === "undefined" || !("speechSynthesis" in window)) {
        if (h.onError) h.onError("unsupported");
        resolve();
        return;
      }
      const synth = window.speechSynthesis;
      const { voice, pitchAdj } = pickVoice(synth.getVoices(), st);
      const u = new SpeechSynthesisUtterance(chunk);
      if (voice) {
        u.voice = voice;
        u.lang = voice.lang;
      } else {
        u.lang = LANG_BCP[st.lang];
      }
      u.rate = st.rate;
      u.pitch = clamp(st.pitch * pitchAdj, 0, 2);
      u.volume = st.volume;
      let started = false;
      let settled = false;
      let watchdog = 0;
      const finish = () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(watchdog);
        this.abort = null;
        resolve();
      };
      watchdog = window.setTimeout(() => {
        if (!started && tok === this.token) {
          synth.cancel();
          if (h.onError) h.onError("timeout");
          finish();
        }
      }, 4000);
      u.onstart = () => {
        started = true;
      };
      u.onboundary = (e) => {
        if (tok !== this.token) return;
        this.boundarySeen = true;
        this.pulse = 1;
        const len = Number((e as unknown as { charLength?: number }).charLength) || 0;
        if (h.onProgress) h.onProgress((base + e.charIndex + len) / total);
      };
      u.onend = () => {
        if (h.onProgress) h.onProgress(Math.min(1, (base + chunk.length + 1) / total));
        finish();
      };
      u.onerror = (e) => {
        if (e.error !== "canceled" && e.error !== "interrupted" && h.onError) h.onError(String(e.error));
        finish();
      };
      this.keep.push(u);
      this.abort = finish;
      synth.speak(u);
    });
  }

  private playBlob(blob: Blob, base: number, len: number, total: number, tok: number, h: SpeakHandlers): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      this.audio = audio;
      const data = new Uint8Array(512);
      let analyser: AnalyserNode | null = null;
      try {
        const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (Ctor) {
          if (!this.ctx) this.ctx = new Ctor();
          void this.ctx.resume();
          const src = this.ctx.createMediaElementSource(audio);
          analyser = this.ctx.createAnalyser();
          analyser.fftSize = 512;
          src.connect(analyser);
          analyser.connect(this.ctx.destination);
        }
      } catch {
        analyser = null;
      }
      let raf = 0;
      let settled = false;
      const end = (err?: unknown) => {
        if (settled) return;
        settled = true;
        cancelAnimationFrame(raf);
        this.cloudLive = false;
        this.amp = 0;
        URL.revokeObjectURL(url);
        this.abort = null;
        if (this.audio === audio) this.audio = null;
        if (err) reject(err);
        else resolve();
      };
      const loop = () => {
        raf = requestAnimationFrame(loop);
        if (tok !== this.token) return;
        if (analyser) {
          analyser.getByteTimeDomainData(data);
          let sum = 0;
          for (let i = 0; i < data.length; i++) {
            const x = (data[i] - 128) / 128;
            sum += x * x;
          }
          this.amp = Math.min(1, Math.sqrt(sum / data.length) * 3);
        } else {
          this.amp = 0.3 + 0.4 * Math.random();
        }
        if (audio.duration > 0 && h.onProgress) h.onProgress(Math.min(1, (base + len * (audio.currentTime / audio.duration)) / total));
      };
      audio.onended = () => end();
      audio.onerror = () => end(new Error("audio"));
      this.abort = () => end();
      audio
        .play()
        .then(() => {
          this.cloudLive = true;
          loop();
        })
        .catch((e: unknown) => end(e ?? new Error("play")));
    });
  }
}

function composeBriefing(items: DataItem[], rnd: () => number, lang: Lang): Draft | null {
  if (!items.length) return null;
  const t = I18N[lang];
  const pool = items.slice(0, 14);
  const a = pool[Math.floor(rnd() * pool.length)];
  const tone = a.risk === null ? t.obs : a.risk >= 80 ? t.crit : a.risk >= 60 ? t.warn : t.obs;
  const text = `${tone} ${t.briefing(a, catName(lang, a.category))}`;
  return { role: "agent", author: agentFor(a.category).name, text, refs: [a.id], risk: a.risk ?? undefined };
}

/* ───────────────────────────── Geometría del avatar ───────────────────────────── */

interface FaceData {
  pos: Float32Array;
  nrm: Float32Array;
  lum: Float32Array;
  region: Uint8Array;
  count: number;
  cell: number;
  torsoCell: number;
  mouthY: number;
}

const smooth = (a: number, b: number, x: number): number => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

/** Decodifica el formato NAF1 (cabeza reconstruida de las fotos + torso). */
function parseFace(buf: ArrayBuffer): FaceData {
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== 0x3146414e) throw new Error("Formato NAF1 inválido");
  const hlen = dv.getUint32(4, true);
  const hdr: unknown = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 12, hlen)));
  if (!isRec(hdr) || typeof hdr.count !== "number" || typeof hdr.posScale !== "number") throw new Error("Cabecera NAF1 inválida");
  const n = hdr.count;
  let off = 12 + hlen;
  const pos16 = new Int16Array(buf, off, n * 3); off += n * 6;
  const nrm8 = new Int8Array(buf, off, n * 3); off += n * 3;
  const lum8 = new Uint8Array(buf, off, n); off += n;
  const region = new Uint8Array(buf, off, n);
  const pos = new Float32Array(n * 3);
  const nrm = new Float32Array(n * 3);
  const lum = new Float32Array(n);
  for (let i = 0; i < n * 3; i++) {
    pos[i] = pos16[i] / hdr.posScale;
    nrm[i] = nrm8[i] / 127;
  }
  for (let i = 0; i < n; i++) lum[i] = lum8[i] / 255;
  const mouth = isRec(hdr.mouth) && typeof hdr.mouth.y === "number" ? hdr.mouth.y : 0.7;
  return { pos, nrm, lum, region: region.slice(), count: n, cell: typeof hdr.cell === "number" ? hdr.cell : 0.018, torsoCell: 0.032, mouthY: mouth };
}

/** Descomprime el rostro incrustado al final de este archivo (gzip + base64). */
async function embeddedFace(): Promise<ArrayBuffer> {
  if (typeof DecompressionStream === "undefined") throw new Error("Este navegador no tiene DecompressionStream");
  const bin = atob(FACE_GZ_B64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).arrayBuffer();
}

/** Usa faceSrc si se indica y responde; si no, el rostro incrustado. */
async function loadFace(url: string | undefined, signal: AbortSignal): Promise<FaceData> {
  if (url) {
    try {
      const res = await fetch(url, { signal });
      if (res.ok) return parseFace(await res.arrayBuffer());
    } catch {
      /* se usa el rostro incrustado */
    }
  }
  return parseFace(await embeddedFace());
}

/** Busto genérico en retícula (elipsoide + cuello + hombros): plantilla para fotos y respaldo. */
function buildGenericFace(): FaceData {
  const cell = 0.013;
  const torsoCell = 0.032;
  const P: number[] = [];
  const N: number[] = [];
  const L: number[] = [];
  const R: number[] = [];
  const cy = 1.16;
  const ry = 0.81;
  const rxb = 0.56;
  const rzb = 0.64;
  let phi = -1.45;
  while (phi < Math.PI / 2 - 0.015) {
    const cp = Math.cos(phi);
    const sp = Math.sin(phi);
    const jaw = 1 - 0.2 * Math.max(0, -sp);
    const rx = rxb * cp * jaw;
    const rz = rzb * cp;
    const y = cy + ry * sp;
    const per = TAU * Math.sqrt((rx * rx + rz * rz) / 2);
    const n = Math.max(1, Math.round(per / cell));
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU;
      const sa = Math.sin(a);
      const ca = Math.cos(a);
      const nx = (sa * cp) / rxb;
      const ny = sp / ry;
      const nz = (ca * cp) / rzb;
      const nl = Math.hypot(nx, ny, nz);
      P.push(rx * sa, y, rz * ca);
      N.push(nx / nl, ny / nl, nz / nl);
      L.push(0.62);
      R.push(0);
    }
    phi += cell / Math.hypot(ry * cp, ((rxb + rzb) / 2) * sp);
  }
  return {
    pos: new Float32Array(P),
    nrm: new Float32Array(N),
    lum: new Float32Array(L),
    region: new Uint8Array(R),
    count: R.length,
    cell,
    torsoCell,
    mouthY: 0.66,
  };
}

function faceGeometry(f: FaceData): THREE.BufferGeometry {
  const n = f.count;
  const rnd = mulberry32(4242);
  const seed = new Float32Array(n);
  const mouth = new Float32Array(n);
  const dis = new Float32Array(n);
  const cellA = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = f.pos[i * 3];
    const y = f.pos[i * 3 + 1];
    const nz = f.nrm[i * 3 + 2];
    seed[i] = rnd();
    const head = f.region[i] === 0;
    cellA[i] = head ? f.cell : f.torsoCell;
    if (head) {
      const front = clamp((nz - 0.15) / 0.4, 0, 1);
      const gx = Math.exp(-((x / 0.32) ** 2));
      const dy = y - f.mouthY;
      if (dy <= 0.06 && dy > -0.45) {
        const c = clamp(-dy / 0.3, 0, 1);
        mouth[i] = front * gx * (0.35 + 0.65 * c) * (1 - clamp((-dy - 0.3) / 0.15, 0, 1));
      } else if (dy > 0.06 && dy < 0.15) {
        mouth[i] = -0.25 * front * gx * (1 - (dy - 0.06) / 0.09);
      }
      dis[i] = rnd() < smooth(0.1, 0.58, x) * 0.55 ? 1 : 0;
    } else {
      dis[i] = rnd() < smooth(0.3, 1.7, x) * 0.5 ? 1 : 0;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(f.pos, 3));
  g.setAttribute("aNormal", new THREE.BufferAttribute(f.nrm, 3));
  g.setAttribute("aLum", new THREE.BufferAttribute(f.lum, 1));
  g.setAttribute("aSeed", new THREE.BufferAttribute(seed, 1));
  g.setAttribute("aMouth", new THREE.BufferAttribute(mouth, 1));
  g.setAttribute("aDis", new THREE.BufferAttribute(dis, 1));
  g.setAttribute("aCell", new THREE.BufferAttribute(cellA, 1));
  return g;
}

function nodePosition(it: DataItem, rnd: () => number): [number, number, number] {
  const h = mulberry32(hash32(it.category));
  const cy = (h() * 2 - 1) * 0.7;
  const ca = h() * TAU;
  const k = Math.sqrt(1 - cy * cy);
  const dir = new THREE.Vector3(Math.cos(ca) * k, cy, Math.sin(ca) * k);
  const gauss = () => (rnd() + rnd() + rnd() - 1.5) * 0.7;
  const clampR = (x: number, z: number): [number, number] => {
    const r = Math.hypot(x, z);
    return r > 2.6 ? [(x * 2.6) / r, (z * 2.6) / r] : [x, z];
  };
  for (let tries = 0; tries < 24; tries++) {
    const rad = 1.5 + rnd() * 0.9;
    const y = 1.15 + dir.y * rad * 0.8 + gauss() * 0.7;
    const [x, z] = clampR(dir.x * rad + gauss(), dir.z * rad + gauss());
    if ((x / 0.95) ** 2 + ((y - 1.15) / 1.1) ** 2 + (z / 0.95) ** 2 >= 1) return [x, y, z];
  }
  return [dir.x * 2.2, 1.15 + dir.y * 1.6, dir.z * 2.2];
}

/* ───────────────────────────── Shaders ───────────────────────────── */
/* Todos dibujan cuadrados huecos de esquinas redondeadas (look halftone); si son muy pequeños se rellenan. */

const SQUARE_FS = /* glsl */ `
varying vec3 vColor;
varying float vAlpha;
varying float vSize;
void main() {
  vec2 q = abs(gl_PointCoord - 0.5) * 2.0;
  float r = 0.22;
  vec2 p = q - (1.0 - r);
  float dist = length(max(p, 0.0)) + min(max(p.x, p.y), 0.0) - r;
  float aa = 1.2 / max(vSize, 1.0);
  float outer = 1.0 - smoothstep(-aa, aa, dist);
  float t = max(2.2 / max(vSize, 1.0), 0.14);
  float inner = 1.0 - smoothstep(-t - aa, -t + aa, dist);
  float fill = 1.0 - smoothstep(3.5, 5.0, vSize);
  float a = outer - inner * (1.0 - fill);
  if (a < 0.02) discard;
  gl_FragColor = vec4(vColor, a * vAlpha);
}`;

const AVATAR_VS = /* glsl */ `
attribute vec3 aNormal;
attribute float aLum;
attribute float aSeed;
attribute float aMouth;
attribute float aDis;
attribute float aCell;
uniform float uTime;
uniform float uAmp;
uniform float uScale;
uniform float uMotion;
varying vec3 vColor;
varying float vAlpha;
varying float vSize;
void main() {
  vec3 p = position;
  p.y += sin(uTime * 0.8) * 0.01 * (p.y + 1.5) * uMotion;
  p += vec3(sin(uTime * 0.9 + aSeed * 40.0), cos(uTime * 0.7 + aSeed * 71.0), 0.0) * 0.0035 * uMotion;
  p.y -= aMouth * uAmp * 0.06;
  p.z += aMouth * uAmp * 0.012;
  float alpha = 1.0;
  if (aDis > 0.5) {
    float ph = fract(uTime * (0.035 + 0.04 * aSeed) + aSeed * 7.0);
    vec3 dir = vec3(1.0, (aSeed - 0.5) * 0.9, fract(aSeed * 13.0) - 0.3);
    p += dir * ph * ph * (0.5 + 1.6 * aSeed) * uMotion;
    float life = smoothstep(0.0, 0.06, ph) * (1.0 - smoothstep(0.35, 1.0, ph));
    alpha = mix(1.0, life, uMotion);
  }
  alpha *= smoothstep(0.29, 0.35, position.y);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vec3 n = normalize(normalMatrix * aNormal);
  float vis = smoothstep(-0.02, 0.22, n.z);
  float lam = clamp(dot(n, normalize(vec3(-0.55, 0.35, 0.75))), 0.0, 1.0);
  float b = clamp(aLum * (0.7 + 0.5 * lam) * (1.0 + uAmp * 0.25), 0.0, 1.0);
  float wsz = aCell * (0.18 + 0.66 * pow(b, 0.9));
  gl_Position = projectionMatrix * mv;
  float ps = wsz * uScale / -mv.z;
  gl_PointSize = ps;
  vSize = ps;
  vAlpha = alpha * vis * smoothstep(0.6, 1.4, ps);
  vColor = vec3(0.93, 0.89, 0.80) * (0.5 + 0.55 * b);
}`;

const NODE_VS = /* glsl */ `
attribute vec3 aColor;
attribute float aSize;
attribute float aOrbit;
attribute float aBoost;
uniform float uTime;
uniform float uScale;
varying vec3 vColor;
varying float vAlpha;
varying float vSize;
void main() {
  float a = uTime * aOrbit;
  float c = cos(a);
  float s = sin(a);
  vec3 p = vec3(
    position.x * c + position.z * s,
    position.y + sin(uTime * 0.6 + aOrbit * 40.0) * 0.05,
    -position.x * s + position.z * c);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float pulse = 1.0 + aBoost * (0.7 + 0.35 * sin(uTime * 6.0));
  float ps = aSize * pulse * uScale / -mv.z;
  gl_PointSize = ps;
  vSize = ps;
  vAlpha = 1.0;
  vColor = aColor * (1.0 + aBoost * 0.6);
}`;

const GRID_VS = /* glsl */ `
uniform float uTime;
uniform float uScale;
varying vec3 vColor;
varying float vAlpha;
varying float vSize;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  float w = sin(position.x * 1.1 + position.y * 0.8 + uTime * 0.5) * 0.5 + 0.5;
  float ps = 0.045 * uScale / -mv.z;
  gl_PointSize = ps;
  vSize = ps;
  vAlpha = 0.04 + 0.1 * w * w;
  vColor = vec3(0.75, 0.82, 0.86);
}`;

const TRAIL_VS = /* glsl */ `
attribute float aAlpha;
attribute float aSizeW;
uniform float uScale;
varying vec3 vColor;
varying float vAlpha;
varying float vSize;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  float ps = aSizeW * uScale / -mv.z;
  gl_PointSize = ps;
  vSize = ps;
  vAlpha = aAlpha;
  vColor = vec3(0.93, 0.89, 0.80);
}`;

/* ───────────────────────────── Estilos ───────────────────────────── */

const CSS = `
.nab-root{--void:#010305;--ink:#d9f4ff;--dim:#6f93a6;--ice:#5cf0ff;--amber:#ffc24d;--hot:#ff3d8b;--ok:#38ffb0;--line:rgba(92,240,255,.18);
position:relative;width:100%;height:100%;min-height:520px;overflow:hidden;background:var(--void);color:var(--ink);
font-family:"IBM Plex Sans","Segoe UI",system-ui,sans-serif;-webkit-font-smoothing:antialiased}
.nab-mono{font-family:"JetBrains Mono","IBM Plex Mono",ui-monospace,Consolas,Menlo,monospace}
.nab-canvas{position:absolute;inset:0;touch-action:pan-y;cursor:grab}
.nab-canvas:active{cursor:grabbing}
.nab-canvas canvas{display:block;width:100%;height:100%}
.nab-hud{position:absolute;left:16px;top:14px;pointer-events:none;font-size:11px;letter-spacing:.08em;line-height:1.7}
.nab-hud b{font-weight:600;font-size:13px;letter-spacing:.14em;color:var(--ice)}
.nab-badge{display:inline-flex;align-items:center;gap:6px;color:var(--dim)}
.nab-dot{width:7px;height:7px;border-radius:50%;background:var(--ice);box-shadow:0 0 8px currentColor}
.nab-dot.live{background:var(--ok);color:var(--ok)}
.nab-dot.connecting{background:var(--ice);color:var(--ice);animation:nab-blink 1s infinite}
@keyframes nab-blink{50%{opacity:.25}}
.nab-label{position:absolute;left:0;top:0;pointer-events:none;font-size:10px;white-space:nowrap;opacity:0;
transform:translate(-9999px,-9999px);padding-left:7px;border-left:1px solid currentColor;transition:opacity .25s}
.nab-tip{position:absolute;left:0;top:0;pointer-events:none;max-width:260px;padding:8px 10px;font-size:11px;line-height:1.45;
background:rgba(2,9,14,.9);border:1px solid var(--line);opacity:0;transform:translate(-9999px,-9999px);z-index:3}
.nab-panel{position:absolute;right:12px;top:56px;bottom:12px;width:380px;transition:transform .38s cubic-bezier(.2,.8,.2,1),opacity .3s;display:flex;flex-direction:column;
background:rgba(2,9,14,.74);border:1px solid var(--line);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);z-index:2}
.nab-feed{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:9px;scrollbar-width:thin;scrollbar-color:var(--line) transparent}
.nab-msg{border-left:2px solid var(--accent,var(--ice));padding:6px 10px 8px;background:rgba(92,240,255,.045)}
.nab-msg.user{--accent:#ffffff;background:rgba(255,255,255,.06);margin-left:28px}
.nab-msg-h{display:flex;justify-content:space-between;font-size:10px;letter-spacing:.08em;color:var(--accent,var(--ice));margin-bottom:3px}
.nab-msg-t{font-size:13px;line-height:1.5;color:var(--ink);word-wrap:break-word}
.nab-caret{display:inline-block;width:6px;height:12px;margin-left:2px;vertical-align:-1px;background:var(--ice);animation:nab-blink .8s infinite}
.nab-bar{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 12px;border-top:1px solid var(--line);font-size:10px;color:var(--dim)}
.nab-wave{display:flex;align-items:flex-end;gap:2px;height:18px}
.nab-wave i{display:block;width:3px;height:2px;background:var(--ice);opacity:.85}
.nab-ctl{display:flex;gap:6px;padding:0 12px 8px}
.nab-btn{flex:1;font:inherit;font-size:11px;padding:6px 8px;color:var(--amber);background:transparent;border:1px solid rgba(255,194,77,.4);cursor:pointer}
.nab-btn:hover{background:rgba(255,194,77,.1)}
.nab-btn:focus-visible,.nab-in:focus-visible{outline:2px solid var(--ice);outline-offset:1px}
.nab-ask{display:flex;gap:6px;padding:0 12px 12px}
.nab-in{flex:1;min-width:0;font:inherit;font-size:13px;color:var(--ink);background:rgba(0,0,0,.45);border:1px solid var(--line);padding:8px 10px}
.nab-go{font:inherit;font-size:12px;padding:8px 12px;color:#021016;background:var(--ice);border:0;cursor:pointer}
.nab-card{position:absolute;left:16px;bottom:16px;width:290px;padding:10px 12px;background:rgba(2,9,14,.85);border:1px solid var(--line);
backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);font-size:12px;line-height:1.5;z-index:2}
.nab-risk{height:3px;background:rgba(255,255,255,.1);margin:6px 0}
.nab-risk i{display:block;height:100%}
@media (max-width:760px){
 .nab-panel{left:8px;right:8px;top:auto;bottom:8px;width:auto;height:44%}
 .nab-hud{font-size:9px;left:10px;top:8px}
 .nab-hud b{font-size:11px}
 .nab-card{left:8px;bottom:auto;top:56px;width:min(290px,calc(100% - 16px))}
}
.nab-canvas{touch-action:none}
.nab-tools{position:absolute;left:16px;top:96px;display:flex;flex-direction:column;gap:6px;z-index:2;align-items:flex-start}
.nab-tool{font:inherit;font-size:11px;padding:6px 10px;color:var(--ink);background:rgba(2,9,14,.7);border:1px solid var(--line);cursor:pointer;backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px)}
.nab-tool:hover{border-color:var(--ice)}
.nab-tool.on{color:#021016;background:var(--ice);border-color:var(--ice)}
.nab-tool:focus-visible{outline:2px solid var(--ice);outline-offset:1px}
.nab-modal{position:absolute;inset:0;z-index:6;display:flex;align-items:center;justify-content:center;background:rgba(1,3,5,.84);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px)}
.nab-sheet{width:min(740px,calc(100% - 24px));max-height:calc(100% - 24px);overflow:auto;display:grid;grid-template-columns:300px 1fr;gap:16px;padding:14px;background:rgba(2,9,14,.96);border:1px solid var(--line)}
.nab-pv{position:relative;width:300px;max-width:100%}
.nab-pvc{display:block;width:100%;height:auto;border:1px solid var(--line);cursor:move;touch-action:none;background:#04080c}
.nab-drop{position:absolute;inset:0;margin:auto;width:80%;height:72px;font:inherit;font-size:12px;color:var(--ink);background:rgba(2,9,14,.8);border:1px dashed var(--ice);cursor:pointer}
.nab-form{display:flex;flex-direction:column;gap:10px;font-size:12px}
.nab-form h2{margin:0;font-size:14px;letter-spacing:.14em;color:var(--ice);font-weight:600}
.nab-form p{margin:0;color:var(--dim);line-height:1.5}
.nab-row{display:flex;gap:8px}
.nab-field{display:flex;flex-direction:column;gap:4px;color:var(--dim)}
.nab-field input[type=range]{width:100%;accent-color:#5cf0ff}
.nab-field select{font:inherit;font-size:12px;color:var(--ink);background:rgba(0,0,0,.5);border:1px solid var(--line);padding:6px}
.nab-check{display:flex;align-items:center;gap:8px;color:var(--ink)}
.nab-btn:disabled,.nab-go:disabled{opacity:.45;cursor:default}
.nab-err{color:var(--hot);font-size:12px}
@media (max-width:760px){
 .nab-tools{left:10px;top:78px}
 .nab-sheet{grid-template-columns:1fr}
 .nab-pv{margin:0 auto}
}
.nab-panel.hide{transform:translateX(calc(100% + 24px));opacity:0;visibility:hidden;pointer-events:none;transition:transform .38s cubic-bezier(.2,.8,.2,1),opacity .3s,visibility 0s .38s}
.nab-toggle{position:absolute;right:12px;top:12px;z-index:4;display:flex;align-items:center;gap:8px;font:inherit;font-size:11px;letter-spacing:.06em;padding:8px 12px;color:var(--ink);background:rgba(2,9,14,.72);border:1px solid var(--line);cursor:pointer;backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px)}
.nab-toggle:hover{border-color:var(--ice)}
.nab-toggle:focus-visible{outline:2px solid var(--ice);outline-offset:1px}
.nab-chev{display:inline-block;width:7px;height:7px;border-right:2px solid var(--ice);border-top:2px solid var(--ice);transform:rotate(-135deg);transition:transform .3s}
.nab-chev.is-open{transform:rotate(45deg)}
.nab-unread{min-width:16px;padding:1px 5px;border-radius:9px;background:var(--hot);color:#fff;font-size:10px;text-align:center}
.nab-voice{position:absolute;left:50%;bottom:22px;transform:translateX(-50%);width:min(560px,calc(100% - 32px));z-index:2;pointer-events:none;text-align:center;animation:nab-rise .4s ease both}
.nab-voice canvas{display:block;width:100%;height:92px;mix-blend-mode:screen}
.nab-cap{margin-top:6px;font-size:11px;color:rgba(237,227,204,.78);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-shadow:0 0 8px rgba(1,3,5,.95)}
@keyframes nab-rise{from{opacity:0;transform:translate(-50%,12px)}to{opacity:1;transform:translate(-50%,0)}}
@media (max-width:760px){
 .nab-panel.hide{transform:translateY(calc(100% + 16px))}
 .nab-chev{transform:rotate(-45deg)}
 .nab-chev.is-open{transform:rotate(135deg)}
}
.nab-sheet.one{grid-template-columns:1fr;width:min(460px,calc(100% - 24px))}
.nab-seg{display:flex}
.nab-segbtn{flex:1;font:inherit;font-size:12px;padding:7px 8px;color:var(--ink);background:rgba(0,0,0,.45);border:1px solid var(--line);cursor:pointer;margin-left:-1px}
.nab-segbtn:first-child{margin-left:0}
.nab-segbtn.on{color:#021016;background:var(--ice);border-color:var(--ice)}
.nab-segbtn:focus-visible{outline:2px solid var(--ice);outline-offset:1px;position:relative;z-index:1}
.nab-warn{color:var(--amber);font-size:11px;line-height:1.5}
.nab-gear{flex:0 0 40px}
@media (prefers-reduced-motion:reduce){.nab-caret,.nab-dot.connecting,.nab-voice{animation:none}.nab-panel,.nab-panel.hide,.nab-chev{transition:none}}
`;

/* ───────────────────────────── Componente ───────────────────────────── */

interface VoiceModalProps {
  st: VoiceSettings;
  voices: SpeechSynthesisVoice[];
  hasCloud: boolean;
  onChange: (p: Partial<VoiceSettings>) => void;
  onTest: () => void;
  onClose: () => void;
}

const GENDERS: [Gender, string][] = [["auto", "Auto"], ["male", "Hombre"], ["female", "Mujer"]];

function VoiceModal({ st, voices, hasCloud, onChange, onTest, onClose }: VoiceModalProps) {
  const list = useMemo(() => rankedVoices(voices, st.lang), [voices, st.lang]);
  const supported = typeof window !== "undefined" && "speechSynthesis" in window;
  const mark = (v: SpeechSynthesisVoice) => (genderOf(v) === "f" ? " ♀" : genderOf(v) === "m" ? " ♂" : "");
  return (
    <div
      className="nab-modal"
      role="dialog"
      aria-modal="true"
      aria-label="Ajustes de voz"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="nab-sheet one">
        <div className="nab-form nab-mono">
          <h2>Voz del avatar</h2>
          <div className="nab-field">
            <span>Idioma de la voz y del diálogo</span>
            <div className="nab-seg" role="group" aria-label="Idioma">
              {LANGS.map((l) => (
                <button key={l} className={`nab-segbtn${st.lang === l ? " on" : ""}`} aria-pressed={st.lang === l} onClick={() => onChange({ lang: l, voiceURI: "" })}>
                  {LANG_NAME[l]}
                </button>
              ))}
            </div>
          </div>
          <div className="nab-field">
            <span>Tipo de voz</span>
            <div className="nab-seg" role="group" aria-label="Tipo de voz">
              {GENDERS.map(([g, label]) => (
                <button key={g} className={`nab-segbtn${st.gender === g ? " on" : ""}`} aria-pressed={st.gender === g} onClick={() => onChange({ gender: g, voiceURI: "" })}>
                  {label}
                </button>
              ))}
            </div>
          </div>
          <label className="nab-field">
            <span>Voz ({list.length} disponibles en este idioma)</span>
            <select value={st.voiceURI} onChange={(e) => onChange({ voiceURI: e.target.value })}>
              <option value="">Automática (la mejor disponible)</option>
              {list.map((v) => (
                <option key={v.voiceURI} value={v.voiceURI}>{`${voiceTier(v)} ${v.name}${mark(v)}`}</option>
              ))}
            </select>
          </label>
          {!supported && <div className="nab-warn">Este navegador no incluye síntesis de voz.</div>}
          {supported && list.length === 0 && (
            <div className="nab-warn">
              No hay voces instaladas en este idioma. Instala una en los ajustes de voz del sistema o prueba otro navegador.
            </div>
          )}
          {st.gender !== "auto" && list.length > 0 && !st.voiceURI && !list.some((v) => genderOf(v) === (st.gender === "male" ? "m" : "f")) && (
            <div className="nab-warn">No hay una voz {st.gender === "male" ? "masculina" : "femenina"} instalada: se usará la mejor disponible con el tono ajustado.</div>
          )}
          <label className="nab-field">
            <span>Velocidad {st.rate.toFixed(2)}</span>
            <input type="range" min={0.6} max={1.6} step={0.05} value={st.rate} onChange={(e) => onChange({ rate: Number(e.target.value) })} />
          </label>
          <label className="nab-field">
            <span>Tono {st.pitch.toFixed(2)}</span>
            <input type="range" min={0.5} max={1.6} step={0.05} value={st.pitch} onChange={(e) => onChange({ pitch: Number(e.target.value) })} />
          </label>
          <label className="nab-field">
            <span>Volumen {Math.round(st.volume * 100)}%</span>
            <input type="range" min={0} max={1} step={0.05} value={st.volume} onChange={(e) => onChange({ volume: Number(e.target.value) })} />
          </label>
          {hasCloud && (
            <label className="nab-check">
              <input type="checkbox" checked={st.cloud} onChange={(e) => onChange({ cloud: e.target.checked })} /> Usar voz en la nube (ttsFetch)
            </label>
          )}
          <p>
            Las voces ★★★ son las más naturales: Edge (Natural), Chrome (Google) y macOS/iOS (Premium o Enhanced, desde Ajustes del
            sistema). Para calidad de estudio conecta <b>ttsFetch</b> a un servicio de voz.
          </p>
          <div className="nab-row">
            <button className="nab-go" onClick={onTest}>Probar voz</button>
            <button className="nab-btn" onClick={onClose}>Cerrar</button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ───────────────────────────── Foto a avatar ───────────────────────────── */
/* Todo se procesa en el navegador: la foto no sale del dispositivo. */

/** Cuadro de la vista previa: la coronilla (y=1.97) cae en v=50 y la barbilla (y=0.35) en v=300. */
const PV = { w: 300, h: 380, sf: 250 / 1.62, top: 50, chin: 300 };
const previewX = (x: number) => PV.w / 2 + PV.sf * x;
const previewY = (y: number) => PV.chin - PV.sf * (y - 0.35);
const FRAME_C = { x: PV.w / 2, y: previewY(1.15) };

interface PhotoSource {
  canvas: HTMLCanvasElement;
  w: number;
  h: number;
  mask: Uint8Array | null;
  mw: number;
  mh: number;
}
interface PhotoTransform {
  k: number;
  cx: number;
  cy: number;
  rot: number;
}
interface PhotoPixels {
  lum: Float32Array;
  alpha: Float32Array;
  w: number;
  h: number;
}

const clampi = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

function boxOp(m: Uint8Array, w: number, h: number, r: number, dilate: boolean): Uint8Array {
  const tmp = new Uint8Array(m.length);
  const out = new Uint8Array(m.length);
  const hit = dilate ? 1 : 0;
  const idle = dilate ? 0 : 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = idle;
      for (let k = -r; k <= r; k++) {
        const xx = x + k;
        const s = xx < 0 || xx >= w ? idle : m[y * w + xx];
        if (s === hit) { v = hit; break; }
      }
      tmp[y * w + x] = v;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = idle;
      for (let k = -r; k <= r; k++) {
        const yy = y + k;
        const s = yy < 0 || yy >= h ? idle : tmp[yy * w + x];
        if (s === hit) { v = hit; break; }
      }
      out[y * w + x] = v;
    }
  }
  return out;
}

function fillHoles(m: Uint8Array, w: number, h: number): Uint8Array {
  const outside = new Uint8Array(m.length);
  const stack: number[] = [];
  const push = (i: number) => {
    if (!m[i] && !outside[i]) { outside[i] = 1; stack.push(i); }
  };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
  while (stack.length) {
    const i = stack.pop() as number;
    const x = i % w;
    const y = (i / w) | 0;
    if (x > 0) push(i - 1);
    if (x < w - 1) push(i + 1);
    if (y > 0) push(i - w);
    if (y < h - 1) push(i + w);
  }
  return m.map((v, i) => (v || !outside[i] ? 1 : 0));
}

function largestComponent(m: Uint8Array, w: number, h: number): Uint8Array {
  const lab = new Int32Array(m.length);
  const stack: number[] = [];
  let best = 0;
  let bestSize = 0;
  let id = 0;
  for (let s = 0; s < m.length; s++) {
    if (!m[s] || lab[s]) continue;
    id++;
    let size = 0;
    stack.push(s);
    lab[s] = id;
    while (stack.length) {
      const i = stack.pop() as number;
      size++;
      const x = i % w;
      const y = (i / w) | 0;
      const nb = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1];
      for (const j of nb) {
        if (j >= 0 && m[j] && !lab[j]) { lab[j] = id; stack.push(j); }
      }
    }
    if (size > bestSize) { bestSize = size; best = id; }
  }
  return m.map((_, i) => (lab[i] === best ? 1 : 0));
}

/** Separa persona y fondo: usa el canal alfa si lo hay; si no, la distancia al color del borde. */
function segmentPhoto(canvas: HTMLCanvasElement): { mask: Uint8Array; mw: number; mh: number } {
  const sc = Math.min(1, 200 / Math.max(canvas.width, canvas.height));
  const mw = Math.max(8, Math.round(canvas.width * sc));
  const mh = Math.max(8, Math.round(canvas.height * sc));
  const tmp = document.createElement("canvas");
  tmp.width = mw;
  tmp.height = mh;
  const ctx = tmp.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Canvas 2D no disponible");
  ctx.drawImage(canvas, 0, 0, mw, mh);
  const d = ctx.getImageData(0, 0, mw, mh).data;
  const n = mw * mh;
  let hasAlpha = false;
  for (let i = 0; i < n; i++) {
    if (d[i * 4 + 3] < 245) { hasAlpha = true; break; }
  }
  let m: Uint8Array = new Uint8Array(n);
  if (hasAlpha) {
    for (let i = 0; i < n; i++) m[i] = d[i * 4 + 3] > 128 ? 1 : 0;
  } else {
    const rs: number[] = [];
    const gs: number[] = [];
    const bs: number[] = [];
    const take = (x: number, y: number) => {
      const i = (y * mw + x) * 4;
      rs.push(d[i]); gs.push(d[i + 1]); bs.push(d[i + 2]);
    };
    for (let x = 0; x < mw; x++) { take(x, 0); take(x, mh - 1); }
    for (let y = 0; y < mh; y++) { take(0, y); take(mw - 1, y); }
    const med = (a: number[]) => a.sort((p, q) => p - q)[a.length >> 1];
    const br = med(rs), bg = med(gs), bb = med(bs);
    for (let i = 0; i < n; i++) {
      const dr = d[i * 4] - br, dg = d[i * 4 + 1] - bg, db = d[i * 4 + 2] - bb;
      m[i] = Math.sqrt(dr * dr + dg * dg + db * db) > 42 ? 1 : 0;
    }
  }
  m = boxOp(boxOp(m, mw, mh, 2, true), mw, mh, 2, false);
  m = fillHoles(m, mw, mh);
  m = largestComponent(m, mw, mh);
  m = boxOp(boxOp(m, mw, mh, 1, false), mw, mh, 1, true);
  return { mask: m, mw, mh };
}

/** Estima coronilla, barbilla y eje de la cabeza a partir del perfil de anchuras de la silueta. */
function headFrame(m: Uint8Array, w: number, h: number): { top: number; chin: number; cx: number } | null {
  const wd = new Float32Array(h);
  const lf = new Float32Array(h);
  const rt = new Float32Array(h);
  let top = -1;
  let bottom = -1;
  let maxW = 0;
  for (let y = 0; y < h; y++) {
    let a = -1, b = -1, c = 0;
    for (let x = 0; x < w; x++) {
      if (m[y * w + x]) { if (a < 0) a = x; b = x; c++; }
    }
    wd[y] = c; lf[y] = a; rt[y] = b;
    if (c > 0.03 * w) { if (top < 0) top = y; bottom = y; }
    maxW = Math.max(maxW, c);
  }
  if (top < 0 || bottom - top < 10) return null;
  const hh = bottom - top;
  const sw = new Float32Array(h);
  for (let y = 0; y < h; y++) {
    let s = 0, n = 0;
    for (let k = -2; k <= 2; k++) {
      const yy = y + k;
      if (yy >= 0 && yy < h) { s += wd[yy]; n++; }
    }
    sw[y] = s / n;
  }
  let chin: number;
  if (hh < 1.45 * maxW) {
    chin = bottom - 0.03 * hh;
  } else {
    // proporción cabeza/anchura (≈1.38 con orejas), medida a la altura de las orejas
    const maxIn = (y0: number, y1: number) => {
      let mx = 0;
      for (let y = Math.max(0, Math.round(y0)); y <= Math.min(h - 1, Math.round(y1)); y++) mx = Math.max(mx, sw[y]);
      return mx;
    };
    let hHead = Math.min(hh, 1.38 * maxIn(top, top + 0.2 * hh));
    for (let it = 0; it < 3; it++) hHead = Math.min(hh, 1.38 * maxIn(top, top + 0.7 * hHead));
    chin = top + hHead;
  }
  let sx = 0, cnt = 0;
  for (let y = Math.round(top + 0.1 * (chin - top)); y <= Math.round(top + 0.5 * (chin - top)); y++) {
    if (lf[y] >= 0) { sx += (lf[y] + rt[y]) / 2; cnt++; }
  }
  return { top, chin, cx: cnt ? sx / cnt : w / 2 };
}

function baseTransform(src: PhotoSource): PhotoTransform {
  const f = src.mask ? headFrame(src.mask, src.mw, src.mh) : null;
  if (f) {
    const sx = src.w / src.mw;
    const sy = src.h / src.mh;
    const topP = f.top * sy;
    const chinP = f.chin * sy;
    const hx = f.cx * sx;
    const k = (PV.chin - PV.top) / Math.max(10, chinP - topP);
    return { k, cx: PV.w / 2 + k * (src.w / 2 - hx), cy: PV.top + k * (src.h / 2 - topP), rot: 0 };
  }
  const k = (PV.chin - PV.top) / (src.h * 0.5);
  return { k, cx: PV.w / 2, cy: PV.top + k * (src.h / 2 - src.h * 0.08), rot: 0 };
}

function composeTransform(b: PhotoTransform, scale: number, dx: number, dy: number, rotDeg: number): PhotoTransform {
  return {
    k: b.k * scale,
    cx: FRAME_C.x + (b.cx - FRAME_C.x) * scale + dx,
    cy: FRAME_C.y + (b.cy - FRAME_C.y) * scale + dy,
    rot: b.rot + (rotDeg * Math.PI) / 180,
  };
}

function previewToPhoto(tf: PhotoTransform, w: number, h: number, u: number, v: number): [number, number] {
  const c = Math.cos(tf.rot);
  const s = Math.sin(tf.rot);
  const dx = (u - tf.cx) / tf.k;
  const dy = (v - tf.cy) / tf.k;
  return [w / 2 + c * dx + s * dy, h / 2 - s * dx + c * dy];
}

function loadPhoto(file: File): Promise<PhotoSource> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const sc = Math.min(1, 640 / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.max(8, Math.round(img.naturalWidth * sc));
      const h = Math.max(8, Math.round(img.naturalHeight * sc));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) { reject(new Error("Canvas 2D no disponible")); return; }
      ctx.drawImage(img, 0, 0, w, h);
      let mask: Uint8Array | null = null;
      let mw = 0;
      let mh = 0;
      try {
        const s = segmentPhoto(canvas);
        mask = s.mask; mw = s.mw; mh = s.mh;
      } catch {
        mask = null;
      }
      resolve({ canvas, w, h, mask, mw, mh });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("No se pudo leer la imagen"));
    };
    img.src = url;
  });
}

function maskedCanvas(src: PhotoSource, useMask: boolean): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = src.w;
  c.height = src.h;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  if (!ctx) return src.canvas;
  ctx.drawImage(src.canvas, 0, 0);
  if (useMask && src.mask) {
    const mc = document.createElement("canvas");
    mc.width = src.mw;
    mc.height = src.mh;
    const mctx = mc.getContext("2d");
    if (mctx) {
      const id = mctx.createImageData(src.mw, src.mh);
      for (let i = 0; i < src.mask.length; i++) id.data[i * 4 + 3] = src.mask[i] ? 255 : 0;
      mctx.putImageData(id, 0, 0);
      ctx.globalCompositeOperation = "destination-in";
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(mc, 0, 0, src.w, src.h);
    }
  }
  return c;
}

function lumaOf(c: HTMLCanvasElement): PhotoPixels {
  const ctx = c.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Canvas 2D no disponible");
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  const n = c.width * c.height;
  const lum = new Float32Array(n);
  const alpha = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    alpha[i] = d[i * 4 + 3] / 255;
    lum[i] = (0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]) / 255;
  }
  return { lum, alpha, w: c.width, h: c.height };
}

function boxBlur(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  const win = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    let s = 0;
    for (let x = -r; x <= r; x++) s += src[y * w + clampi(x, 0, w - 1)];
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = s / win;
      s += src[y * w + clampi(x + r + 1, 0, w - 1)] - src[y * w + clampi(x - r, 0, w - 1)];
    }
  }
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let y = -r; y <= r; y++) s += tmp[clampi(y, 0, h - 1) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = s / win;
      s += tmp[clampi(y + r + 1, 0, h - 1) * w + x] - tmp[clampi(y - r, 0, h - 1) * w + x];
    }
  }
  return out;
}

function bil(a: Float32Array, w: number, h: number, x: number, y: number): number {
  if (x < 0 || y < 0 || x > w - 1 || y > h - 1) return 0;
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
  const fx = x - x0, fy = y - y0;
  return a[y0 * w + x0] * (1 - fx) * (1 - fy) + a[y0 * w + x1] * fx * (1 - fy) + a[y1 * w + x0] * (1 - fx) * fy + a[y1 * w + x1] * fx * fy;
}

/**
 * Convierte la foto en avatar: proyecta su luminancia sobre la plantilla (genérica o la cabeza
 * reconstruida), rellena los lados y la nuca con el tono del pelo y, en la genérica, modela relieve.
 */
function avatarFromPhoto(
  tpl: FaceData,
  kind: "generic" | "base",
  photo: PhotoPixels,
  tf: PhotoTransform,
  contrast: number,
  mirror: boolean,
): FaceData {
  const { lum, alpha, w, h } = photo;
  const rad = Math.max(3, Math.round(Math.min(w, h) * 0.02));
  const blur = boxBlur(lum, w, h, rad);
  const gain = 0.9 * contrast;
  const g = new Float32Array(lum.length);
  for (let i = 0; i < g.length; i++) g[i] = clamp(lum[i] + (lum[i] - blur[i]) * gain, 0, 1);
  const soft = boxBlur(lum, w, h, Math.max(2, Math.round(Math.min(w, h) * 0.012)));
  const n = tpl.count;
  const mapPt = (x: number, y: number): [number, number] => previewToPhoto(tf, w, h, previewX(mirror ? -x : x), previewY(y));

  const front = new Float32Array(n);
  const fa = new Float32Array(n);
  const samples: number[] = [];
  for (let i = 0; i < n; i++) {
    const x = tpl.pos[i * 3];
    const y = tpl.pos[i * 3 + 1];
    const nz = tpl.nrm[i * 3 + 2];
    const [a, b] = mapPt(x, y);
    const al = bil(alpha, w, h, a, b);
    fa[i] = al;
    front[i] = bil(g, w, h, a, b) * al;
    if (tpl.region[i] === 0 && nz > 0.3 && al > 0.6 && y > 0.4 && y < 1.95) samples.push(front[i]);
  }
  let lo = 0;
  let hi = 1;
  if (samples.length > 50) {
    samples.sort((p, q) => p - q);
    lo = samples[Math.floor(samples.length * 0.03)];
    hi = samples[Math.min(samples.length - 1, Math.floor(samples.length * 0.995))];
    if (hi - lo < 0.15) { lo = 0; hi = 1; }
  }
  const stretch = (t: number) => Math.pow(clamp((t - lo) / (hi - lo), 0, 1), 1.4);

  let hairSum = 0;
  let hairN = 0;
  for (let i = 0; i < n; i++) {
    const x = tpl.pos[i * 3];
    const y = tpl.pos[i * 3 + 1];
    if (tpl.region[i] === 0 && y > 1.5 && Math.abs(x) < 0.4 && tpl.nrm[i * 3 + 2] > 0.3 && fa[i] > 0.6) {
      hairSum += stretch(front[i]);
      hairN++;
    }
  }
  const hairMean = hairN > 10 ? hairSum / hairN : 0.5;

  const rnd = mulberry32(777);
  const pos = new Float32Array(tpl.pos);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = tpl.pos[i * 3];
    const y = tpl.pos[i * 3 + 1];
    const nz = tpl.nrm[i * 3 + 2];
    const noise = rnd();
    const fw = smooth(-0.1, 0.5, nz);
    const fr = stretch(front[i]);
    let base: number;
    if (tpl.region[i] === 1 || kind === "base") {
      base = tpl.lum[i];
    } else {
      const [sa, sb] = mapPt(clamp(x, -0.5, 0.5), y);
      const side = stretch(bil(g, w, h, sa, sb) * bil(alpha, w, h, sa, sb));
      const bw = smooth(0.0, -0.7, nz);
      const back = (y > 1.0 ? hairMean : hairMean * 0.65) * (0.75 + 0.5 * noise);
      base = (1 - bw) * side + bw * back;
    }
    out[i] = fw * fr + (1 - fw) * base;
    if (kind === "generic" && tpl.region[i] === 0) {
      const [a, b] = mapPt(x, y);
      const s = bil(soft, w, h, a, b) * fa[i];
      const band = smooth(0.4, 0.6, y) * (1 - smooth(1.7, 1.95, y));
      const disp = (s - 0.45) * 0.045 * fw * band;
      pos[i * 3] += tpl.nrm[i * 3] * disp;
      pos[i * 3 + 1] += tpl.nrm[i * 3 + 1] * disp;
      pos[i * 3 + 2] += tpl.nrm[i * 3 + 2] * disp;
    }
  }
  return { pos, nrm: tpl.nrm, lum: out, region: tpl.region, count: n, cell: tpl.cell, torsoCell: tpl.torsoCell, mouthY: tpl.mouthY };
}

interface PhotoModalProps {
  onClose: () => void;
  onApply: (f: FaceData) => void;
  getBase: () => FaceData | null;
}

function PhotoModal({ onClose, onApply, getBase }: PhotoModalProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const dragRef = useRef<{ x: number; y: number; dx: number; dy: number } | null>(null);
  const [src, setSrc] = useState<PhotoSource | null>(null);
  const [base, setBase] = useState<PhotoTransform | null>(null);
  const [scale, setScale] = useState(1);
  const [dx, setDx] = useState(0);
  const [dy, setDy] = useState(0);
  const [rot, setRot] = useState(0);
  const [contrast, setContrast] = useState(1.2);
  const [useMask, setUseMask] = useState(true);
  const [mirror, setMirror] = useState(false);
  const [shape, setShape] = useState<"generic" | "base">("generic");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const tf = useMemo(() => (base ? composeTransform(base, scale, dx, dy, rot) : null), [base, scale, dx, dy, rot]);
  const masked = useMemo(() => (src ? maskedCanvas(src, useMask) : null), [src, useMask]);

  const resetAdjust = () => { setScale(1); setDx(0); setDy(0); setRot(0); };

  const onFile = (f: File | undefined) => {
    if (!f) return;
    if (!f.type.startsWith("image/")) { setErr("El archivo no es una imagen"); return; }
    setErr("");
    loadPhoto(f)
      .then((p) => {
        setSrc(p);
        setBase(baseTransform(p));
        resetAdjust();
      })
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : "No se pudo cargar la foto"));
  };

  useEffect(() => {
    const c = canvasRef.current;
    const ctx = c?.getContext("2d");
    if (!c || !ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#04080c";
    ctx.fillRect(0, 0, PV.w, PV.h);
    if (masked && tf) {
      ctx.save();
      ctx.translate(tf.cx, tf.cy);
      ctx.rotate(tf.rot);
      ctx.scale(tf.k, tf.k);
      ctx.drawImage(masked, -masked.width / 2, -masked.height / 2);
      ctx.restore();
    }
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(92,240,255,0.9)";
    ctx.beginPath();
    ctx.ellipse(previewX(0), previewY(1.16), PV.sf * 0.56, PV.sf * 0.81, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = "rgba(255,194,77,0.85)";
    ctx.fillStyle = "rgba(255,194,77,0.95)";
    ctx.font = "10px ui-monospace, Consolas, monospace";
    const guides: [number, string][] = [[1.97, "coronilla"], [1.0, "ojos"], [0.68, "boca"], [0.35, "barbilla"]];
    for (const [gy, label] of guides) {
      const v = previewY(gy);
      ctx.beginPath();
      ctx.moveTo(16, v);
      ctx.lineTo(PV.w - 16, v);
      ctx.stroke();
      ctx.fillText(label, 20, v - 3);
    }
    ctx.setLineDash([]);
  }, [masked, tf]);

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      setScale((s) => clamp(s * Math.exp(-e.deltaY * 0.001), 0.3, 3));
    };
    c.addEventListener("wheel", onWheel, { passive: false });
    return () => c.removeEventListener("wheel", onWheel);
  }, []);

  const apply = () => {
    if (!masked || !tf) return;
    setBusy(true);
    setErr("");
    window.setTimeout(() => {
      try {
        const px = lumaOf(masked);
        const baseFace = shape === "base" ? getBase() : null;
        const tpl = baseFace ?? buildGenericFace();
        onApply(avatarFromPhoto(tpl, baseFace ? "base" : "generic", px, tf, contrast, mirror));
      } catch (e) {
        setErr(e instanceof Error ? e.message : "No se pudo crear el avatar");
        setBusy(false);
      }
    }, 30);
  };

  return (
    <div
      className="nab-modal"
      role="dialog"
      aria-modal="true"
      aria-label="Convertir foto en avatar"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        onFile(e.dataTransfer.files[0]);
      }}
    >
      <div className="nab-sheet">
        <div className="nab-pv">
          <canvas
            ref={canvasRef}
            width={PV.w}
            height={PV.h}
            className="nab-pvc"
            onPointerDown={(e) => {
              dragRef.current = { x: e.clientX, y: e.clientY, dx, dy };
              try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* sin captura */ }
            }}
            onPointerMove={(e) => {
              const d = dragRef.current;
              if (!d) return;
              const k = PV.w / e.currentTarget.getBoundingClientRect().width;
              setDx(d.dx + (e.clientX - d.x) * k);
              setDy(d.dy + (e.clientY - d.y) * k);
            }}
            onPointerUp={() => { dragRef.current = null; }}
            onPointerCancel={() => { dragRef.current = null; }}
          />
          {!src && (
            <button className="nab-drop nab-mono" onClick={() => fileRef.current?.click()}>
              Suelta una foto aquí o pulsa para elegirla
            </button>
          )}
        </div>
        <div className="nab-form nab-mono">
          <h2>Foto a avatar</h2>
          <p>
            La foto se procesa en tu navegador y no se envía a ningún servidor. Arrastra la imagen y alinea ojos, boca y
            barbilla con las guías.
          </p>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => {
              onFile(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
          <div className="nab-row">
            <button className="nab-btn" onClick={() => fileRef.current?.click()}>Elegir foto</button>
            <button
              className="nab-btn"
              disabled={!src}
              onClick={() => {
                if (src) setBase(baseTransform(src));
                resetAdjust();
              }}
            >
              Ajuste automático
            </button>
          </div>
          <label className="nab-field">
            <span>Escala {scale.toFixed(2)}</span>
            <input type="range" min={0.3} max={3} step={0.01} value={scale} onChange={(e) => setScale(Number(e.target.value))} />
          </label>
          <label className="nab-field">
            <span>Giro {rot.toFixed(0)}°</span>
            <input type="range" min={-30} max={30} step={0.5} value={rot} onChange={(e) => setRot(Number(e.target.value))} />
          </label>
          <label className="nab-field">
            <span>Contraste {contrast.toFixed(1)}</span>
            <input type="range" min={0.6} max={2.2} step={0.1} value={contrast} onChange={(e) => setContrast(Number(e.target.value))} />
          </label>
          <label className="nab-check">
            <input type="checkbox" checked={useMask} onChange={(e) => setUseMask(e.target.checked)} /> Quitar fondo
          </label>
          <label className="nab-check">
            <input type="checkbox" checked={mirror} onChange={(e) => setMirror(e.target.checked)} /> Espejo
          </label>
          <label className="nab-field">
            <span>Forma de la cabeza</span>
            <select value={shape} onChange={(e) => setShape(e.target.value === "base" ? "base" : "generic")}>
              <option value="generic">Genérica con relieve de la foto</option>
              <option value="base" disabled={!getBase()}>Reconstruida (pelo y orejas del modelo)</option>
            </select>
          </label>
          {err && <div className="nab-err" role="alert">{err}</div>}
          <div className="nab-row">
            <button className="nab-go" disabled={!src || busy} onClick={apply}>{busy ? "Creando…" : "Crear avatar"}</button>
            <button className="nab-btn" onClick={onClose}>Cancelar</button>
          </div>
        </div>
      </div>
    </div>
  );
}

interface VoiceWaveProps {
  ampRef: { current: number };
  caption: string;
  speaking: boolean;
}

/** Onda de voz de cuadraditos huecos, translúcida (mix-blend screen), para cuando el chat está oculto. */
function VoiceWave({ ampRef, caption, speaking }: VoiceWaveProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    const ctx = c?.getContext("2d");
    if (!c || !ctx) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const fit = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const r = c.getBoundingClientRect();
      c.width = Math.max(1, Math.round(r.width * dpr));
      c.height = Math.max(1, Math.round(r.height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(c);
    const box = (x: number, y: number, s: number) => {
      const r = s * 0.28;
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + s, y, x + s, y + s, r);
      ctx.arcTo(x + s, y + s, x, y + s, r);
      ctx.arcTo(x, y + s, x, y, r);
      ctx.arcTo(x, y, x + s, y, r);
      ctx.closePath();
      ctx.stroke();
    };
    let raf = 0;
    let smoothAmp = 0;
    const frame = (ts: number) => {
      raf = requestAnimationFrame(frame);
      const t = ts / 1000;
      const w = c.clientWidth;
      const h = c.clientHeight;
      ctx.clearRect(0, 0, w, h);
      smoothAmp += (ampRef.current - smoothAmp) * 0.2;
      let cols = Math.max(15, Math.floor(w / 13));
      if (cols % 2 === 0) cols += 1;
      const mid = (cols - 1) / 2;
      const step = w / cols;
      const sq = Math.min(6, step * 0.5);
      const cy = h / 2;
      ctx.lineWidth = 1;
      for (let i = 0; i < cols; i++) {
        const x = (i - mid) / mid;
        const env = Math.pow(Math.cos((x * Math.PI) / 2), 1.3);
        const wob = reduce ? 0.6 : 0.55 + 0.45 * Math.abs(Math.sin(t * 6.5 + i * 0.55) * Math.cos(t * 2.7 + i * 0.31));
        const a = smoothAmp * env * wob;
        const n = Math.max(0, Math.round((a * (h / 2 - sq)) / (sq * 1.5)));
        const px = (i + 0.5) * step - sq / 2;
        const base = 0.22 + 0.5 * env;
        for (let k = 0; k <= n; k++) {
          const off = k * sq * 1.5;
          const cap = k === n && n > 0;
          const al = cap ? 0.95 : (base + 0.5 * Math.min(1, smoothAmp * 2)) * (1 - 0.45 * (k / (n + 1)));
          ctx.strokeStyle = cap ? `rgba(92,240,255,${al})` : `rgba(237,227,204,${al})`;
          box(px, cy - off - sq / 2, sq);
          if (k > 0) box(px, cy + off - sq / 2, sq);
        }
      }
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [ampRef]);
  return (
    <div className="nab-voice" aria-hidden={!speaking}>
      <canvas ref={ref} />
      <div className="nab-cap nab-mono">{caption}</div>
    </div>
  );
}

const LABEL_SLOTS = 16;
const WAVE_BARS = 28;

export default function NeuralAvatarChat({
  apiBaseUrl = "/api/v1",
  refreshMs = 30000,
  voice: voiceDefault = false,
  lang = "es-ES",
  ttsFetch,
  faceSrc,
  className,
  style,
}: NeuralAvatarChatProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  const labelRefs = useRef<(HTMLDivElement | null)[]>([]);
  const waveRefs = useRef<(HTMLElement | null)[]>([]);
  const tipRef = useRef<HTMLDivElement>(null);
  const feedRef = useRef<HTMLDivElement>(null);

  const [vs, setVs] = useState<VoiceSettings>(() => loadVoiceSettings(lang));
  const [voiceOpen, setVoiceOpen] = useState(false);
  const voices = useVoices();
  const [items, setItems] = useState<DataItem[]>([]);
  const [source, setSource] = useState<Source>("connecting");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [paused, setPaused] = useState(false);
  const [status, setStatus] = useState<Status>("idle");
  const [input, setInput] = useState("");
  const [voiceOn, setVoiceOn] = useState(voiceDefault);
  const [selected, setSelected] = useState<DataItem | null>(null);
  const [faceState, setFaceState] = useState<"loading" | "ok" | "fallback" | "photo">("loading");
  const [photoOpen, setPhotoOpen] = useState(false);
  const [autoOrbit, setAutoOrbit] = useState(false);
  const [customFace, setCustomFace] = useState(false);
  const [panelOpen, setPanelOpen] = useState(true);
  const [unread, setUnread] = useState(0);

  const itemsRef = useRef(items);
  const sourceRef = useRef<Source>("connecting");
  const queueRef = useRef<Draft[]>([]);
  const busyRef = useRef(false);
  const pausedRef = useRef(false);
  const speakingRef = useRef(false);
  const voiceRef = useRef(voiceOn);
  const idRef = useRef(1);
  const typeTimer = useRef<number | null>(null);
  const holdTimer = useRef<number | null>(null);
  const activeRef = useRef<string[]>([]);
  const announced = useRef<Source | null>(null);
  const rndRef = useRef(mulberry32(20261022));
  const pickRef = useRef<(idx: number) => void>(() => undefined);
  const apiRef = useRef<{
    setItems: (l: DataItem[]) => void;
    refreshBoost: () => void;
    setFace: (f: FaceData) => void;
    resetView: () => void;
  } | null>(null);
  const baseFaceRef = useRef<FaceData | null>(null);
  const customRef = useRef(false);
  const autoRef = useRef(false);
  const panelRef = useRef(true);
  const vsRef = useRef(vs);
  const ttsRef = useRef(ttsFetch);
  const speakerRef = useRef<Speaker | null>(null);
  if (speakerRef.current === null) speakerRef.current = new Speaker();
  const langInit = useRef(vs.lang);
  const ampRef = useRef(0);

  itemsRef.current = items;
  sourceRef.current = source;
  voiceRef.current = voiceOn;
  pausedRef.current = paused;
  autoRef.current = autoOrbit;
  panelRef.current = panelOpen;
  vsRef.current = vs;
  ttsRef.current = ttsFetch;

  /* ── Motor de "habla": cola de mensajes; el texto avanza al ritmo real de la voz ── */
  const pump = useCallback(() => {
    if (busyRef.current || pausedRef.current) return;
    const next = queueRef.current.shift();
    if (!next) return;
    busyRef.current = true;
    const id = idRef.current++;
    setMessages((m) => [...m.slice(-40), { ...next, id, text: "" }]);
    activeRef.current = next.refs;
    apiRef.current?.refreshBoost();
    speakingRef.current = true;
    setStatus("speaking");

    const text = next.text;
    const len = text.length;
    const sp = speakerRef.current;
    const st = vsRef.current;
    const canSpeak = typeof window !== "undefined" && ("speechSynthesis" in window || !!ttsRef.current);
    const useVoice = voiceRef.current && sp !== null && canSpeak;
    let speechDone = !useVoice;
    let typedDone = false;
    let finished = false;
    let progress = 0;
    const finish = () => {
      if (finished) return;
      finished = true;
      speakingRef.current = false;
      setStatus("idle");
      holdTimer.current = window.setTimeout(() => {
        activeRef.current = [];
        apiRef.current?.refreshBoost();
        busyRef.current = false;
        pump();
      }, 1600);
    };
    const tryFinish = () => {
      if (typedDone && speechDone) finish();
    };
    if (useVoice && sp) {
      void sp.speak(
        text,
        st,
        {
          onProgress: (p) => {
            progress = Math.max(progress, p);
          },
          onEnd: () => {
            speechDone = true;
            progress = 1;
            tryFinish();
          },
        },
        ttsRef.current,
      );
    }
    const cps = useVoice ? 15 * st.rate : 90;
    let acc = 0;
    let shown = 0;
    let last = performance.now();
    const step = () => {
      const now = performance.now();
      acc += ((now - last) / 1000) * cps;
      last = now;
      let target = Math.floor(acc);
      if (useVoice && sp) {
        if (sp.boundarySeen) {
          target = Math.ceil(progress * len);
          const e = text.indexOf(" ", target);
          target = e < 0 ? len : e;
        }
        if (speechDone) target = len;
      }
      const to = Math.min(len, Math.max(shown, target));
      if (to !== shown) {
        shown = to;
        const part = text.slice(0, shown);
        setMessages((m) => m.map((x) => (x.id === id ? { ...x, text: part } : x)));
      }
      if (shown >= len) {
        typedDone = true;
        tryFinish();
        return;
      }
      typeTimer.current = window.setTimeout(step, 33);
    };
    step();
  }, []);

  const enqueue = useCallback(
    (d: Draft) => {
      queueRef.current.push(d);
      pump();
    },
    [pump],
  );

  const stopTimers = useCallback(() => {
    if (typeTimer.current !== null) window.clearTimeout(typeTimer.current);
    if (holdTimer.current !== null) window.clearTimeout(holdTimer.current);
    typeTimer.current = null;
    holdTimer.current = null;
    if (speakerRef.current) speakerRef.current.cancel();
  }, []);

  /* ── Conexión al gateway REST ── */
  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const payload = await gatewayFetch(apiBaseUrl, "/feed");
        if (cancelled) return;
        const all = toItems(payload, "gateway");
        setItems(all);
        setSource("live");
      } catch {
        if (!cancelled) {
          setItems([]);
          setSource("offline");
        }
      }
    };
    void load();
    const iv = window.setInterval(() => void load(), refreshMs);
    return () => {
      cancelled = true;
      window.clearInterval(iv);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiBaseUrl, refreshMs]);

  /* ── Anuncio de estado de conexión ── */
  useEffect(() => {
    if (source === "connecting" || announced.current === source) return;
    announced.current = source;
    const n = itemsRef.current.length;
    const t = I18N[vsRef.current.lang];
    const text = source === "live" ? t.connected(n) : t.offline(apiBaseUrl);
    enqueue({ role: "agent", author: "NEURALBUS", text, refs: [] });
  }, [source, apiBaseUrl, enqueue]);

  /* ── Director automático: el avatar comenta datos cada pocos segundos ── */
  useEffect(() => {
    const iv = window.setInterval(() => {
      if (pausedRef.current || busyRef.current || queueRef.current.length || sourceRef.current === "connecting") return;
      const d = composeBriefing(itemsRef.current, rndRef.current, vsRef.current.lang);
      if (d) enqueue(d);
    }, 8000);
    return () => window.clearInterval(iv);
  }, [enqueue]);

  useEffect(() => {
    if (!paused) pump();
    else if (speakerRef.current) speakerRef.current.cancel();
  }, [paused, pump]);

  useEffect(() => {
    const el = feedRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  useEffect(() => () => stopTimers(), [stopTimers]);

  /* ── Acciones de usuario ── */
  const ask = useCallback(
    async (q: string) => {
      const text = q.trim();
      if (!text) return;
      setMessages((m) => [...m.slice(-40), { id: idRef.current++, role: "user", author: "TÚ", text, refs: [] }]);
      setStatus("thinking");
      let found: DataItem[] = [];
      let note = "";
      if (sourceRef.current === "live") {
        try {
          found = toItems(await gatewayFetch(apiBaseUrl, "/query", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ query: text }),
          }), "gateway");
        } catch {
          note = I18N[vsRef.current.lang].busDown;
        }
      }
      setStatus("idle");
      if (!found.length) {
        enqueue({ role: "agent", author: "NEURALBUS", text: I18N[vsRef.current.lang].noMatch(text, note), refs: [] });
        return;
      }
      setItems((prev) => mergeItems(prev, found));
      const top = found.slice(0, 4);
      const lg = vsRef.current.lang;
      const body = top.map((x) => `${x.label} (${catName(lg, x.category)}${x.risk === null ? "" : `, ${x.risk}/100`}): ${trimEnd(x.detail)}`).join(". ");
      enqueue({ role: "agent", author: agentFor(top[0].category).name, text: I18N[lg].results(top.length, body, note), refs: top.map((x) => x.id), risk: top[0].risk ?? undefined });
    },
    [apiBaseUrl, enqueue],
  );

  const restart = useCallback(() => {
    stopTimers();
    queueRef.current = [];
    busyRef.current = false;
    speakingRef.current = false;
    activeRef.current = [];
    apiRef.current?.refreshBoost();
    setMessages([]);
    setStatus("idle");
    setSelected(null);
    const d = composeBriefing(itemsRef.current, rndRef.current, vsRef.current.lang);
    if (d) enqueue(d);
  }, [enqueue, stopTimers]);

  pickRef.current = (idx: number) => {
    const it = itemsRef.current[idx];
    if (!it) return;
    setSelected(it);
    enqueue({
      role: "agent",
      author: agentFor(it.category).name,
      text: I18N[vsRef.current.lang].picked(it, catName(vsRef.current.lang, it.category)),
      refs: [it.id],
      risk: it.risk ?? undefined,
    });
  };

  useEffect(() => {
    saveVoiceSettings(vs);
  }, [vs]);

  useEffect(() => {
    if (langInit.current === vs.lang) return;
    langInit.current = vs.lang;
  }, [vs.lang]);

  const changeVoice = (p: Partial<VoiceSettings>) => setVs((prev) => ({ ...prev, ...p }));

  const testVoice = () => {
    const sp = speakerRef.current;
    if (!sp) return;
    speakingRef.current = true;
    setStatus("speaking");
    void sp.speak(
      I18N[vsRef.current.lang].voiceTest,
      vsRef.current,
      {
        onEnd: () => {
          if (!busyRef.current) {
            speakingRef.current = false;
            setStatus("idle");
          }
        },
      },
      ttsRef.current,
    );
  };

  const applyPhotoFace = (f: FaceData) => {
    customRef.current = true;
    apiRef.current?.setFace(f);
    setCustomFace(true);
    setFaceState("photo");
    setPhotoOpen(false);
    enqueue({
      role: "agent",
      author: "NEURALBUS",
      text: I18N[vsRef.current.lang].photoDone,
      refs: [],
    });
  };

  const resetAvatar = () => {
    customRef.current = false;
    apiRef.current?.setFace(baseFaceRef.current ?? buildGenericFace());
    setCustomFace(false);
    setFaceState(baseFaceRef.current ? "ok" : "fallback");
  };

  /* ── Sincroniza los nodos de la escena cuando cambian los datos ── */
  useEffect(() => {
    apiRef.current?.setItems(items);
  }, [items]);

  /* ── Escena three.js ── */
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    let disposed = false;

    const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: "high-performance" });
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    renderer.setPixelRatio(dpr);
    renderer.setClearColor(0x010305, 1);
    mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 60);
    const pivot = new THREE.Group();
    const holder = new THREE.Group();
    holder.position.y = -1.15;
    pivot.add(holder);
    scene.add(pivot);
    let baseZ = 5.0;
    let narrowMode = false;
    let tanHalfV = 0.344;
    const placePivot = (k: number) => {
      const vh = 2 * camera.position.z * tanHalfV;
      const vw = vh * camera.aspect;
      const open = panelRef.current;
      const tx = !narrowMode && open ? -(400 / 2 / size.w) * vw : 0;
      const ty = 1.15 + (narrowMode && open ? 0.2 * vh : 0);
      pivot.position.x += (tx - pivot.position.x) * k;
      pivot.position.y += (ty - pivot.position.y) * k;
    };
    const view = { yaw: 0, pitch: 0, vyaw: 0, vpitch: 0, zoom: 1, tzoom: 1, interacted: false, reset: false };

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const uScale = { value: 1000 };
    const baseMat = (vertexShader: string, uniforms: Record<string, THREE.IUniform>) =>
      new THREE.ShaderMaterial({
        vertexShader,
        fragmentShader: SQUARE_FS,
        uniforms,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });

    /* avatar: primero busto genérico, luego la cara real de neural-face.bin */
    const avUniforms = { uTime: { value: 0 }, uAmp: { value: 0 }, uScale, uMotion: { value: reduce ? 0.2 : 1 } };
    const avMat = baseMat(AVATAR_VS, avUniforms);
    let avGeo = faceGeometry(buildGenericFace());
    const avatar = new THREE.Points(avGeo, avMat);
    avatar.frustumCulled = false;
    holder.add(avatar);
    const swapFace = (f: FaceData) => {
      const g = faceGeometry(f);
      avGeo.dispose();
      avGeo = g;
      avatar.geometry = g;
    };
    setFaceState("loading");
    const faceCtl = new AbortController();
    loadFace(faceSrc, faceCtl.signal)
      .then((f) => {
        if (disposed) return;
        baseFaceRef.current = f;
        if (customRef.current) return;
        swapFace(f);
        setFaceState("ok");
      })
      .catch(() => {
        if (!disposed) setFaceState("fallback");
      });

    /* retícula de fondo (cuadrados tenues, como la imagen de referencia) */
    const gridGeo = new THREE.BufferGeometry();
    {
      const gxN = 150, gyN = 90, sp = 0.09;
      const gp = new Float32Array(gxN * gyN * 3);
      let k = 0;
      for (let ix = 0; ix < gxN; ix++) {
        for (let iy = 0; iy < gyN; iy++) {
          gp[k++] = (ix - gxN / 2) * sp;
          gp[k++] = (iy - gyN / 2) * sp + 0.4;
          gp[k++] = -2.6;
        }
      }
      gridGeo.setAttribute("position", new THREE.BufferAttribute(gp, 3));
    }
    const gridMat = baseMat(GRID_VS, { uTime: { value: 0 }, uScale });
    const grid = new THREE.Points(gridGeo, gridMat);
    grid.frustumCulled = false;
    scene.add(grid);

    /* nodos de datos del MCP */
    const nodeUniforms = { uTime: { value: 0 }, uScale };
    const nodeMat = baseMat(NODE_VS, nodeUniforms);
    let nodeGeo = new THREE.BufferGeometry();
    const nodePoints = new THREE.Points(nodeGeo, nodeMat);
    nodePoints.frustumCulled = false;
    holder.add(nodePoints);

    /* líneas boca -> nodos que el avatar menciona */
    const MAX_LINES = 8;
    const linePos = new Float32Array(MAX_LINES * 2 * 3);
    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute("position", new THREE.BufferAttribute(linePos, 3));
    lineGeo.setDrawRange(0, 0);
    const lineMat = new THREE.LineBasicMaterial({ color: 0xede3cc, transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending, depthWrite: false });
    const lines = new THREE.LineSegments(lineGeo, lineMat);
    lines.frustumCulled = false;
    holder.add(lines);

    /* flujos de puntos que entran en la cabeza (curvas bézier) */
    const TRAILS = 5;
    const DOTS = 56;
    const trailRnd = mulberry32(31337);
    const curves: THREE.Vector3[][] = [];
    for (let c = 0; c < TRAILS; c++) {
      const y0 = -1.0 + c * 0.75 + (trailRnd() - 0.5) * 0.3;
      const z0 = (trailRnd() - 0.5) * 1.5;
      curves.push([
        new THREE.Vector3(-3.9, y0, z0),
        new THREE.Vector3(-2.7, y0 + (c % 2 ? 0.9 : -0.7), z0 * 0.6),
        new THREE.Vector3(-1.4, 0.9 + (c - 2) * 0.25, 0.4),
        new THREE.Vector3(-0.62, 0.8 + c * 0.2, 0.15),
      ]);
    }
    const tPos = new Float32Array(TRAILS * DOTS * 3);
    const tAlpha = new Float32Array(TRAILS * DOTS);
    const tSize = new Float32Array(TRAILS * DOTS);
    const trailGeo = new THREE.BufferGeometry();
    trailGeo.setAttribute("position", new THREE.BufferAttribute(tPos, 3));
    trailGeo.setAttribute("aAlpha", new THREE.BufferAttribute(tAlpha, 1));
    trailGeo.setAttribute("aSizeW", new THREE.BufferAttribute(tSize, 1));
    const trailMat = baseMat(TRAIL_VS, { uScale });
    const trails = new THREE.Points(trailGeo, trailMat);
    trails.frustumCulled = false;
    holder.add(trails);
    const bez = (c: THREE.Vector3[], t: number, out: THREE.Vector3) => {
      const u = 1 - t;
      const a = u * u * u, b = 3 * u * u * t, d = 3 * u * t * t, e = t * t * t;
      out.set(
        c[0].x * a + c[1].x * b + c[2].x * d + c[3].x * e,
        c[0].y * a + c[1].y * b + c[2].y * d + c[3].y * e,
        c[0].z * a + c[1].z * b + c[2].z * d + c[3].z * e,
      );
    };

    /* estado de nodos */
    const nodes = {
      list: [] as DataItem[],
      index: new Map<string, number>(),
      base: new Float32Array(0),
      orbit: new Float32Array(0),
      boost: new Float32Array(0),
      sx: new Float32Array(0),
      sy: new Float32Array(0),
      vis: new Uint8Array(0),
    };
    let hover = -1;
    const pointer = { x: 0, y: 0, px: -9999, py: -9999, inside: false };
    const size = { w: 1, h: 1 };

    const refreshBoost = () => {
      const attr = nodeGeo.getAttribute("aBoost");
      if (!(attr instanceof THREE.BufferAttribute)) return;
      const active = new Set(activeRef.current);
      for (let i = 0; i < nodes.list.length; i++) {
        nodes.boost[i] = i === hover || active.has(nodes.list[i].id) ? 1 : 0;
      }
      attr.needsUpdate = true;
    };

    const setNodeItems = (list: DataItem[]) => {
      const n = list.length;
      const pos = new Float32Array(n * 3);
      const col = new Float32Array(n * 3);
      const sz = new Float32Array(n);
      const orb = new Float32Array(n);
      list.forEach((it, i) => {
        const rnd = mulberry32(hash32(it.id));
        const p = nodePosition(it, rnd);
        pos[i * 3] = p[0]; pos[i * 3 + 1] = p[1]; pos[i * 3 + 2] = p[2];
        const c = riskColor(riskValue(it.risk));
        col[i * 3] = c[0]; col[i * 3 + 1] = c[1]; col[i * 3 + 2] = c[2];
        sz[i] = 0.02 + riskValue(it.risk) * 0.0007;
        orb[i] = (rnd() < 0.5 ? -1 : 1) * (0.02 + rnd() * 0.06);
      });
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      geo.setAttribute("aColor", new THREE.BufferAttribute(col, 3));
      geo.setAttribute("aSize", new THREE.BufferAttribute(sz, 1));
      geo.setAttribute("aOrbit", new THREE.BufferAttribute(orb, 1));
      nodes.boost = new Float32Array(n);
      geo.setAttribute("aBoost", new THREE.BufferAttribute(nodes.boost, 1));
      nodeGeo.dispose();
      nodeGeo = geo;
      nodePoints.geometry = geo;
      nodes.list = list;
      nodes.index = new Map(list.map((it, i) => [it.id, i]));
      nodes.base = pos;
      nodes.orbit = orb;
      nodes.sx = new Float32Array(n);
      nodes.sy = new Float32Array(n);
      nodes.vis = new Uint8Array(n);
      hover = -1;
      refreshBoost();
    };
    apiRef.current = { setItems: setNodeItems, refreshBoost, setFace: swapFace, resetView: () => { view.reset = true; } };
    setNodeItems(itemsRef.current);

    /* tamaño y encuadre */
    const resize = () => {
      const w = Math.max(1, mount.clientWidth);
      const h = Math.max(1, mount.clientHeight);
      size.w = w; size.h = h;
      renderer.setSize(w, h, false);
      renderer.domElement.style.width = "100%";
      renderer.domElement.style.height = "100%";
      camera.aspect = w / h;
      const narrow = w <= 760;
      const z = narrow ? 5.0 : camera.aspect < 1.1 ? 5.6 : 3.9;
      baseZ = z;
      camera.position.set(0, 1.15, z * view.zoom);
      camera.lookAt(0, 1.15, 0);
      camera.updateProjectionMatrix();
      const tanHalf = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
      uScale.value = (h * dpr) / (2 * tanHalf);
      narrowMode = narrow;
      tanHalfV = tanHalf;
      placePivot(1);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(mount);

    /* puntero: hover y clic en nodos, órbita libre (arrastrar), zoom (rueda o pellizco), doble clic = vista frontal */
    const nearest = (px: number, py: number, radius: number): number => {
      let best = -1;
      let bd = radius * radius;
      for (let i = 0; i < nodes.list.length; i++) {
        if (!nodes.vis[i]) continue;
        const dx = nodes.sx[i] - px;
        const dy = nodes.sy[i] - py;
        const d = dx * dx + dy * dy;
        if (d < bd) { bd = d; best = i; }
      }
      return best;
    };
    const clock = new THREE.Clock();
    const ptrs = new Map<number, { x: number; y: number }>();
    const drag = { on: false, moved: false, x0: 0, y0: 0, lx: 0, ly: 0, pinch: 0, zoom0: 1 };
    const updatePointer = (e: PointerEvent) => {
      const r = mount.getBoundingClientRect();
      pointer.px = e.clientX - r.left;
      pointer.py = e.clientY - r.top;
      pointer.x = (pointer.px / r.width) * 2 - 1;
      pointer.y = (pointer.py / r.height) * 2 - 1;
      pointer.inside = true;
    };
    const onDown = (e: PointerEvent) => {
      updatePointer(e);
      ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (ptrs.size === 1) {
        drag.on = true;
        drag.moved = false;
        drag.x0 = drag.lx = e.clientX;
        drag.y0 = drag.ly = e.clientY;
        view.reset = false;
      } else if (ptrs.size === 2) {
        const [a, b] = [...ptrs.values()];
        drag.pinch = Math.hypot(a.x - b.x, a.y - b.y);
        drag.zoom0 = view.tzoom;
        drag.moved = true;
      }
      try { mount.setPointerCapture(e.pointerId); } catch { /* sin captura */ }
    };
    const onMove = (e: PointerEvent) => {
      updatePointer(e);
      const p = ptrs.get(e.pointerId);
      if (!p) return;
      p.x = e.clientX;
      p.y = e.clientY;
      if (ptrs.size >= 2) {
        const [a, b] = [...ptrs.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (drag.pinch > 0 && d > 0) view.tzoom = clamp(drag.zoom0 * (drag.pinch / d), 0.45, 1.8);
        view.interacted = true;
        return;
      }
      if (!drag.on) return;
      if (!drag.moved && Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) > 6) drag.moved = true;
      if (drag.moved) {
        const dx = e.clientX - drag.lx;
        const dy = e.clientY - drag.ly;
        view.yaw += dx * 0.008;
        view.pitch = clamp(view.pitch + dy * 0.008, -1.5, 1.5);
        view.vyaw = dx * 0.008;
        view.vpitch = dy * 0.008;
        view.interacted = true;
      }
      drag.lx = e.clientX;
      drag.ly = e.clientY;
    };
    const onUp = (e: PointerEvent) => {
      updatePointer(e);
      const wasSingle = drag.on && ptrs.size === 1;
      ptrs.delete(e.pointerId);
      if (ptrs.size === 0) drag.on = false;
      else if (ptrs.size === 1) {
        const rem = [...ptrs.values()][0];
        drag.lx = rem.x;
        drag.ly = rem.y;
      }
      if (!wasSingle || drag.moved) return;
      const idx = nearest(pointer.px, pointer.py, e.pointerType === "touch" ? 30 : 16);
      if (idx >= 0) pickRef.current(idx);
    };
    const onCancel = (e: PointerEvent) => {
      ptrs.delete(e.pointerId);
      if (ptrs.size === 0) drag.on = false;
    };
    const onLeave = () => { pointer.inside = false; };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      view.tzoom = clamp(view.tzoom * Math.exp(e.deltaY * 0.001), 0.45, 1.8);
      view.interacted = true;
    };
    const onDbl = () => { view.reset = true; };
    mount.addEventListener("pointerdown", onDown);
    mount.addEventListener("pointermove", onMove);
    mount.addEventListener("pointerup", onUp);
    mount.addEventListener("pointercancel", onCancel);
    mount.addEventListener("pointerleave", onLeave);
    mount.addEventListener("wheel", onWheel, { passive: false });
    mount.addEventListener("dblclick", onDbl);

    /* bucle */
    const v = new THREE.Vector3();
    const tmp = new THREE.Vector3();
    const dot = new THREE.Vector3();
    let amp = 0;
    let lastT = 0;
    let raf = 0;
    const labelIds: string[] = new Array<string>(LABEL_SLOTS).fill("");

    const orbitPos = (i: number, t: number, out: THREE.Vector3) => {
      const a = t * nodes.orbit[i];
      const c = Math.cos(a), s = Math.sin(a);
      const bx = nodes.base[i * 3], by = nodes.base[i * 3 + 1], bz = nodes.base[i * 3 + 2];
      out.set(bx * c + bz * s, by + Math.sin(t * 0.6 + nodes.orbit[i] * 40) * 0.05, -bx * s + bz * c);
    };

    const tick = () => {
      raf = requestAnimationFrame(tick);
      const t = clock.getElapsedTime();

      const spk = speakerRef.current;
      let target = 0;
      if (speakingRef.current) {
        const wob = Math.abs(Math.sin(t * 11) * Math.sin(t * 4.3 + 1));
        if (spk && spk.cloudLive) {
          target = clamp(0.12 + spk.amp * 1.7, 0, 1);
        } else if (spk && spk.boundarySeen) {
          spk.pulse *= 0.9;
          target = 0.22 + 0.18 * wob + 0.6 * spk.pulse;
        } else {
          target = 0.35 + 0.65 * wob;
        }
      }
      amp += (target - amp) * 0.18;
      avUniforms.uTime.value = t;
      avUniforms.uAmp.value = amp;
      nodeUniforms.uTime.value = t;
      (gridMat.uniforms.uTime as THREE.IUniform).value = t;

      const dt = Math.min(0.1, t - lastT);
      lastT = t;
      if (view.reset) {
        view.yaw = Math.atan2(Math.sin(view.yaw), Math.cos(view.yaw)) * 0.9;
        view.pitch *= 0.9;
        view.vyaw = 0;
        view.vpitch = 0;
        view.tzoom += (1 - view.tzoom) * 0.1;
        if (Math.abs(view.yaw) + Math.abs(view.pitch) < 0.004 && Math.abs(view.tzoom - 1) < 0.004) {
          view.yaw = 0;
          view.pitch = 0;
          view.tzoom = 1;
          view.reset = false;
          view.interacted = false;
        }
      } else if (drag.on) {
        view.vyaw *= 0.85;
        view.vpitch *= 0.85;
      } else {
        view.yaw += view.vyaw;
        view.pitch = clamp(view.pitch + view.vpitch, -1.5, 1.5);
        view.vyaw *= 0.93;
        view.vpitch *= 0.93;
        if (autoRef.current) view.yaw += dt * 0.35;
      }
      view.zoom += (view.tzoom - view.zoom) * 0.12;
      camera.position.z = baseZ * view.zoom;
      placePivot(0.12);
      ampRef.current = amp;
      const sway = !view.interacted && !autoRef.current && !reduce ? Math.sin(t * 0.25) * 0.1 : 0;
      pivot.rotation.set(view.pitch, view.yaw + sway, 0);
      scene.updateMatrixWorld(true);

      /* flujos: más rápidos mientras habla */
      const speed = 0.03 + 0.1 * amp;
      for (let c = 0; c < TRAILS; c++) {
        for (let d = 0; d < DOTS; d++) {
          const i = c * DOTS + d;
          const tt = (d / DOTS + t * speed * (0.8 + c * 0.1)) % 1;
          bez(curves[c], tt, dot);
          tPos[i * 3] = dot.x; tPos[i * 3 + 1] = dot.y; tPos[i * 3 + 2] = dot.z;
          const pulse = d % 9 === 0 ? 1.8 : 1;
          tSize[i] = (0.008 + 0.014 * tt) * pulse;
          tAlpha[i] = smooth(0, 0.08, tt) * (1 - smooth(0.9, 1, tt)) * (0.55 + 0.45 * amp);
        }
      }
      for (const name of ["position", "aAlpha", "aSizeW"]) {
        const a = trailGeo.getAttribute(name);
        if (a instanceof THREE.BufferAttribute) a.needsUpdate = true;
      }

      /* proyección de nodos a pantalla */
      for (let i = 0; i < nodes.list.length; i++) {
        orbitPos(i, t, v);
        v.applyMatrix4(holder.matrixWorld).project(camera);
        nodes.sx[i] = (v.x * 0.5 + 0.5) * size.w;
        nodes.sy[i] = (-v.y * 0.5 + 0.5) * size.h;
        nodes.vis[i] = v.z < 1 && Math.abs(v.x) < 1.05 && Math.abs(v.y) < 1.05 ? 1 : 0;
      }

      /* hover y tooltip */
      const h = pointer.inside && !drag.on && Math.abs(view.vyaw) + Math.abs(view.vpitch) < 0.002 ? nearest(pointer.px, pointer.py, 16) : -1;
      if (h !== hover) {
        hover = h;
        refreshBoost();
      }
      const tip = tipRef.current;
      if (tip) {
        if (hover >= 0) {
          const it = nodes.list[hover];
          if (tip.dataset.id !== it.id) {
            tip.dataset.id = it.id;
            tip.innerHTML = "";
            const head = document.createElement("div");
            head.style.color = riskHex(riskValue(it.risk));
            head.textContent = `${it.label}  ${it.category}${it.risk === null ? "" : `  ${it.risk}/100`}`;
            const body = document.createElement("div");
            body.textContent = it.detail;
            tip.append(head, body);
          }
          const tx = Math.min(nodes.sx[hover] + 12, size.w - 270);
          tip.style.transform = `translate(${Math.max(8, tx)}px,${nodes.sy[hover] + 12}px)`;
          tip.style.opacity = "1";
        } else {
          tip.style.opacity = "0";
          tip.dataset.id = "";
        }
      }

      /* etiquetas flotantes: nodos activos, hover y los de mayor riesgo */
      const wanted: number[] = [];
      for (const id of activeRef.current) {
        const idx = nodes.index.get(id);
        if (idx !== undefined) wanted.push(idx);
      }
      if (hover >= 0 && !wanted.includes(hover)) wanted.push(hover);
      if (wanted.length < LABEL_SLOTS) {
        const top = nodes.list
          .map((it, i) => ({ i, r: riskValue(it.risk) }))
          .filter((x) => nodes.vis[x.i] && !wanted.includes(x.i))
          .sort((a, b) => b.r - a.r)
          .slice(0, LABEL_SLOTS - wanted.length);
        for (const x of top) wanted.push(x.i);
      }
      for (let s = 0; s < LABEL_SLOTS; s++) {
        const el = labelRefs.current[s];
        if (!el) continue;
        const idx = wanted[s];
        if (idx === undefined || !nodes.vis[idx]) {
          el.style.opacity = "0";
          continue;
        }
        const it = nodes.list[idx];
        if (labelIds[s] !== it.id) {
          labelIds[s] = it.id;
            el.textContent = `${it.label}${it.risk === null ? "" : ` ${it.risk}`}`;
            el.style.color = riskHex(riskValue(it.risk));
        }
        el.style.transform = `translate(${nodes.sx[idx] + 10}px,${nodes.sy[idx] - 8}px)`;
        el.style.opacity = s < activeRef.current.length || idx === hover ? "1" : "0.55";
      }

      /* líneas boca -> nodos referenciados */
      let n = 0;
      for (const id of activeRef.current) {
        if (n >= MAX_LINES) break;
        const idx = nodes.index.get(id);
        if (idx === undefined) continue;
        orbitPos(idx, t, tmp);
        linePos[n * 6] = 0; linePos[n * 6 + 1] = 0.7; linePos[n * 6 + 2] = 0.66;
        linePos[n * 6 + 3] = tmp.x; linePos[n * 6 + 4] = tmp.y; linePos[n * 6 + 5] = tmp.z;
        n++;
      }
      lineGeo.setDrawRange(0, n * 2);
      const la = lineGeo.getAttribute("position");
      if (la instanceof THREE.BufferAttribute) la.needsUpdate = true;
      lineMat.opacity = 0.22 + 0.4 * amp;

      /* ecualizador */
      for (let b = 0; b < WAVE_BARS; b++) {
        const el = waveRefs.current[b];
        if (!el) continue;
        const hgt = 2 + amp * 16 * (0.35 + 0.65 * Math.abs(Math.sin(t * 9 + b * 0.7) * Math.cos(t * 3.1 + b)));
        el.style.height = `${hgt.toFixed(1)}px`;
      }

      renderer.render(scene, camera);
    };
    tick();

    return () => {
      disposed = true;
      faceCtl.abort();
      cancelAnimationFrame(raf);
      ro.disconnect();
      mount.removeEventListener("pointerdown", onDown);
      mount.removeEventListener("pointermove", onMove);
      mount.removeEventListener("pointerup", onUp);
      mount.removeEventListener("pointercancel", onCancel);
      mount.removeEventListener("pointerleave", onLeave);
      mount.removeEventListener("wheel", onWheel);
      mount.removeEventListener("dblclick", onDbl);
      apiRef.current = null;
      avGeo.dispose();
      avMat.dispose();
      gridGeo.dispose();
      gridMat.dispose();
      nodeGeo.dispose();
      nodeMat.dispose();
      trailGeo.dispose();
      trailMat.dispose();
      lineGeo.dispose();
      lineMat.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement);
    };
  }, [faceSrc]);

  const statusLabel = useMemo(
    () => (status === "speaking" ? "hablando" : status === "thinking" ? "consultando" : paused ? "en pausa" : "escuchando"),
    [status, paused],
  );

  const lastId = messages.length ? messages[messages.length - 1].id : 0;
  useEffect(() => {
    if (!panelOpen && lastId > 0) setUnread((u) => u + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastId]);

  const togglePanel = () => {
    if (!panelOpen) setUnread(0);
    setPanelOpen(!panelOpen);
  };

  const lastMsg = messages.length ? messages[messages.length - 1] : null;
  const caption = status === "speaking" && lastMsg ? `${lastMsg.author}  ${lastMsg.text.slice(-96)}` : statusLabel;

  const submit = () => {
    const q = input;
    setInput("");
    void ask(q);
  };

  return (
    <div className={`nab-root ${className ?? ""}`} style={style}>
      <style>{CSS}</style>
      <div ref={mountRef} className="nab-canvas" aria-label="Avatar de partículas conectado a NeuralBus" />

      <div className="nab-hud nab-mono">
        <b>SWAT NEURALBUS</b>
        <div className="nab-badge">
          <span className={`nab-dot ${source}`} />
          {source === "live" ? "bus en vivo" : source === "offline" ? "gateway desconectado" : "conectando"}
          {`  ${items.length} nodos`}
        </div>
        <div style={{ color: "var(--dim)" }}>
          {faceState === "ok"
            ? "rostro reconstruido"
            : faceState === "photo"
              ? "avatar desde tu foto"
              : faceState === "loading"
                ? "cargando rostro"
                : "rostro genérico: no se pudo cargar el rostro"}
        </div>
        <div style={{ color: "var(--dim)" }}>arrastra para orbitar, rueda para zoom</div>
      </div>

      {Array.from({ length: LABEL_SLOTS }, (_, i) => (
        <div
          key={i}
          ref={(el) => {
            labelRefs.current[i] = el;
          }}
          className="nab-label nab-mono"
        />
      ))}
      <div ref={tipRef} className="nab-tip nab-mono" />

      <div className="nab-tools nab-mono">
        <button className={`nab-tool${autoOrbit ? " on" : ""}`} aria-pressed={autoOrbit} onClick={() => setAutoOrbit((a) => !a)}>
          Órbita auto
        </button>
        <button className="nab-tool" onClick={() => apiRef.current?.resetView()}>Vista frontal</button>
        <button className="nab-tool" onClick={() => setPhotoOpen(true)}>Foto a avatar</button>
        <button className="nab-tool" onClick={() => setVoiceOpen(true)}>Voz y idioma ({vs.lang.toUpperCase()})</button>
        {customFace && <button className="nab-tool" onClick={resetAvatar}>Avatar original</button>}
      </div>

      {selected && (
        <div className="nab-card">
          <div className="nab-mono" style={{ color: riskHex(riskValue(selected.risk)), display: "flex", justifyContent: "space-between" }}>
            <span>{selected.label}</span>
            <button
              onClick={() => setSelected(null)}
              aria-label="Cerrar detalle"
              style={{ background: "none", border: 0, color: "inherit", cursor: "pointer", font: "inherit" }}
            >
              ×
            </button>
          </div>
          <div className="nab-risk"><i style={{ width: `${riskValue(selected.risk)}%`, background: riskHex(riskValue(selected.risk)) }} /></div>
          <div>{selected.detail}</div>
          <div className="nab-mono" style={{ color: "var(--dim)", fontSize: 10, marginTop: 4 }}>
            {selected.category}, {selected.risk === null ? "riesgo no disponible" : `riesgo ${selected.risk}/100`}, fuente {selected.source}
          </div>
        </div>
      )}

      <button className="nab-toggle nab-mono" onClick={togglePanel} aria-expanded={panelOpen} aria-controls="nab-panel">
        <i className={`nab-chev${panelOpen ? " is-open" : ""}`} aria-hidden="true" />
        {panelOpen ? "Ocultar chat" : "Mostrar chat"}
        {!panelOpen && unread > 0 && <span className="nab-unread">{Math.min(unread, 99)}</span>}
      </button>

      <aside id="nab-panel" className={`nab-panel${panelOpen ? "" : " hide"}`} aria-hidden={!panelOpen}>
        <div ref={feedRef} className="nab-feed" aria-live="polite">
          {messages.map((m, i) => {
            const accent = m.role === "user" ? "#ffffff" : AGENTS.find((a) => a.name === m.author)?.color ?? "#5cf0ff";
            const last = i === messages.length - 1 && status === "speaking";
            return (
              <div key={m.id} className={`nab-msg ${m.role}`} style={{ "--accent": accent } as CSSProperties}>
                <div className="nab-msg-h nab-mono">
                  <span>{m.author}</span>
                  {m.risk !== undefined && <span>{m.risk}/100</span>}
                </div>
                <div className="nab-msg-t">
                  {m.text}
                  {last && <span className="nab-caret" />}
                </div>
              </div>
            );
          })}
        </div>

        <div className="nab-bar nab-mono">
          <span>estado: {statusLabel}</span>
          <div className="nab-wave" aria-hidden="true">
            {Array.from({ length: WAVE_BARS }, (_, i) => (
              <i
                key={i}
                ref={(el) => {
                  waveRefs.current[i] = el;
                }}
              />
            ))}
          </div>
        </div>

        <div className="nab-ctl nab-mono">
          <button className="nab-btn" onClick={() => setPaused((p) => !p)}>{paused ? "Reanudar" : "Pausar"}</button>
          <button className="nab-btn" onClick={() => setVoiceOn((v) => !v)}>{voiceOn ? "Voz activada" : "Voz apagada"}</button>
          <button className="nab-btn nab-gear" aria-label="Ajustes de voz" onClick={() => setVoiceOpen(true)}>⚙</button>
          <button className="nab-btn" onClick={restart}>Reiniciar</button>
        </div>

        <div className="nab-ask">
          <input
            className="nab-in"
            value={input}
            placeholder="Consulta una wallet, pool o señal"
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
            aria-label="Consulta para NeuralBus"
          />
          <button className="nab-go nab-mono" onClick={submit}>Preguntar</button>
        </div>
      </aside>

      {!panelOpen && <VoiceWave ampRef={ampRef} caption={caption} speaking={status === "speaking"} />}

      {voiceOpen && (
        <VoiceModal st={vs} voices={voices} hasCloud={!!ttsFetch} onChange={changeVoice} onTest={testVoice} onClose={() => setVoiceOpen(false)} />
      )}

      {photoOpen && <PhotoModal onClose={() => setPhotoOpen(false)} onApply={applyPhotoFace} getBase={() => baseFaceRef.current} />}
    </div>
  );
}

/* Rostro reconstruido de las fotos (formato NAF1, gzip, base64). Generado a partir de neural-face.bin. */
const FACE_GZ_B64 =
  "H4sIAOQP72oC/0zXd3xUxfc38O29791epBNEeugtNEEQRAig1NAEMcKXHkGKoNQgIAIBQVoERUpAwNBbaIIQRIoQaSJIki13e9/nc/b3z+Mf79dw7twzM2fmjpt+Xd5utpDzf//NrTV2yszJM2q1q9Eiu1nT1m/VqDVx/Ohx/98//zdl+sCxo/PHI9SsedOmTRs3RXDs+Px8BPCPZi3wz0+nzJwxEf+eW+uzTLRV25atWme3zm6a3SY7u3lb9Jjzf/GWbbKbNm/TqmmzVtmtspu3mDevxjndPlWl/CzsJz8DD8tOQYPsJPxMegL+LaF2l4w/iEmpmOKfisjbQoq0FFJ7k6AUJvjHYR6f8ng552FuxtL0aWhP09N9CeqpSdBbM+KU4UGM7BCjyPYotQUZJ0bI62GKNwlTe12IMoeDlG1YkGZ+NkD5awdoLUv9h2GVb5p2n+o39r5mn+ok2x4eY7ep96mOsnw1tSeo9ql+Za8r96mOs03gKXadAnnYsHyf6jw7FJ5jz8jIWjKKLJGSlRKyH7zAHhaTxoxzRPtUZexj4T7VFbYrvMr+IKC2FF5iP+WTt3nUJ8mh+BgOjXUpTTZIU3xwkvqcSJDOBEUWxannvzHK9k6M2vuj9FQLL7IzIzTuX2GyY8YdIZqbMOPHQZr57wGyaYAi3/qpHfHtU51mh8MT7DkWO8LWYakay7xktYfs76GnR9w0ogNWs1td+1RdfR/C333d4QR/DuQHusBtga6wfZDi94M94PTQ21ATpva+jL0i5IsIxRdGSXuMIqUxaufGe0JvxsIExROpzrAo3Qm25FD+25xesAuf/JtPb30moJ4GYamul7qH8hL8SXEFqhSX4TQ5Re7JLsJ2sgvwe+l5yMv4kYQi18VkE/E5uE5E8bCQIsOE1D4rOAtrZ1zGPw2reTRWf95xeIRLfcxcGnEe5yp8lqYRe6TP0ExS1FOVOkEzSVKGewmyXYLG+j5Oo/DilGFCjCLXo9RuEqX4uggZDlNkWMazIYrUCZXRTII0SnWAxu2f8YifMlj8W+AXvvZQ5tun7aW+xepgKTtL00t9iH2o7qU+yHbOuEvVS13CiuFh9hMlMrC3FL3Uv7It4Al2o5xMyHqpj7N5MmqXSXupT7JZGQslpFfcS32KzRVT+7iol/o064Dn2C+EvdTn2X8F5DvwLLuf30t9htVlnMWj+ENuL/U1thMsY3dxKIOYQ/P8JE3t8lQv9UU2O0V9ipK91BfYRILeHZ3xUpxyNohTnlUxko3SuIOiNIfjEcrgjNDcFoWp/TJE9s54IEhr0QVpXbMC1H7kJzv7afRdvl7qo6zYl6kJSxW75aUqZXupXeShpwk3jTUWPmTvulBz3wy4xtcH1vN3guf9HeCIABkNdITrgxRvFuoMf884MUwRQYTcHqFIh2gOfBClyIwYqYlT5Od4F9gzQf6TeBsuSPaCtlRXeCzVHg5It4HudDu4gkNv1eP2pJlkHMGjnlEeZVjPJ5sJaMQbGScK6alARPPfLhoD24nX0zzFp3Qv1INU5fCE8i/oVFbARYpH8KWcIr3l9+EB2T2ok92Fs6R/wocSspOEIjvFd6Ao4yQReVNIT5sLqb1B8AeM8cmR/FvwAu83WI93E67gUgY35yEckPFYmsaypunp/BT1fJ6kt95OUoa9CVKVoMzT4jTKvRi122X8PkryohT/KEL+FiYbh2mUb0KUORSkFQ0N0urOBGjEWhmX+GnEKt92OMTXAlayO7Qv8L2IYDE7SYP87E31C/VWtnnGDSqKxJQv1NvZkXAne0HxQv0DWw/uZlfISbeMHAD3sMekL9Q/slb4EztfgrWwz8VkDzFFfhK9UP/MKuEBdqrwBb7fuwKyLdzPbuW/UO9juRnH817gxP7GfYHz3BgeYr/hUOZQmsYamqZsZ1IvcMJrpWj+S5KUpzJB7/bLeDhOOY1xis+JkY+jFOkapTnsjlAGWYTmNjlM7T9CZKsQjbI5SGtJBWisMRkv+8k3/VSlr31UBx9LNRmc8YT3hXoH6/RSZRZ5aKxXbpwBtj98zV53vVC39k2FR309YR9/S/jS3xguCjSEziB5IuPg0FvQl/HrMEXejFD7cqQRHBMlU1GKbI6RreKU54+MkxNNoCxJ+Xcns2HXFPV/nKoP56TrQiMnCx7mNIX9uNSzktsCLuFRhlp88kzGoQLKH8r4jZAyNxZRzt9E3eB48SSYEJfApRI1VsqXFrjp23kBX0oHog65sjJ4TtYClWkk3wG3yFWomEIxD36mcMGXiuGoZ67Sq1uoSapicLSKq1+ouaTkwwYZVykowsrTeDpInoLHZQlol8XhQin5QkL2klCGfeIo1IgjcIaI2g+EFO8gpPZ2AcUFAmpP5IfgDR4Lm/L88Fsu9YxwaKzhHA7GPZemseqkA3BZinpWJ4Owf5IyHElQNnOC2nPj9O6TGLW7xSi+J0pteZTiUyI0wzthsnXG70KUOR2kFY0N0ohXAjRiwwCtd7Wf3vX77sNhvrmUmXVrF2q2sbnwK7ZUs1DzOWuHc9iF6oWaz9gXKmr3gnPZfcqFmnmsBs5nZygWahawD+SoFdsh43bZQs0iVgAXsxOlCzVfstcllLMJXMKuE1M7LKL2MLiMPStcqFnB1s64VLBQs5yt4lP8PT61f+GRJriWnctdqPmGfcKhp904NMqeNI0iT1OfKSl6eie5ULOGbZOkyHcJMh2n/mPj1L4So1EaZlwdpbg/QvMZkvFkmGb1Rpjai0M081dByt8nSGMdDNDqdBln+WnVD31UgU4+qsZOltoilp5O8i7ULGVveRZqNrAt4UF2m3uh5i+WgW/4il0LNSt9wyDjbwb3+i2we0AJnwYk8POgCJpD5JGM/cNCWB2m9rKIGNaJUs/zUWqPiFE8GqP2+jjZLEFPf08o4MdJNRSmZHBHig87pjnwrzQXzuRQfy1XBfdzqec7PCn8l0fxL/ikQ0AeF9Aog4TUZoXUZ5WI3mogrgHLxP3gh5Lv4RMJDysdIs2H16QPYRtZb9ShWHYSauQNUJ/58vXQK+eiYnmK/8GbimewnbI/6rlHeQYaVW+izktUm2BApUTlR6gXw4v41YBxNQNUdu1Y0yNoNo1S27WXjU/hp8aRGrtWa3wIDxv6a+3aPoZT8BFj1dm1I5mJ8L5+F+ypvwUP6TzQrJPq7dr5Wjv8R5MN96nbQY26E5yuyoH3lV1geyW1tykozld0gBPk7eFvMurfWNYWfiNtA0MScqikNTwjbgVrilvCr0TkayFF+mY8JCANGQv4NHoFrwnM4TWFxVyKS7g0Vj6nIyxP0yjZ6eawKNUYxpPUHpWknhcTZP2MK+OkJ0YOjNG4x6KkNUqzmh+hGT4Pk2+HKedPIVqFMkQrmhqkEe8GaMS2AVrvVj895fhvoZ4fsi1gb3Yj6tyDjaPy3dlRGS+qKFI/4wolMrNuBarNDsh4TE5a4TvsfBl2h30mRR3YHrAf+5PErn2PVWacKib/FJFt4AB2ixCrYDkZxwkocpVP7YYZV/Ps2kGsn2vXjmCHcGmGJzl2bX/2DQ6NsjhNo7xKUZ8+KepzMGnXfsDqk5RndoIyPIpTu3Oc2jtjpChGkUlRynMzQjNpnnFDmCLRELVHhGjm54N27bts3SDVZHnAru3Fuvy00v4Zj/goYvbRqnGzYiZPvXbtYLYH/Ij92WPXLmaN8DC7wo2Tw8phf99OF3bT9z58x2+GD/3+art2WuBvqAj+AX8M3oDdQ7/Bp6Fr8PMwaYlQ5GjkOnw/SrqiFFkeI+vGyQsZRyboaSxRDjckKWfzFOW8mboMJ6UvQhGH2rs4FO/MpT6PuNR/No/e1fMpz8GMfQTkq4xfCulpDdFNeEr0J/xAXAV94lpYy5eSAiiSPoFzpX2wXpe0FA6XNUAdrso2wxZyCeqzUz4dMorHcImiL6rnV5yBecrGqOfvyu9gB5UYdd6vmgnt6v/gEvUw7IJXfQMO17THvvym+Rm20jqxX9u1a6FUx8c+ztDNgE91/8J39YOxv6X6y7AO0xr7vob5CcYYO07CeMPX8JYhDdsbp+GcFBtbKUq1Ky37YT1LPWWptsy8C04w11aVapXmHfCQyaEu1Q4wrYceo1xTql1uXAhrGQPwuGGctlTb13ALPmSa6Eq1ecxiWKG/DPvrE/C0rp6+VFtf1wuu1o6FQc0sOFRTgbfUbA4UssXIxmUlGfPVZDlG57HZGYuUZEJB5mUsk5dq+WwWFLGFslKthPVIS7UydiCUs79KSrUK1pZxgZgi/4io3RMq2Z+FpVoVq844XUDe55dqNWz7jNt4pVoty4cWdgK3VGtir3PorSYcGmVdmkYJp6jPsBT1OZss1RrZOklay7IEZaiKU/u9OGX+JUZtU4zac6OU50mE5tMt454wzUqecUqIIneCpVop2xqK2e8CVJm0v1QrYMf6qX3FR/GGPuq/mi3VMmzAW6qtzQ6FndgyT6l2EtsK7mUPu0u1SbYtzPPdcJVqb/k+ge/4bdT2/11dqh0ZOAwDgY3w6+Ay2CC0Bd4Rl8OPJHXQ87VkJRwlDcNy6Thk6yy7A/fJumMUs/wI/EpeA6MH5SvhBEUE3ldMwNx6KO/DQ8oemG0N1WG4RvUGVpFWrYb5ai5Wd089DXbFbwf01LyLVdfUnoBrtG+iGkntZjhJJ0F9/tLNgj31L+Ax/QBUrw5zDq5jmqCqXMP3cLJBjTo/MsyHvYwueNQ4ArtQ23QTfm3qit0Jm07AoWYOJ1f3wjYT9ra/L87V9XM8hRrHJ5Jc3W92P5xnnynN1dW3++B1W74sV/ex7TkU2IbIc3Vbrb/BbGs7Ra7uqmUvHGaxKnN1XvMquMTMVeXqnOZZ8FdTJXzPNFydq/vX+DucY+ykydWpjQfhLoNTm6traVgOLzFe+B7TV5eru6PfAd/TV8LLuob6XF0b3Ti4R7se6rUn4OeaKmQ44n0v4y/IfNRryjgXIx7zPlWS3ZUU+VFBKhQU+R9mXuq9i7Wc9LaFp71bscYzXi486x0vIX8TU6Rxxm9EFAkJc3XnvUMznhWQteEF71J+ru6it4pH7f7wqvcIN1d3w2uGl7zzOJT/WZrG6gHPefemqI8qRX2mJXN1Zd57CXq3fYLybItTZn7GCTHyepTeahqlOXwboflEwtQeHqb4uRC164YovjxIY7kC5PvwlPeon+JWP2We78M+ev9hc3X3vb1gtbfEm6tT4e/TXF1X9ltPrm4Fa4D/4hdvrq6Prwk85rvowhnwj4Lf+wXQESitztX9EJgPWwYHwevBdnB86EPIlWyHhZI0FEsnov8c6V34WtoN2T6Q/QIvyWpjlGbytfB7eRoqFZMwh/mK+9Ct6IG5DVf+An9T1sKc26hWwz2qJDSoP8VaFqkfQ5e6L9Y4VHMSXtNkYe1ttN/CH7V8VMOomwq/1D2Gft27qNUY/XF4W18fNezMUCUPMlxU1WmYAgsNT2DU0A81/8h4Gt4xNsQudDFthgdNEuyOw/wZXG6ugn7zyCSd+dvwkqULdrOZ9SDcZnVil5W2r+EcG4fj1eXZZ8Br9mrYyDGJ69WtcHjhQ8cCnldndhr4Xl0XZwkc7Owr8OqGOV/DXOeXQq+uq9Mh8upqOkug29FR7NX97CiDwx09JV6dyHEZ/mzvIvXq+tiPw1e2RjKvbr5tO2RsWrlX96P1C9je6oW/W0YqvLqRluvQbW5Hf1ubf4I6s0Xl1f1gWgHbmmLwhnGS2qsbZXwIfYbeGq/uS8NxaDLU03p1e5g1MJsJwtP6QTrMX18CL+jEeq8uRzcMntLuhtnal/AHjZHx6jSatrAA/3/36mZ434ULvId8Xt1arxH+6J3Hokre116vLuodDjuwf3m8unXsaBhiPW6vbrRvIbzl08FO/j0ur67E3xnWDTyp9uq2B1bCOsG3YUlQC7uFXlehzqEbcEY4AP8Rd0Y8X7IV/icR4d3h0unwd+lT2FH2HjLvlZ2FZnljjPuVfCsMyGWYz1jFbHhH8QJ2Uw7AbA8rz8OaqiaY/xrV9zClUmFdn6jnwwdqN+yhGR7w6o5orsPa2jZBr+4b7Q+Qp2NCXt1U3SL4ROeF/fQjw17dGf112IhpG/HqtjK7ocLARL26zw2LYKXBBz8wjo55dZeMt2ELU07cq9thOgA1ZnsCVTWvSND+xuAwy6SkF/fzX7CVtWcKe2H9BRpsNdNYnW01DOCUFup/t8+E2Q4P/NbxP26hvtoRha2dK3iF+inOmvxC/TfOU3Cn8wNBoX6H0w/XOFcK6alTVKjv4NwLI47G4kL9D459sJejrqRQ/8q+BS7CD7ZCvd3+JTxsC8KetvGyQv1D65/wU2s3eaE+bTkE11qcikJ9LctKeNgcgd3M45WF+j9Nf8KPTN1Uhfqo8TBcaaypLtQ7jWtgiSEFuxo+1RTq7zKP4EfM29pCfUh/EC7SG3SFeoX+M7he9xg6cWYL9bu12+Gb2hD8UdOJQVwzC65S74Rh1Xk4SvV5AHHvM3+hvpm3F3zXW+Ir1P/Pa4Pfe1ewhfr7Xg58g13oLdTPZiXwEbvRU6h/25cFf/GddGNF/n7wG/8zV6GeF5gFpwWU8GVgX3WhPg93aaH+WVAGPw5dq8LoofVwRXgyrBkZAk9G+sLB0d7QF30Hfh0j34yTlzOOTrwLk4n+cFOSbJmi/rdT3WF+uiuUcKhdzKF4Dpf6PMo4m9cH6vmU52DGPgLyZcZFQnrqFA2EJ0SfwIHibfRU7KbMkncx8/8kh+EoqRXr+kP6Fewu88PDsjFYew15OVwl74yaJOT74SSFFbX6S7EUvqMMwFLlaFSyvqocrld1QoX56gNUbbUDla9QF8Lemjgs1XyMfamnvQ+/1XYPFuoFukNwuu6NECqp+xq+p4/DM/qJ4UJ9I+Yu3MJ0jeAkGA7CuQZHtFBfaVgJPzDG4GXjx7FCfQvTA7jd1DNeqFeZj8LPzbUS+CLMa+AwSwpes+Qn8XVYH8If8GUV6g22X+BXthrpQn0Q93+hfox9DieL2eOIwbRjETeLedep5WUxy5x74GFnF34Wc81ZAX93zhZkMWecamEW851zBxzvfFOUxdid++BlR31xFvORYwvkODSSLKbI/gVsZPfBC7Yx0ixmsO02fG3NkWUxn1sPQpXVIc9itltWwGaWMLxgHqfIYgaYb8N/TJ2UWcxM0z4oMtlUWcwm43LY0BiBpw0fqbOY9wx/wmdMN00WM4M5BEWMU5vFbNAvg3X1PviLboQui+miuwLLtc31WcxI7WZYpUnAqZqBTBbjVX8PJ6r/hg9VKkMW87aqGTyg7AkZ5UD4mWIIfCz/AHaVU3u3jJTJBsMp0kHwjoRsnXGLOBdyMo4TkdeEZKOMawVkiE+Zh/Lfg2d4fWFtXn+4lEs5qzjDYP+MR9I0ljlNT+elqOezJL31dpIy7E1QNlXGaXHyfoxsn3FblBREaVYTI+SNMNksTKOsD1HmaJDWNTL4IbwQGArrBWjclX7S4yMH+qhnKfsOtLMvg1nMLs+7sNRzOIC1e2ww5Fnixyq8QR+yeSfBXd4XbBbj946DfdhqL6rKfgZNPilc7PvOk8X4fE3gaP8FdxZz2z8I5gReudAzMAc6ghq4OvhzNfY39C78IhSoymK44R/gsvB4aIx0gD9HGsC3o7Xhs2hNOC9WA1ri5JGM/RP0tDqRBZcmydqpWvBsyg6Hpi0wlLbBbziUoRG3PrzGpZ7jeHUgh0/xLXzK1lpA3hFQZIqQ8shE1H+3qC3sIh4L74n3wDGSBHwhGYL5j5UehU9wC2Uxg2SLOGWM2angljFjnFvhFmcLXhlzyXkT/u2cxC9j/nUKBWXMQ+f3sNTZRFjGLHCWwhbO1qIy5i9HCZzlqCsuY1SODXCXXSQpY1rZZ8KrthdwqG2gtIyptl6A863NZGWMxrod7rCo5Mhj+RxeNL+GA81DFGXMC1MZnGlqrizD17cdbjSqVWVMlnEePGGohn0MQ9VlTAVzDU5m2mjKGC6zB67TM9oyprb+C/iLzg276Ybrypg72t/gOG1rfRkT1OyCizVSpoxRaibCterTUKUWGcqYL1WdoV/5ERym/ByeVyyBdRXL4DI5WS1bCvtnPCKlp6aMcyVfwSdispv4S7hbRMoyThaStwVkSwH12cRfBJO8+TCPtwCWcSmexV0BCzmF0JteDgem6a1fU9TTlqKeC5KL4fME9X87QU/3xklVxqkx8m6UbBulPlsjJCdC8xwXJq+GaP4NQ7Si1UHSH6BxhwRWwhN+Gt3pXwUX+aj9kqW33mFnwgPentDirUbdtngKQ2VMU48/WMa87xkBP/dcC5QxBz1tYaVnv7+MaeZtAL/0/uwrY555m8Nu7Cm2jPmJ7Q0Z31/eMmah72Po8sU9Zcxw/2r4u78W7Bj4xV3G/BzoDi3Bu64yZmnwYxgJpqrLmEmh9fBxqCkcFL5TVcb8EV4Ch0YGQ08kBy6PtoF1Y63ghVhLODKeDWNxam9ItIUtkh3hrSS1P0k1h+J0Y7gr3QjmcJrBCg7lKeB2gAyvHSzhUYa+fMr2OuNXArKmkOJnhDTiUBFlDoneh2vFc2F9ya+wFF9lGdNd2hMz/126pZpOFIeTZ6jrXAnznQ5unmGn8yi87OzPyzNUOKvgv86l/DzDM2ctQZ7hqvMo3OjMEeYZ3nOeg2FHW1Ge4VvHftjQ4RTnGc7aV8EB9gT8x/axJM8ww3YfCm09pHjXegQ2sNaW5RlOWr6BfS0ceZ7hiXkynGJ+BDnmXoo8wxrTMVjTVFuZZzhkXAu7GtPwT8NkVZ7hI0MFDDO91XmG5cxxaGMaaPIM+/UbYWe9QJtnuKWbBvN0TyGr7afLMyzWnoaMtqE+z7BbswG21CThWfVwJs/QTX0YnldFYCtVI0OeYZeyP5Qrx8D/KSbBP+WfwDYZt8gokpZ+DMdmvCKZCBtmXC2eAP2ij+CQjCeEFHFmXCSgPi/51O7NHwsP8EZDHW88nMWl/A85k2GnjDvSlF+Ypp4fp6jn78lxsFmSMqxPkNE4OSLj+RiNWDdG7WVRsjpCI/bPeCRM2cxhmv/nIfJpkEbsHsyHewKf0qoDU+AUP3nHR7b2Ufw7ljKnvQPhOG9deMtzCxXr5xkIve5hEVTGfS6MXXPXh+XutaE8Q9zNgS09M4J5hrkeVyDPcM0zCTq8Vf48Q4F3OqzwcmAP9msf3mWd0OE7yOYZVvo6w4jvlhcj+kfDO/6AB/sVWAp/CZhgjeAed55hVbAtjAdvuPIMn4RGwochXzUqHF4GT4frwlaRP6tw9iI7YL/ocvhfdAH8MjYH1ojPhqfis+AHiQIYTMyDa5NkoxQ9vZaaCsenp0Auh9pbORRvy6U+dzNO5dG7Sj7l+SljDwH5PON8IWkVUZ9jIhp9gPgb6BIfhkskj6BdKsdsD+FrzTN0kW2AV2RB2F0+P51nuOngcBKGEc51cK3zLW7CcMh5GV50juElDNedKXjDuZmfMJx3Nhck8F2XwUnOPsKEwe68Cs86OokShg8dh6DHXlOcMCy2r4YGexLutn0iSRha2x7AK9a3pehpPQqrLHVkCcN8yzqosXDlyIwvN2Foji8Xo5veUSQMuaaj8IWxljJhmGFcA4X4chOGjfhyE4Y38eUmDCfx5SYMffHlJgxP9FmahGGqfgPk6/nahGGdbiqso3sCj2n76hKGntqT8C9NPX3CMFGzCvrU1XC2OodJGPyqJXCi6hS8p3wGOykjsFghMCQMUoUEfionb8vEsGXGTVIRTEqEcHTGS2Lq30DMh6tEJCskBwkpflxAOjJ+wefBf3lJjPIOLw33cymDliuDMzly+FeaRuyYpp47U9RTlKKek5KU82aC8jTPuCFOkViMHJnxQpSsF6WnKyKU2R2m2Q7IeCxE87eGKP/8oBQ+D9C4bwdo3L1+UpVxmo+8x1L/dizNYZv3BRR6D8OpnlHQ7a5CJZe6x8CO7lmxhMHmfhRNGJq6u8Ae7j2RhGGUWw0Xu+eGE4YjblcoYQi4x8Mcz79BVNLzMYx42EDCMMw7B573iuGbbJE/YShiG0Kx75QPlfH1hf/4HrMJQ3//ZHjKn/aiZ+AbuDlQB0qDRz0Jw6xgD/g8eM+NnqGJ8Gwo7koYGodXwa3hGlAZOV6NvYjkQW60BlwdjVclDPVjL+H52EM4Iv4njMT/gN8m7sKmyb/gjeR9ODFVDgXp63B7xg6cW/ABh3rO4FJPDe8e3MejDD355D8ZFwhIm/A2/DXjQBFFPCLKvFL8nGYi8cMLEinmNlxaHwalQ+AK2SZoklfD7+S9sRaT4iD8WmHBSrnKuSnM3BFI0Xc6M50wGJ0cTpHxY+cmuMyZzS0yFjnL4ffOfF6RcZtTwi8ybnEWwzXOjoIi4zRnOezo/EBYZGQdD2CR431RkbGl4xK8YW8pLjLm2Yuhz6aTFBkX2xZCxuaGP1iHS4uMrazX4VVLe1mRcZhlL3SZzfIi4wLzV1Bt9sHtpjxFkbGp6QY8Z2ynLDL2N/4InxtMqiLjDMNXUGQIwI3MGHWRsQFzG57U52iKjH31B+BjnU1bZJyiWw45ujBcqx2nKzLW1N6EBzTN9JiJZgU8qr4HG6n1TJFxq6ozFKtGwsnKafCOYh5so1gMt8i/hJyMY2UUuSJdBBtKv4CrJQuhX0wOES+AJ0SkM+MiIflSQPYWUJ8D/PlQx58DZ/I+g39xKdKRS/l3cJZAIYfaH6cp/nuK+jTLuD5JkWiC8gxPUM5zcbJOxmUxsjpK9o9SnyMR0hShec4N05yfhGj+3UKUf0/wKyjPODlA4/7hJ1tl3OxbClMsPR3DUp7L3qnwTe8guNZTGybdf6KGs9zjodT9GBU+5eoNC13n46iM6014zPVtrMj4jysdLTJq3ZNgZ/e9SJFxqvtteMB9KlxkDLvbwnc9Z0JFxp89vaDWezeIOXvHwldef6DIOIBdDM+xBtjE96Mfp9TXDir9N3xFxs/9w+FrfzVbZBwcmAfLAmrYIrjDi6oGm0FV6LwHOUMD4OvQC3eR8YPwLHglLIWtIltcRcbdkVbQHn1ajW8huh02ik2DF2K5cFj8bRiOd4HrEt1gk2RPeD3ZA05IdYb8dDu4Ld0Wtud0hPc53eF0bi+o5lH7Z14O7MUnX2RcKCDtQrI0Y66IZEU01iox5W8g6QMvSWgmo6XjYUK6CK6XHYQN5S54Qt4O8++qWAcvKIKwg3IEVleivAprqVpg7etU2yFfrUZNpqnnwafqKvieZigqdlpzDTbUtkY9N2uLoVSnQ50/0y2Er3QeOEg/ArtQpr8OmzNtsUc7mD1QYzBi7+YbvoQugw8OM47Gzv5mvAnbmjpgx3807YUmsxknYYl5CQyYg3CMZSzOyW3LbZhj7YyTc9C6Hzpt9gROlG0VjNhScKx9WpLunFewhWNMqsj4reMfWO34NF1kzMbNlm0a5PwOjne25mabJjn/yDiZl22a6JTxs00fOX+AI5ydBdmmns670OEcJ8w2PXZUwtWOCaJsUwvHY3jL/r4YeeznYMTWWJJtWmHbAm02mTTbtN9aADtbX8LblsGybNM4SxkMm5vLs03LzNugxaxQZJt+Mn0G25lewuvGgcps03DjeegyNFFlmxYYtkKtQa7ONu1iPoPZzH/win6IJts0VH8JVuuaa7NN83TboUqn1GWbvtfOhm9p/4K/aBrps03NNFPhD+rdUKe+AeeqXsLnyhDsqUzDnxUCJtukUYjhDDn5QCaCHWRCuENKCqXU52MJH/4u5sJmGTeIyJiQHCnkwQsCsn7GlXwO9PDiGCU3YymXetq5NMpCjgT+m6b876RpJvtTMZpnKglnJSnDwwTZOeOuOCmOU4ZPYmR5lMyOUrwoQnNLhGmeo8OU81KIVtEgRGOtCtJYbIAcnPGEXwqdfhlc5JPDVyy1+7D07kEvzYTx/gvneM7Af9wL4CB3TfiXqxgVnucywBzXPNTf7nqBHRG6uiWyTXVch+LYTVdduM21JZZteu3Sw2z3yih21i2Av7u/iGSbankEcL6nMIwd8VhhH+/eEKrk7QDrsTeD2aZv2VGQ52MD2ab/+b6ET3wm2M//kz/bdNrfDr4ZuO7LNm0MDIfCoJvNNk0PLoDPglrYL7TDm206GWoGs8IXPdmm9eHBUBD5z42ekTnweUQNB0b3u3Aao0Ng35gWPog9qc425ccvQ2HiDNyROAc7JMvgg+QFOCN1EqrTx+DPGXtyKPIP5zycz6WeVh69dYx3Gr7PJ10ZlwtOwbpCap/LOFxERkQU/1ZM7SaSs/C6hMaaIP0N8mQP4Vb8tZJtai13YJ6/y3PhKMVmWKlwwcnK3lhRpXI/HKtisN4Hqvmwt7oKHld/QNXQXIYbNC1RJYG2GE7TalHDp9r5sL+uCp7VfYgKN9Jfhd/pW6HyUqYYzmZ02JeXzAKYa3DBi4Zh2LVmxmtwm7E1dlNp+gF+btJjl6tMC+FQsxteNQ/HGWhluQ6LLW1xNnTW3XChlcGZ8VgXwZE2Fl63jcGJamW/B7+390tmm7iO3+Aox7upbNNRxz2YdExM43bCLVduauvcAnNwy5F3YEfnFF65qT1uuXJTO+du2MrZRVBuauB8CJXOKcJy01NHEm53fCEqN/VzJKDHPlVcblpqfwbt9v6SctMB2xmYY3tLWm76w7oZjrNKZeWmkGU2XG75F9osA+Xlpn3mc7CjuZGi3HTT9B0cZZIoy01e40y4yPgP1BvfV5Wbig1nYCvDW+py0xVmM/yQkWrKTdX6ArhA/xJq9bnactNO3XmYrWukKzdd1H4D39W+hjdwy2FWmmHwZ/VcqFevhZ+pvod/K3fDrsqf4G7FXijPOEVO3pFRvI3sR7hFugdypNR/nOQHeE28CzYS74RrRdQOCcmhwmJ4RkDWFlDPpXyKV/FoxP68rfAIlyJmLuWfx6GxnqUpf4/0drg3tQWqUtSenqQ89xOUp32C2tvipCBOGSbGyBtRslmU4usj1DMapmwjM14I0fzrhWisFUEayxP4GQ4M7IO/+vdDu/8AXOg7CF+wFHmHpbf2e2m2Ou8SWOAZSfN0v0Hvuq+gtndcA2G+6xoqX8fVCrLV27EjV6tpj3ZWT8N+zavukcS41UcS5aay6oZQ6dodx4676sNS18+xcpPJ3RTOch+NlpvuuTvA1p5LEdTc8z4UeJ+Ey02TvVPhI68A9mE3hspNJ9gGMMt3Mlhu2ujrC4X+JwFUzD8NPvcLYP/Aen+56XSgHmwYPO4rN20K9obiUAVbbpoZ+hQ+DyW9ONXhVfBkuAZ8M3LYU47/X3SHoug9d7lpRjQfvoxK4ajYYVe56UlsMsyP94H8RGf4fSIHtkv2gHeT3eDUVHuoTLeCP2bszqHIE05XOJdLPU08euswryPsxycrM34lIGsKydMZPxCRAVEHuEZMed6SkFckFBkrpTmkpW/DzbJc2FI+Cd6Sr4QTFCdgQhGGK5U5WAWj+hZuVLHQoB6ElRaqz8KUujX2aLb9IHxkfwt719pRApc7OqTwtTpuQr7zozROFO6TfHMT3Cf55mbONtx8c2Pnn7Chcyov39zAqeSTP8EsZw9BvrmW8ynUOT8T5psDDqUo33zBUQTnOszifHNNx2p4ys6V5JsH2KfCF7ancJatnzTfLLGdhpusDWXIb90MT1sk8nxzP8ss+MT8D5xifl+Rb+aYz8K1pkbKfHNt03fwiFGqyjf3MM6G9wz/wgmGgep8c4Q5D1cwzTT5ZgezHR7Uq7X55i76z+EfutdwjG6ALt/s1h6C07QJ+FrTVJ9vHqzpB0+r82At9SS4RDUVVipnwH7KmfCwgtoGxXT4mXwa/FtGfbrI/gd/kE6BEulkmC/Jh+ViypOdsUhEJoTkKOEn8KKA+tQXfApX8ini4Y2HA3nj4DEu9bRyKfN8Do3yPE2Z305PgHtT1EeVova0JOW5lyDbZtwap2zcOGUYHyOvRclGUYqvidCIgTBl+yBMcz4VolFqhGiUL4O0rlcBWmOfAK36oH8W1Ptnw9k+aj9k6WknlrLt9H4Ixd6WcIoniXo+dlNtB7mpzg9df6Pm01wfwjdcN7Ejf1XnwA3Vh7FTg6trQWt1vRR2oWpDMt9ct1oJp1QXJvLNV6o1sJ5rYzzfvNxVE3pcB2KYs7s9vOC+Gs03v+UZAos8ryL5ZqF3NpzmFcMn3s1h7BrbGJ5lz4Vwkn0D4Fbfi2C+WeGfAT/zi+Ar/6ZAvnlI4E14KXDCn29uHuwLdwaf+PLN2tD/4PwQF7pCa9l889BwDXg5fNiLnY10h7sidz3oGR0P50cjbpyu6Fo4NtYcPom9cuWbJ8ZPw1T8INyUIFsmj8DbyV/g5NTPUJbeDXdn7MrZCx9zDsM53KPQyCuBh3n7YD/+AVjJ3w+XCihSW0jtsxmHiSgSFlGGb8U/waYS8kbGiVJSIKM+22WUv4Oc5vZAfhNOV/wHlUoVZv4DbhWcKNV8eFV1HfZX18Mab6lXYV9qO7TYqVmO7+EJRzPsoNtxDWqd49LYR9wkEktn3CRkG67E0gE3icTSxvk/nsTSyqngSyytnT/yKdJdQJGnsLFzjlBisTp1Iokl6NgBSx11xRLLR45tUOjQSySWLfbFsKndBy/aRkslllzbLfjS2lEmscy2/gylVotcYtlsWQobWgLwlHm0QmJ513wLPjZ1VEosU0z7INdkVUks64zLYV1jGP5qGK+WWHoZ7sCHTFeNxJLPHIJp/RtaiWWNvhDW0IfhAd0IncTSVncMHtfGYSNtll5iKdJ0gSn1u3CsegC8ohoMG6o+gKuVpF8xBA5RDIIn5bnwDflAuFhG/V9J34d9pP3hQUk/qJdQttniPvCRiOyccZeQ4mJhX/iJgHre4pMt+O/AjbweMM7tBUdx34NlHMqfxaH8hWl615t6G+ZmLE1SxJ6kDAsTlPNFnOwVp/i+GI2oyTgjSj6I0NMOEcq8PUyzFYQp88QQjXIjSCtqGqTVfRugCkT8tPbh/g/heR+16/qoAstZGtHlbQ8HeI1UE8991PMtz2L4o7s2bOz+FTU/48qBH7ouYkcS1d3gzuqL2Kne1Z1hsOpX7ODeqvpwctUnKYllVtU/SZyTqjHQUv0qIbF8Vj0NPqtOx/GWqxD+4rLBN9w/x1ATdwcYdd+I4tR5RsK7Hl9EYunu/RL+4jXAmuyPYZwEtgPk+m6GcJZ8efCJzxeUWPr6F8ETfgZmBfYEcB4CbaAweM0vsUwPjoD/BN0+ieX90AJ4JqSBb4W3sxLLpnBTKIxc8KLCkVz4PPLCI7H0i86Ep6Iy2Di22y2x7I71h1lxAyyNx13IlghCVyIKlycTsG4qBM+nPHBEuhpG09T+lkPxplzqc4MbgxN5ASjgU4btGTsIKPIg4wwhqRH54T6RD/YSe+GLjAsllNMudcPSjLkyintl1L9QHoFZCg7meVGhhqOUdWFU+TZcq5oJ66lL4S/qOdiX2Q4BduqsYyMMOBpjBy3Oa7AJbhWJpR1ulWLLONwqxZaxuFWKLaOcd+Fw/D4ptgzF75NiyzD8Pim2jHC+LSCfww+c84TFlj5Ok6jY0si5F0YdzcXFlv2OEtjfUVdSbHlt3wjn20XSYovGPhPutP0DW9jelxVbLlnPwcHWxvJiyyvLFlhgkSmKLVLLLLjJ/A9sYH5fWWw5YToH3zU1VRVbHhu3walGtbrYwjfOh+sN1bC+YZim2FLKXIO9mVbaYstD/U44US/TFVsCuknwM90pamsjcJzWqS+23NA0h8007eB6dScYVeXAEaqu8LySrKvsApcpOsNqeUfYX94BHpG1hyYZvTtX2hY+kbSB3SSt4G5xNpRlnCwi/xC2hC2F9HSTgEzyW8PRfHpaxmsMs3hNYSGXnno5lD83469p6mlL09MFKer5T7IF7Jmk+N4E9VdlnBanUe7FKGfbjFujJDdKT8dHaIZXwzTbt8I08zUhyh8I0oqGBGl1JwO00jcCtOrFfqrAKx/Z20fxAyyNqGPrwtneJCr51HMc5npGwrvuMGo+yr0SelxWuMi1BzticTWHh6pPYaf6VHeHr6quYB+XV3WFrauOYn8DlTXgxcqsNGZYuS1VbNFXvQHzq35IFltuVjWGLapPJYot31f3hQrX33HsqesT+MIVjxVb3nevgufcTtjYUxLF2j3doNJ7P1JsmeedCKu90TBONbsKXmdrwPa+w6Fiy0++HtDivxsstiz1j4d+fySALyKwAv4RsMLOwX1+VCDYGb4RKvdhp0KjYSzkY3HSwl/AP8M62DVS7MV6I9nQGb3oKbasiA6GsajHXWyZElsDq2Ld4PS4CUoTElicEMOcpBJWJGWwIMWHhnTKhWwZ+3Io8ppDT7/iUs+aPHrrDE8Ih/JFMMSn9jcCsomQvC4UwAkiepcv5sHtYi7sIOHAB5I0Ms+QUn6tjNwvo8g7cnr6r5x6LlJQHqdSAU8oLXCwqin0qj6AS9UboFHzCfblhiMBJc5vsF/NnG+l6Ja4Cj/EbYPTjtsmx7oGt02OdTVumxzrSvyGybEuw22TY12C2ybHuhS3TY51Of4ayrGucD4T0NN5whzrfNw2OdYJzv2wvbOtOMcadpyA2xwtJDnWDo7d8A+7UZpjHW//EoZtfrjcNlqWY7XayuE+a2d5jrWTdT8st1gVOdY8y1LoNfvhQnOeMseqMd+CO0ydVDnWbNMBeMXoVOdYhxpXQZchARcYPtGgp+EvuJPpoc2xNmMOwrN6Rpdj7amfDK/iN0yOtaOuEu7VyvQ5Vp3WDmdp6sCH6vqwkzoL7lQ1gCLVm3CSkto3FRRvrqgH18upf1RWG46Q1YTnpWRdaQ24XPIGdImdsL+Y8h8ROaA54+dCij8VkN0z7uFTXM43wyk8I7zDpbdac2vB7zg0VjpN7bFpil9JUZ+GKeq/OkkZfAlycMYTcdIZp5yLYuTLKL3VO0rx/RGamzZC85wZpjn/FSI7hmgtO4I0liBIa5wYoPXe8NPam/qpDt/6KBJhaSbDWQae8wZQyfreUljkGQ2NnhhqvsP9NWzqrgHPuw5jRwa6usKX1bexU3Oq86Cq2oV9/KFqJuxSFcL+/ls5BRZVPsG+D6tck8ZeVEphYeWqVI61qtIMB1QVJ3OsJ6uaw7rVFxM51nXVgyDP9TKeY/2fayascIngO+6NsRzrr+4GsJ7nRBTz9/SDAu+zCNbunQFfeAVwAFsUzrFeYBvC5r7TIczf1x9q/c+COFf+qbDKz4dDAxsCOdbfAvVgq2CpH/MP9oHGUIUvx7o49ClkQyk2xzoqvAr+FnbCNpESL3Y5kgOZaLknx/pFdAz04G8o7GlsPXwU6wSHxwXQFa904YtL/AtrJ6l9NvkaDks9h+FUBVyXfgSbcJ7A65xXcAK3CvJ5L+E2HvXswP8HPsg4Q0BqhBTfl7GXiHwhega/EFMeh4Q8LnkMB0n/hqyUxlolI9+Uk5flNO4YBZlSUJ/NSsrcSuWGf6iEmH++uhnkaZpijcu0m2FMK8HaJ+lmwQe6F176HgegMsf052Adpgnq9g3zPeQYlKjnZMNc+LfhNXzXOATVPmG8BBuYWmAXNpm2Q4lZjT2aZZ4HX5ir4EDLh7SPliuwmbUldna7tRiqbDrs+zzbF7DK5oUf2kfjVJTZ78G3HHdxWp44xuIU1XRG4HvOtThd+bgn6X67mqK7bhzO4de4Jyusp3BPVlhPOttyK6y/4ldZhfUI7skK62HckxXWX5x74VH8KqOnzwXUni+ssB50WkUV1q3Ow3COs6u4wtrJeRW6HN0kFdavHaWwnuNNKTLbN8N+dqmswvrUVgCn2f6DQtsQeYV1I3agwtrAmq2osB637IDvWJTKCutf5jnwY/N/MGYaoqqwrjRdhg5TK3WFtcT4A+xmNGgqrPcMX8KJBj+MMqO0FdblzDVoYBrqKqxb9AugWX8WLte9hn4tX19h/VCrhac1JlhTY4VfqcnXKht8V2WHJUqSUVK8QGGGj+RG2FlugLtkDBTJ9HCSVAdvSshmEsq8XqyGURE5QqSB54RknYzLBGQVn3yPr4S/8CTQxJPDOVzK85hDc+vKoRF3pymnNC2Dn6ao5+0kvdUySRk2JchEnMzLWBajcetnXBmliCdCGQZGKPOxMGkN08znh2gVz4K0oh5BGvGngAUqAlSH//nJP31UgTY+6vkdK4Yc1oVKfoR7ssJ6xzMB9vPw4D33BlR+vLsBDLlOYUeWuPpBk+sx9uun6imwQ3Ua+3iz6ms4psoKY5XbsctFlU7YpXI9zkDotQj++jqYxkl7/T/IrQyl0L9yMbxRqYdtq3YlURncnBVWPW7OCusX1YMhW/0qXmEd5ZoNb7jEsK17U6zC+qP7TWj0nIpirz3vwaDneQSzxc2JNXqFsCtuTpx89i1YGzdnhXUtbk6M7n8epGpMhRW4OSusfXBz4mzj5qywZuHmxEnGzVlhFePmrLDODOXD56EkW2F9P1wIT4cd8M3IQW+FdTNuTvSM3vJUWKdH8+DzaMBdYR0QWwkvxxrAnPjfrgrr1fghODKxE0YTxXBD8gfYPLUN3kwVwUnpDVDE2QR3cSjemUt9HnF3wdm876GevxWW8Kn9roDa/2X8SkiRmiJqnxZtgUPF38FQxm8km2FjKWW+LqWxJsg2Qr6cRtwuXw87KL6FDzLOVNJTrYqy7Vftg++or8Pnai5WNEPzHoxrDsLZWhNWXaVdDIfrWHhDNwo1aae/CX/Sd0CtzMxeuISxoJIBZhkcYwjD24bxqHOO8Q48aMxB/Z2mA/Brkx37kjStgPnmKHxonoi962W5D49ZumNP61kPw/XWGthrge1rON2WhM9s+TgP/e2P4Gl7X5yTLEdZjO6xrjg/lY7fYGvncJyuyc4AXONcjVO3y9kQ5/CA8wo8hhu1wnoCN2qB7TFu1ALb3/jlWWB7iF+eBbZ7zv/xCmx/OhX8Attd54/wvrO7oMD2l/Npxs+FFDeJCmzXnIfgAWcPcYFtnvMWbOXsL0FOxzU419FRWmDTOw7Cn+w1ZAW2Tva18A8bT15g+8g2DcasT2GhtZ+iwOawnoIHLA2U6GnZAG+Z+aoC2yjzVMiansBFpn7qAhtjOg33GN/SFNjaGb+DNwwybYFtpGE29DDP4Tymh67AJmQ2wUX6B9Cv4+oLbCN0ZnhRWxfW174JV2regh51Izgw468q0qZqDBcoqf2PoiHsqWgA98mzoEZeD86QUZ4H0jqwQ8btElIgqQUnimvCGyKyqYgi3wrJiIAcnvEcn6yDX6EFtmU8K6zmvgH7cyn/EQ6NaObUh5+nKc+zlA32yPhTsgZUJinD1AR5N062zbg1Rv25GcdHKXItUhs2itAM14bJYIjm/2GIxjodpFFqBml1XwWoMq/9VJm+flr7IR89NfjscA4rgk+8j1HVd7xb4UlPN9jR8xCVv+b+FH7o5sBK17fYnTmuelDu+hW79n11L9i0+iF283zVJ3BgVQx7/apyCVxQqYKOyjU4Cedeq+Anr7/CCXnj9UGc0qr/6sGWr39MY/6vm8PQ6wupAtvYykHwj8pXyQJb16oCeLBKCu3V3yWwv9WNYbz6bBw74uoP77qexQps3dzT4WG3ANbwbIgW2FZ7GsCU53SkwDbZ2w9WeJ+EC2y92enwBCuGb/o2hQpsm3wNocR/Klhgm+XvC//xPw0U2AYEpsHzAR5sHPzWj10I1oeKUKkPdQj1hq9CD9kC26Dwx/BcOO5Fz8gquDXihPLoAU+BbXY0B/4b/cONnrGP4KVY2oXTHt8DT8Y/gb0T/eGLRF+4IPketKXegb+musKB6c7Qk+4CV3J6wfrcfvAil/qP4vWEMd7bcAOf2s0F1L4poPYkISkSkTtFFO8k7gEfirvDWRJSJ+0GD0hprN4yGuWlLAcukneCTkVHeELRAQ5WUsSnpP5fq2gODdQTaSbqIjhE8xQ+03TEGkdpi+GfWjXW3kP3OTyqew3r6D9AZb7RX4YcJht1m8Lsgn8zOtSzj+ELWGrwwPrG4aj2BuM1KDK1wi7MNO2C/5o02KNc83x40eyCTS3DsYNbLdeh3NoWOzvHuhtWWvXY9w9tX8CrNg9sZR+JU1FsvwU1jq44LZ85TsAKR3ucpWznZTjHOQxn7EdnEJ5zrsHZu4FfsAW2O/gFS3fmuDTdsRwOY3+F+5ax/4v7lrE/xy9Yxv4Yv2AZewV+wTL2v/GXPmN/gr/0Gfsz/IKlPvOFFLGKGPt951F40fmumLFvdVbAMc6xEsaudz6HpY7hUsY+xPEn9Nl7yxh7of0srGNvLmfsJ207YT+bVsHYn1oXwKlWF+RZhykZ+zrLNVjH0lrF2I+ai+HbZp0aI5q+gBNNHhgzjtQgp/F36DR20DL2Q4afYVeDUcfYy5k58EPmNryv1+gZey99O3hY9z4060bCz7Vj4VPNeNgt4x41Kc84RTUO3lFSn1bKMXCzIg+m5KPgGDlluCwbARvIhsNVUpKVDIODJEPhcfGH0C7+AC4UUfuFkOK9Mu4TUEQtoPZ0/hB4nzcAtucNhNu4FOdzaawJHBr3tzTlb5weBL9J0SpCSWoPTVKeMwmyZsav4vTu6xi1+8Zo9ENRkolSvCBCM6wIkzlhylkcolWIQ7SiT4I04q0AjdgiMBpu9JMxH/UZ6aNxL7JtYBarpJl4f0eFBd6ZcLFHBZWendiFre5s2Nh9BbtzxjUU9nNVYdeeVs+F06uVUFi9HTu7vqoZrFd1ATt+vLI/7FdZgZPw7+uP4ILXLpwT++vJ8Px/L3F+Zv43EOb8l42zOuC/3Ti96/6rCyv/25/Gu687wBOvb6awL5Vj4ObKUBJ7WrUMflZlhi+rfkpgj6o7wkvVN+OMPds1Cu5weWPYEfciON/NwGr37ihjH+ZpA697fosw9nbeYfBHb3WYsRvYhXAJy8AwuzvE2Mf72sC7vmtBnCj/UFjirw4w9jcC8+HqgBomAtv9jH1SsAV8GCzz4TyEBsFjoZcsznx4JlwTFsJkeKOXsedHGsBHkRMe9Iz2gceiFW70jE2G62I8KIh/58Lq4j1gIq6AqxKhasZePxmEF5N+OCpVDeOpV3Bj+iXM5lTCcg4L87nUU8LzwmIe9czhkxV8F/xMQBqE5CGhG/YVka9F1GeJuArWklC2MxmHSl/DsJTGWiejsZrI/4XX5S/gBMVzyFeS25UU76CiPA9UKThdXRvzl2vGwk2a49CmdWKN32iX00p1IThDNxZ1eKG7DQfqc1Cf8/oDsAnjQN22MoVQYYjDOYZJqO0rwwM42NgdNb9iPARbm5zYi92mQmg0R+ES8wTsV9B8D46x9MA+lluOwk7WWtjf/dY10G5LwkLbJzgDcdtD+LG9N87GPfspmONojjOzx3EAipzNcaI+cJ6HG50f4KSdcfphOX79YqX49Uu369UU3ajj0nQDczgl9mu4jUvsV3Ebl9gv4ddvif08buMS+1ncxiX2c7iNS+wXcBuX2MuczzLOE1LEIiqxn8ZtXGIvcb4nLrGvd76AE53TJSX2Bs44/NuxQFpiX+5IwyaOubIS+237j/oS+6++76HdtxR+wQ6DVV4rHOkt05XYH3lGwXEev7bEHnB/Cb9ym6DRvVdTYt/t6ghbu35XY+bVI+Hwaq+qxO6qWgznVRmgqmq3ssS+o7IVzK68pMDqXufC4a+fyUvsvv8+hl/juy6xt/tvMEy/Oo0ZPn1VE/756ivM/Par11hL+au+YmofwhrvvDKI6GkB1n73VYWAzBFQpJhPbQl88CofdXv8qhw1rHrVFqr/24/a5v7XGB7873gaq3j9Dlz8uiJVYve/ngrHVQrhvcqiZIm9R1UWPFx1PFFir1H9LlxT/SSOGVb/D37q4sJHrnWxEntvd1143P1rtMRe3/MO3OB5FCmxC735cLo3EcaKvKthf7YOPM8eC5XYm/p6wW2+h0FUyf8JnOtPBErslf7VcGigBrwSOOQvsbcMdoPFwbu+Ers+9BH8IhRmS+ye0FI4LGyEV8I/ekvsrSLt4Q+RG54S3PYj4KKo242e0YVwZEwHb8R+cJXYO8Zz4C/xqmq8lTgKryZ2wbHJnTCd3Aq/S22ErdPr4J/pb+H/OJuggrsd/pixO+87+JRXBD/n01OzgDyS8X3hZugSUp/lImrXFVPP82LKPEKyAUYl6+EGKeVvLqOxbmacJP8GihRr4U7Favj/OLbv+KbKLg7gSZMmHUmavW9y2yZtgCogqyBTyi4oS4qKjLfiQKHIXrIKioDsJQWVWRAQZShQUHaRLUVRVhnNnm262+T9nfzz/Tyfc5/73Oeec+5D+gfdxeRDMcVnSWiHipST8HCKA/aStscblUo3wt6yCDwpm4T3zZD/CzfJ+yIbfMVxOE1hQZbKFRvgECUX2StRFsBWqidwm2owMixUn4az1JnIvEO9Eb6tiUNFrmimwA7aR3CvdiCqptSdgkt0NlQzqNsCx+jjUeUb+mnwdUM5PGgYgk7QGc/BL42t0SGVxr1wNGNG55xmfoBSUxY6Ks/0O1yFEwN34cTAF4rfb9ghfr/RCVAaoZMhP0qnBIeTy6zGiZHLrMSJkct8ZboHC01T4nKZJaZkXi6z1LQfLjf15ucyX5qexpwbTxG1gOb8AueZBgtzmUkmOxximp+Qy1hMksRcxs8UwcOMNSmX+R9TDFMYS3Iu87PxWzjIKBLlMuWGuXCawQnj8cs6l9msvwRt+naSXOaU7ns4SCdJyWUeaefDyVo3jGrypLnMOs0VmK5pL8tljqt3wb5qqTyXeaD6An6sssNq5TNFLnNJHoIt5HXwG1kjrJSSb0sb4OkU0pRSD5dIaI5DXAMHiavhTyJSEXNWMvkwKQx7JlXCPYm0ckLMTxPIO8IgbB9zm4BsjifHxwfgZb6fdsKn8Wqej3YS56KdxDzNpbiJS+sv5dAeHNEq2kmUZv4UcUJlxA1nN9PMR01kz5h7GukpCTE/ayDv1pMd6mlX2+rI5lpyfC3t/EoNrdyyhp71TTW9V2WYfDtMkdNVNMdc5aWdVP4HnaETcGhoJrwYTIM9gn8gw1cDI+HIgB35d/pnw7n+JJjs34nqbPe1hVm+86ja795hcKi3AjV94ZkNp3mSYLxnOyq+xZ0FW7pL0AlnXUPgm64n6JMXOOFzmflOF/on3fkufOm4iL666LDBk45V6LdfHEH03s+OEUIa/4aePO5gBHR1MXr1V0cFn8YDYh7mkTJ4yjETff674z/0/J+ON6DHcQLfQpazA1zm/COay3idb8E814tILlPqmg07uyXwR/cPzbmM3tMWfum50IRO84yE+V5nYy5zzzsX9vKJ4FHfzgbU1N8GrvZfqM9lGv0j4ScBRx16NTAb9g0mwGPB7bW5TFqoNVwfuliTy8RVjoRTKx3VuczTytlwcFUSPFNVFEauwq/CreHfq5DD6qFwevWLylzmefUM+FaNEJ6r2RLKZVrVZsAttb8Gcxl+3UA4re5xADPrpsC36jnwXP06P969IR1+23DCR700AM5prPDmMsHGDXB6Uz5MaM6De5pHwh6RN+HDyAA4K9oPKjgD4RHOW3Agl+bYucPhkrghkOENhqd4NB7Jp3GIT+PV8WQLAa12SUDjccJc2BRza8Ig2D6RVr6T2B9OSiKFyeTuZHpuD1Ff2omoD+1ETMoltKsjklFwQMps+DzlOJwqTfbRCfA5/FD2BD6QDcJb95WfgifkmchGumIzXKeIR64iiulwkvIF/Ff5FjLZX3UO/qpqhQxnqLfBTWoB8s/XTIPTNM/gM82bqM5b2hL4h7YFqtZatwXu0AlQ02T9dDhb/wI69ENR8ZGGc/CS4RV0QlvjDrjDKEOfxDMr4YeMCP1zjtkMBSYb+qo7znmcq6bR6LqZ+Ds9l/nCtA7duNj0SoTO8NIInef5UTrbORwnMwDnvJPph3PeyeTgl6GT6WkqiHNiHRHPyfQwFcNephy+k3nDVB5zfjxFtAK6ehx2xS9DJ9Pe5IEZpmUJTibFZEp04pw/Bi8wOUlO5ivmJuzODE52Mi+Nl+AiY0eRk1Eb98IDBqXYyXQxLIE39EE4Rv++xMkEdDfgIl2XFCcj0xXD3Vq11Ml00C6DVzVVME8zTuZkXOpbcK66q9zJiNQH4Q6VUuFkWqqmw5+UF2ALZT3cojAonUxUngXz5e1gqawjzIq5VtoBhlPIvJT2sERCc1hJW1gobg2dojYwV0SRo8mkMpkis5NehY8SX4E9Y+5JoEhCzE+FFLkjoOe2j7k1vhVs4reE42Je4pE2XgZcFZcOg1wbHMml557ivAYZDj1rcZTurYhY4YCIBR5ubgFlzRSf0UTr/NtIdmukyA8N9MT4BtrDx/W0n5t1ZNs6imyqJetrKDKmhp51vpreyxpzRZie6KuiOUOrMuHJSi3UV4aRz6Wh47A6OAZOD9Yj802B1XBlwARNgZ9Ql6P+nvANfxnq9ZfvQ/g/Xx2qGfaugF969VDnPYxaH/T0hK977lInuCfAse4qdEilqxAWulTUM6696J+DzizYz7kPfVXnkMNSx2z02y+OR+jAg46ecL9jj5BMgMWOT9GrPzruoHsPOdrDw46tfBo38chxPIpcQuf/7LDBXx2rubRmHb6OsGMK7O6sijqZIudCGO+SwmmuPREn88LVBY5032p2Mlfc42EHT6jJyezyLIVSrwou9O5vxBfh7Qzf811vcDLXfWNgF3+gHnvzL4HagBIuD+ytwxMDHeD44NVaJ3M7+C7sEQrUIJOhxdBcqYCrK/dUO5nGyo7w46rSsJN5UPUO7Bv2VDmZ4+H5MK1aAtdVf1+Jnq9+DU6uuRhyMg9rhsP+tc+DmFk7HabVCeH6um8DToZb3wpOqS/xo5/rB8OBDU98Tua3hgKY0ciHmxt3ep2MuCkXrmsyw4xmJTzfLIVjIomwPsKHm6I82JYjhDc5YvgxVwbj4yTwh7gk2JVHPog5nU/3SuPJQzH7C8iXggS4SEgaE2i132KOSIyHwUR61qokepYtmcaXYo4TkU2iOLhVTLaX0F13JFo4KaUbjJMugmukj6FI1hdvt1B2DAZkqXj39+Vr4A15M+yi+BSZKVY8giplLjK2WHkGBpQ25PN91SZ4SxWHPHdXT4GH1Y+hQZOLKqzQnIZ1GhtqNFG7Gd7X8lC7Prqp8JjuKUzTD0Zl1+pLYETfEnX/zLANPjQkoB/6G+fCX4yVUMNMRbdMZephCbMSvVTFpKG7dKazsDV+52O3pjDsht/5dJ5nRehsL43QOZ8fpTOfwyk0yXH+F5pkOP8LTRKc/4WmJJz/haZEnP80LobJOP8LTSKc/zSeH09xrYDmHI/5lrDQJDB5Idf0VUKhqZZJTyw02Zmz8DozLKnQ9B1TDscy+clYgXkCDxqHigpNvYwX4H1DW3Gh6UPDd7BOL5IUmlbo50K93gkP6d5OKTR1012Ct7XtpIWm8dpdsEojkxWalmm+gCqNB+5Tj5YXmjqpr8JSVVtFoelt1Qb4WFkB85SsEnFFb9hG8TbcJH8fNsjGwTExz0tJa8wVKWOhT0JzhkregyfE70Cd+F24QESRZ8ljYJ9kGh9IoqvipDw4NZG8n0CRzjF3CEmukOIfCEbBa/G0h1fiR8J1fLKaR5HRvGHwbNybMDWOxsu4o6GLQ88aHPPnKEVUUbo6J0IzHzfTuFczrbC3iVZLjPlZI0XuNtATOzTQ07fV006a68jxMS/XUrxFzFU1FAlW0xuNqKZn/RamsTFMT1xUNRy+rOwDB1RaaCchym1a6Bu4K2iDrYJnkf/TgSEwN/AEdXnqnwKn+uNgnH8TarfelwnTfb+hpie9A2B/70PU+l/PZPiJhwMb3evQD6vdaZB1H0OfHHPlwBzXffTPP87xcLLzOfpK5RwO/3acQb+dcJjhAcdS9OEehwM9udsxSEjjn9Cr+xwKWOyYFU9zHvLJHnyK7ObRWAgPOSah/486buNb+NXRAd527MY3Eu80w1HOvdFC0ylnO2hxXYkUmja43oV8d7C50DTTXQgdbhUc6dnXVGi64OkE23ivNRaadnrfgWKfr6HQNN+3EHp8Mjjav6ce/eDvBLMDpXXYZyAPKoKuWuQ8OB8Gg1I4PrS7ptB0J9QB9qi8Ul1oOlw5ChqqXOFC09dV82BdlQhODO+sQgeG28A3qs9XolLVIyBbUxEqNH1TMxM21sTDj2o3BQtNZbWZsHfdmQDyXDcYptU/8Rea1tRPhs31UR/q0rAOPmhIg30bT3qRn8Zh8NUmPjzRVO5BxZv/gc7mv2Bh5Dpko1dhScw8zg0Y5tDVtdz7MCvuLiyNuwXzeSSHTxbxb8LseLIsnu4qENBqIiFZHDMngSyPOT/xGtQmlcLjSfSst5Jp7E2m+AoRaRVT/LyY4mMk9JR6yQu4IUWC/beQjoY/S0/DVjIr3nGHbAMUybnIwFz5FOiSP4ajFLnIz2VFCXxN+QrytkNZBJNVicjnPNUM6FE9h++q30LO/1T/DrM1r6IWezU7oEJLNVqsnQODWjscpxuBOt7WnYfd9a1R38P6ndBgEKHuKwzzYK3BC/9nHIfeuG58CFsx49Az85kAPM0sRy89Y1j0WB1TAvn4V6DQlIB/BeiUXttM46wInd6lETrt86N08nM4rLmWKYI1TDaXNVcyZTDAFMSxZh8j4rFmP1MMg0wOnyzn09X58RTXCcgTAooMFZI+IUVWJLBmN2NNZM3PmT/gHSYviTUfYdxwNvN5MmtuxQTgLeMHItb8kfFv2GzoK2bNawzHIWtIlbDmn/Vr4Bv6ZnhPNymFNX+g+w/WagdIWfMK7W/QqM2QsebDmo2wu4YrZ8231ZPhWPUjGFT1U7DmhaqDUKCKwqXKbkrWHFb8D45RzIYX5YthprwQrpSRASk5POavKUuhPmUJ/EKyCD4XL4R9Yx4UUUQiohU+Tyb/TqJ4l6QFcGciGZf4BZyYQPE/hTR+VUjx9YJ5sCZ+LhwdPwee5ZOpfIos49HeXHHT4OC4GfBnLs1Xcekpczi0n8dRWrNXlGbujdDMxAjN/KyZ1rnbROt0aKLxtkYaNzfQCuMb5sPL9bSTFvW0wuo6GodqaVcjY56qoQhTQ2+3uJqe+DJM4/5hunqoahaUVn0MZ1QOhI9CEpgb+hUZvh4cBkcGHcj/i8BsOCOQABMC21Cj7f5WMMt/DrUr8Q2Fg33PUdOn3mnwc2885Hm3oOIbPS2hxXMG/XDSnQsHuB+hTx65JsPJrij6J+r8Bm50KmE75yp0l9NRi34743gP7nP8gT78zmGBOxxfCUmvgCJvwR8cx9HDuxzamPP5ZDmP4r3hbsd+9P9+RzI86CjAF3HC8QDfyD+OgVDr/DPKmqc6R8B/nC8jrDnHNRsed0lghntXM2ve6m4PBZ7LTax5uudt+MzjaGTNb3pnw7PeJJjl29GAnPhawyT/hXpU1j8CuvyOOtacF5gNrwQS4GvBb2uxt+ArUBY6X8Oal4SGw1DoZTW6vXIGvFEphK9XbQuz5gNVLaEmXFLFmpeHh8Bw+Gkla55QPRXerebDnjWbQvgqa6zQUHsiyJq/rO0Lq2sfBFhzft0kWFbX5Mc3WL8a/lTPQGPDER9r/rqhB6xtuOtFbzdOhP80CuCwposeVLOpGM5u3gWVke3waGQTzI2uh87oRljI2QZZ7newhPs9zIsrguE4iq/lfQuz+GQpnyL58SRHsBUWCTbDbCFZFrMgYQsUJdK4OJGe1SdpA3wWc0EyPVEnoviJmEPFFPGJabxCQnuwpvwGz6V46aq0O97lb+luOFgmxZuelX0BW8m98Fv5O8hDgqIUzlJ0RJbsiv1wmFKD7J1TLodZqipYpBqH3IrUN+E8dVfk3KX+EY7S6FGRS5oV8DVtHfxe+wHqlaL7Cy7U9UQd/brDcIzegCrf0K+Arxvq4AHDh+gBtfFfuNj4JnrDYbwJ32BGoXNWMh54lilER/2LfwtwFf8W0Jmc10Tnc7iJxmub6WzPilCkNEJnfn6Uzn8Op8TMw18EJWYu/iIoMUeY+7CBmRpXYq5nxDwaH4BNTB8++Rw2Ml/Ek3oBeTLmMCFdDcRcmUB3ZSaWmMPMBWhn3ksqMV9jgnAbMy+5xDyUaYR1xmmiEvNGox22NI4Ul5jPGi7CIYY2khLzE/1OOEUvTsHe9PPhBp0HWnXvSEvMv2qvwQHaTrIS83+avXCSRi7H09WL4Cq1DzLq0YoS8yHVOdhBpVaWmI8rR8NM5TK4TrED1soPwHflh+HvsiMwPeaXUtKTQg5Joau/SH6EagnNnysmn4gOwl4iiu9NJhOTKfJZUjG8m7gftk+k8dYEsklIjhNS/JJgL+1EsAeujCcDfHI4n+InebuhnrcTfhFHPudSpC+X1j/IOQQlHBpPjdL8+xGa0znmjuZdkNtM8Q+aaM3SRjIr5toGiofr98G8etrPmTrSHHNpLe3NUUPjQTX0jkeq6b3k1fSsmWGK/1f1A+xetR7uqvwcJlVmwzmh58hzTXABXBSUQ0lwD6qwM9ABtg1cRo0u+d+Gb/tdqJ3dNx/O9Elggm8nKrvd2xq+4r2Aup/1jIBDPHb0w1P3TDjVLYR891Z0y2ZXS2hznUYXnXb2gcOdl9BdTY728HfHdnTddw4OXO/IRzeudlxFZ65ytBLSeA06do2jCj28zjEq5mk+aYq5hEfa0f8bHQPhFsdhfBHbHXJ4yLEAX8p/juoo+tA5BxY6BdDv3BopMY9xvQJvu843l5h7ukfAo+6KJvShZwZc6RHAes+WxhLzRG8LeN97pqHEnOMbDI/5yuvRe/5pcL1fAOMCW+vw1gEbfBo4VVtizg3mwpLg0xpUM/Q5LArxYXLlxuoS8+xKK7RX/houMY+s6g8vVv1XhcyHP4Xfh5srUZHqNXBBdSr0Vh8LofNresPSmntBfCO1+XBXbXWgxCyr+wourtPBQN1Bf4n5vfou8Fr9dV+JuVPDu3BPg89bYlY0LoRLGjWwtvF3T4l5VtNXMLF5JtzTPBX2jHwCH0Xy4ezoBKjkfACPcibBXC7NcXIL4LI4iqTyaP7ZmKP5ZHXM9fHkq4KP4J+CD+FEIRmXQH4X8/XEifCfRFp/WhI9MSWZPJRMkf4iuvpSRONFYtIoodVOSWbAESmboS/lHpwvbYU3apZuhAWyOLzvU9lUOET+FJbIByMbrRSn4XaFDVlKUm6Fs5QJyOFL5Uw4XPUSXlANQ4bbqs/D79RtkHmx5js4V5OCujg1C+DbWg+8rM1D1TrorsA9unaoplL/A1yqT0GVK/UL4HiDB942vItO6Gq8BfcZ+6JDkpmr8H/McHTOfsYJ7zFL0VcexoxOq2HONNIpPaqJrGqi83lNM53wrSI0Lo3QyZ8fpX8F0hPz2Dam3yFrykvKY3kmL/yLmZ2cx65m6mFH5nNRHnvPWAE/MY4Q57HNhgvwG0NrSR5rMhTBn/TJKXlsL/1cWKZzwYm6PGkeW6e9Ar/WdpDlsUbtLnhYI5Xnsd01C+AttQeOU49S5LFB1R9wvopV5rFc1RQ4T7kPuhSlcKjiX3hS/gzq5S/hFzLyuZTsG/NgCilJeQ4/l9DMv8XlsEvMnSIyLubEZPLPpKfw1aQncH3iY1iTQL4T85zwEUwTPoTLBf9Bdzw5JJ4iv/BJNZ8ic3n/wCdx92DvuPtwP5fuTebSHqZwaD/3ovSsTtEHcHuEZkabaeb/mum9rjbRaq1irmkkqxpo5VENND5TT6uZ62lXS+tIRy05qJZ2/lMNrayooTeaVU0+DFOkR5hW2FN1GyZUHYeTK5fS1VAnODz0N7L9b/BTODHIgdWB9ajFl4E0qA8co0r5c2AP/wNU8LZvEhzra0JlQ97VsNBrgmrvz6j+fk9v2MlzH11xzT0RvueuRbcEXF/BxS49lLt+RC/tcXaE3Zwn0WMVjky4z7EGvbfUEU7IY6c78uBkR4mQZGMWCvLYAoczPo+d6siFnzuO8kklnyKzeeSjOLq3F5zp2MvNY+c4EuFXjmmcPPZnhyuKPnRMgiOctZE89qxzBWzlYmCR62hzHityvwHnuv9qQm7d/4MjPdWNeexFz3LY1quF33kPNuSxYl9XuMB3pz6P9fomwPf81XV57HX/V7BLQA8PBH6sRWaCXeGy4O2aPDYc/B/MD1VXoxNCy2GvSg08UlkcxndR1QWurLpRlcfWV70PPwwHKvPY++HFMKdaCY9V7wuhG2s6wTU1V4N5bFPNKPhxrTuQxz6onQ/71YnhibodfsysfxWuqf/dh5n1b8FPGp57UfGGmXBAoxiebTzqyWM7N30KLze9Bd9v7g8bmt+AmyOvw9ei2fBWtDP8hNMdCrg5cBe3H+we1xv+F9cDzuDRVRmfxof5PeGA+F6wIp7GiwUUZ4Q055SwGxyZ0BWGEugpqxO7wBZJ5OWY45PJ5mS6uk1EdhBT5K6Yxp9JaIeJKXlwd8oymC29Dc9L2+C9XpftgIdkyT46K+bAr+QOWCMfiZxMVJyHfytaI1d9lDvgMaUImUxVzYVrVS4YUeUhz5PUV+EDdSfkv49mH/xFo0J1WO0SuEYbgFHte6jdFN01+ETXCTUdrN8LS/RyVLyVYRHcZghAoXEs+mG68S/42DgQfdKLuQ634Vc97sWvevShaRm6K9NkT8IfCaYpyWH2byYIFzAficKsjvkP/mQcKA6zbxh/g/cMVkmYzTesh9V6TkqYXa6fArX6J/BH3WBpmO2mK4G3tS1lYXa8dius1MTLw+wSzTSo0DyDe9VDFGG2o/o0vKxKVYbZt1Tz4V3lBdhXGYI/K5JVWFmhhfPlJlguY2GOLBUWS0mRlCIFKWZYJqE52RIGFomNkBMzX2SApclkVsy1SXoYTtTBvERavySBZGMWCkmnQANzBWp4NJ7Gypiz+eQjnhL25EnhnjgJTIhTwE+5tPIdDu2hfcytUVqtKSKD4yI081IzjW3NKri6iVYLNZIjYv7WQE80NtB4UT3d+7KO7B/zUC0praWdT6+hd3lQTXaN+X2YrvLDtP5HVRHk8Fblfdipci08FGoPXw3dQM5PBcfDAcEwavFvYBmcFFDBiH8v6rXO3wmm+a+jjsd878PevgDqe9+7CH7klcF6zx70wNeejtDguYreOOzOgz3dLvTMX655MN8lgdXOneioL50todn5IzrtssMMlzi+Sgyz7zl8CWF2oGMo7OM4IUR9HbqYCwQUeRaPfnD0gf0cB/ikmE+RqTzyfhwy4+gMBzl2cMPsYAcXjnZ8zEEPOx5Fw+w5x7tQ7ayIhNl5zukQRzsc6drUHGYvuKzwVfeJpjC73d0PJnr+bUSVPZOg3dPUgLp4v4EXvanwNd/x+jC7y9cXyvwP6lAj/yQY8Edqw+z7gTXwRoCFXYLHasLsgWBfqA/9Wx1mV4Q+gTWhxjAyU7kK3q00wZ5VR6vwlVX1gkz4XmWYXRn+ADaEa0Nh9uPqr0OxKsM+NQeDYfaXmtehufZmIMx+UzsWNtcG/WH2k7rF8J86OexTv8cXZo/Xd4RpDX96w+yGhnFQ0NjowdfU+B1saBwFC5vaQWNzC/hrswUOjzAwENHClVENzOTo4UUOC8dyM2Ajl2ZuiTPDdjyafzvmJL4JCuNp5u6YPQTkQwHFZwlpjiLBCH9KoDUHJeqgI+bSJNKcTJ5JpqujRGSViCJrxGQrCd17VUK7/V9Kf9pJymK4Svo3TJF1xTsukx2AYZkW7z5BvhzelYdhD8V4ZOYnxU3IKrsgb2uUxTCiVCOfn6kK4UNVGPZTf4BsH1ffh6wmB7VYrTkGGzUsavSJdjV8qK2Hg3QTUcEzujLYQv8G6rtVfxQKDCbUfYZhFXxpaITDjJPQFeeMj6GNGYGeWc3cg07mPfRSO9OTpLWpc0wTktemZpiewlJmpGht6gTmKqw1dhKvTf3auBcajHLJ2tQfDYtgV4Mf3tSPSVmbOlZ/A4Z0XaRrU5foDkClTiNbm7pPuwx20lbBq5rx8rWpeZrb0KXuplibOlf9IxSpNcq1qdtV82C66g78TilWrU2VKtvB2Yp+8LF8KOwlHwn3yt6GiTE/k1LkTsoI2D7mVslw2CQeBseK6a6LordgZsyVyaQ/6U04LGkIPJk4GOpiLkigyDMh2UdIkWJBLhTFLIgny/hkJ/5AuJ3XF0bj3oD/i8uBV7iDYEsuPeUbDu2hMkrjt6M0/1SkN2RiLm6m96poovkDmmjNQ42kNOb0BvKfetrD6/W0n+/qSF4dRSbWkn/WUOTVGnqX9dX0lOowjUeHac2zVT1galUq/KrSgazWhtbBGaEsGAn+gcyvDg6DTPAlKvJTYAbsFYiHZf7NqNdEvw3W+s6gml/6BkOt7wmqTP/DGtX3cuFNzwb0wPseCwy6T6BDlrj7QqX7H3TOPtcnsKOrCR111bkajnbqYMjxLfpts0MMhztmJq5NzXL8l7A21ejoDtWOXUJSEPNjwdpUjeNmPJ7uaAt1jk18so5H8fdi/hG3NlXvsMTRCl9y8UYODwcVdwyDfRzno2tTv3C8Dm85/vJgP40L4enG7rB/kx6WN0nh/GYx1EaE8HiEC9+KRtxrU33RKFzBiUfEyk2G57k0c0xcAmyIo/hmHh++xidv8WmFSfF0VSggdwso0kNIMx8Jac7shDioTOTAn2MOTiJdSfTcZclkmog8F/MdMV2tEdN4g4RWa51CO/8z5Q04XloI/dIncLKsr3dt6gvZMThcnurDbuVrYBtFM/xe8bGfvqy/4SJlTgBVU/4Mx6rYIKqpWgNfV3NCa1P3qwugUlMOF2verFybGtCche9rW1bhHbWbYQ8dL4zO0RVAs/4pXK0fUr02tVFfAj8xtKxZm/qvYSvsbxTW4lszzoLpjAt+w4ytQ8cyD+EIU7+krLRW5pvwP1NuclbaQtMlaDBli7LSfmGKYV9GI85Ke2BcBj82VsEGw3hJVtpKw23IGLqlZKUd0R+CPfV6aVbaXd1XcIKuBlZp82VZacu0f0G1toc8K22f5jDspDEostKuqb+G76rroVf1P2VW2lzVRRhVSlVZabOUOfClYgIcpPgcHpXPgUr5fDhbRj6Skj2l8+DulLlQGHOShLwtpvntxLPgFtFM2JA8A74f80LSdJiRRCt/nUj6E6bBYQl09YSQ1AlpzgIBxZ/F05w+MQ/wp0IRfwos4H0Cy+I+gtlxn8IiLs3hcOm5+ZzZsDRK62RFP4NrIzQz3PwxHNU8GZ5pKoDmJlpzaSPd62igJw6K+VM93Suvp/3MrKPxf7U0p3vMXTU0R1BDVz+pJm+GaU7bMK25qYqy11DZHU6obERu74e+g6NCHeGL4DVkfnrwPRgf9KEumwMLYIuAGJb4v0PVhvjbwqe+S6jmFN8oyPE5Uet13jkw3ZsMT3h2oBP6el6F/7rPoUMmud+EEdcz9M83rhnQ5EqAR5zb0F09nRnwH8dBdN1sBwtbO1YmZqXxHMGErLSAfQR02n8TIg92Y8xFAoq8iM9Kc9n7Qbf9Rz6Zwqf4NB75T1xWmsf+OvTZd3LJOBi0f8hBR9lvR7PSLI7XPFlpxY1C2L2pyo3dNgXhjGY/lEWc8HDkORwQfQoros/gYo4dMlwvPMWlmSPj3DAUR/FveBWwJZ/GV/gOOCHeBSMxvxXQmh2FFL8npJlTEl7C5ER6yv5EWr93Evk0iSLzk0mtiDwuovhbYtIb8ysJrWBJCcE/UkR4i3ek3aFf+iWcJauAYdkQb1bah/IS+I+8pQ91UWyBJxR8f1aaVTkVblQ+hXxVy2BW2pvqb2GJOjGEumvmwC0aJ4zXvl2ZlTZNewm+0HI4pWnd2CLYlc3mlqZ1ZstgB3ZqXGnaa6yYRx6A7dg+fIo/gx3ZL+JJvYAiJ2MOE9IcP3yF/TqhNM3EpieWpnHYk/CWuVdSadpy8wX4qrlrcmnaDdNRmG9KFZWm1TFr4ddMBBqYSeLStEPGf2E3Y38J7jWchOMM1pTStEr9BrhUz5WWpin1k+Fe3SPYQTdAVpp2RfsrHKW1ykvTnJoNcI6GqyhNS9IUwCL1U/iqOldZmva76hc4QJWoKk27quwPs5VT4A+KZVCoWAsnyTfB27LN8LWYm6UUaUjZCN+PeUFCZsRcId4AfaJ1cKiIVjiRvAbqYs5PWg3LE1fBnEQaFydQXBSzQEjeE3wDOwno6vZ4mhnlr4T/438Nr/C+hC15S+E3cWQldwV8m0v3nuashyYOPX1JlO6tiNC7DIgsgYebl0NZM60zo4nW/LeR5nRrpGd930DP5TfQOh/V085v1NG4TR3FN9bSzNoa8t0aivxeTVfTY34ZphXcVbT+kKoCeLyyJ2QrQ8jwttBqmBpKg0eDx5H/nsG+8K/A36hOfuBDWOevRdW+9q+ARr8BHvYdQU27+XrBm96/UPH3vfkw6KlGJyzxLIdKjwbud+9Hn3Rxd4bXXTfQP++6xkG3sxLdNc+5FIqdUrjbsRG918eRCCP2aejJ+/YH6NIL9q6wxP49+vaMnRfzQwFFrqPDz9lbx9zAJ2vwFZy1v8Oj8Tl8HeftafCifTmXxm58QX/Yh8BS+7FoadpTuxHGO/5yl6btbDwLs5tOwLKmk3BqMymO/AwPRH6EfaLF8Fn0AFzAOQJ13OPwBJdmDos7Bv1xP8GveXQ1g09e4B+F78fTOo3xNN4ioDnthORtIc2ZlHAYChPpKXti9kw6CB/FnJ1MKkXkzyJ6+mAx6Yq5THIIpqbQzs+mXIN5Uh8MSjM8pWmLZYUNpWkK1txYmmZjz8A27KgmOjGqYFt2TTONsyJ0PpRG6GzJj9I5w+Hkp2/EmZOfvh5nTn76Gpw5+ekrcebkp3+FM4c8AFfgzMlP/xpnDl1dEE9jvYA8KaA5w4T56ctw5uSnL2BXJOSnf8qmJuanD2CPQTn7elJ++mXzKfixuU1yfjrfvAtuM8lE+emtTF/AEsYLc5nR4vz0x8arcLKxgyQ/PWrYA9cZFCn56emGxfCEPgD76t+T5qf/rbsGP9B1lOWn12h3wy+1cnl+ula7CB7U+OHrmvcU+ek31Nfh++ouyvz0oGo3XKDiqvLTOar+cIZyDnym2Az7KfbBQ/KfoFR+DE6XHYcPpGRXKUW+TyF5MT+UkNfFv8DW4qNwg4jurU0+At9JPgzPJR2CaUkH4fLEH6E7gSJDEmjOz0JSJaSZcwQUfxxPc3rF0/w9fDKBfwB+ytsL78Tthu3j9sOtXLqriUNPHxfzYpSenhkthisjNDPQTHcNb6YVfm2ilQ1N9JSFjXTv8wZ6et8GuutgPe1fEvPzOorcr6U5nWPuqKGZ3BqKf1BNXgvTOllh2snaKspedeVU+H5lFvwrdAd5HhH6EJYHG5D/qcFVMC7IwI2Bw6hOZqAbPO2/jdrl+sfBx74q1HSybzmMeLXwG+9BVJz1vg5/8dxAP+R4xsC/3T70ycfuL2CTSwZXufaiiwyubPij8zp6rKvzXXjL4UDvTXR8CMWOB+jJW/ae8JB9L3p1pz0BbrN/KiTvoJ+/tbeHRfat6PMd9iY+OZZPkYs8MpNHd63EN/KDPcAlh3MpcpJDV/XwO/vCKK3/MoKK2HPhS3uoCpk0vB/OTy823IBaY5dqdKyxGNYY1TXIKlMI7zFV8A3ThNr89COmm3V4U/Oo+vx0E+uGQ9nChvz0Anzp+emL8KWjo/ClYx186eSaZvoesyL0nZZG6IvOj9LXzeFwLOX40jmWJ/jSOZaH+NI5ln/YgjiOpYwV8TiWe2wxj8Y5fI7lPlvOp/H8eI7lL1Yr4FjusMfhDfYtIcdymfXC39jlCRzLDyyTyLHMYQ/BruxrSRyL13wEfmNOT+ZYMs0b4RlTnIhjGWyaAh8zj+BnzAAxx9JsPAm/MVolHAtr3Ah/MfBSOJYcw1T4t/4p/FA/SMqx1Op+g1/qLDKORa1bD/drOXKOpbN2CryueQTf0wxUcCw+9Sm4UG1Tcixy9Ub4g6oW2lQDVBzLHuVyqFIehV8orsMK+UM4QP4CHpE5oFzmhDOl5H8pZLcUF/xBQsZLKPKx2A5viipgW9FLuCmZVqhPeg7HJD2D5xNJayJFViTQVZ+QHCqkyAkBXdXFXBBPPuPT1T58WvMAjxTzaObUOIrf59LTO3MDcAcnBLkcGn8Qpfi1CM15JULz1zXT3qqbaJ+jm+jq2UYytdENlzV4oKveCwfX++DPdaSqjiJzaunqoxqyZ8w91XRXQjWt+Wn4CbxbdRN2rDoId1ZOhpJKDVwV+hl5Vof6wH3BB6hCx+AnsDTQiOq8E1gJfX4jXOg/ggrK/D3hLt9fqGw73wfwkrcWFR/p/Qo6PDo4x/MjuiLZ0xXudN9At7Rxvw8vuCrRRcNcy+Azpw5+7jyITuM5u8AtjovowNccPWC5/TA686BdAdfYZ6Fjl9kfonuX2HvE3I2uXmoXCig+Cd2+3H6bT+N2MbfwyEZ8I1/Zx8KV9ov4ar62Z3Jp5koOrRCI0grDoxT/LcKxbLYzsNi+tBn7tO9wcyxVsiCcJR/u4VgC8j/gOMWrXo7llmI77K4U+jiWn5TToEn1HK5SDfOjl1QX4ER1mwC+RPUOmKNJCnIsxzWzYLq2Aq7XjghxLBzdRThZ91olvmvd93CgXlKFL1Q/H9oMTrjF8HaYYxEaL8KZxjbVHIvduBOOZEQ1yDwzB7YzOeEPprxa9J75Bpxp7luHU8J8DWaxb9fjKawHbmeXNXAsv7JsI50GJfAmm9fEsdxmw010VqxtpvMkC3n4G6cQnTb5UTp5OJwiS//UItgvNZtbZMlJLYM9UwviiizdUpN5RZbXU/fH7M0vsnROfQo7pM6LL7K8mqoRFFmsqb9AfepgYZElKdUBq9hFCUWWu6wyscjyPfs9HMOmJxVZEtmdsNgsT8b65iWwzBSCE01jREWWGuYaXM50FBdZ1MweuN8ol+CJxsXwuiEI3ze8n1JkCepvwMX6ztIii0y/F/6gk8mKLG10X8DzWi8crn1XXmSp0JTCmZqOiiKLULMXblMrlUWWLPUSeE7lgQPxe6PIclO5CfZV/gVPKpphqoKnxgqVpRiPrJwJ74aUMC90AHfZg13hrOAtrJkQHE8rByrxrFaBpfCcXwnf8u/DTp75suE033Xsk+8bAzd5/di/zbsQnvbIYK5nF97uibs9LHBfxrvHufPgBpcHOUl3LYTHnDKY49yNjP3taAsnOX5DPpMcbeBZexHy/I09Ds6yT0T+J9v/RC0m2V+NuR41+sxeG0/xd+EU++98GqfH/JJHEQ8q/rn9TTjdfoxLYw2Xrs5Db3xiL4+SOVFapzhCc0TwC/vU5iJ8ZX83FVl22itdRZZsWWd3keWibBXsJ/fCC/JRniJLO8UV+IOivbfIkqL8Hi5SJvuKLCHlHDhO5YI3VKP9WEFdCveqOwaKLErNLrhMIwkWWao18+AHWhe8p80LFVl66a7CI7qOlUUWg34vXKFXVBVZ6vSL4IcGL/zHMDqMnRivwJPG9tXoWOYHuIlJqUFFTPPh5yYPLDe9W4tamG/D4+aBdXg6ewt+yL5bX2Q5wAbhv+xXDUWWBjatEb2XehaaU0fj3VukVsPWqeuQjY6pWchM19RS2Ds1P0pf1iNhtvWN1IKEbKs0NQr/Yr9MzLYuZ4VJ2dZX2EXwT3MYTjDnJ2dba0z34FemnqJsq9Z0CBYzWnG2NZtZDkuNYfiOcYIk2+o1/AUXGnqmZFtlhiNwl94gzba2038JL+jCcJhunCzb+lx7C07TdpNnW+O1P8ItGp0i22rTfAlPq2vhYPVEZba1XHUPFqi6qLKtjcqtcKHSBesVrdTZ1k8VtRhnVm6Bh0Kvws6h85h/LTgcvhO0Yx1PYA6cF0iG4kARnvWd/1XY1v879nDBNxSO8L3A3iq8M+AsbzxM8m7G/nd4MmFrz2m81x/uXDjU/QTv+9w1FU5z8SDftRk52eS0wQznKeTqlKMfHOK4iRz67H3gD/afkeGpdg3Ms89Dzt+0P0UVcu05MYsFeF+7CA6xF8TT1TI+jbP5FC/i0ZgDh9rz47Ktw+2lXGTSnsWl+FpOtnWgPRzNtva358FB9pIIrcDCkfbCZuTB7mzKto61D4aT7Ywr22oQmOCvMYcLyUDMlQlkZiJ5MZFmjk0iG5OMcEsyfjtb24n08LZIByeJSaGE4rslqbBHSjv4X8ooOFW6FsbJHtHKsnbubKtIvhEulzfDevmnnmzrRMVjeE8x0IueVJ6Ax5SpvmyrRbUWrldx/NnWiGoq/ERdDv9R5wayrf00v8HfNJZgtrWFdh3cquWEsq0C3RQ4TfcUluuGVCI/+hJYom9ZlW1tZdgCtxt44WxrsrEAzjU+hm7joOps62jmN1jKZNRkWzuZNsJ9prjabKvSPA0uMjug0zyhDnlmX8Kd7OT6bKuDjcD01N4JZdbpqX/CzNTcxDJ8U9fgdLZnUplVyh6HxWZLcpm1q3kDvG3iiMqsY02fwSDzL1zI9BFjJnMM/mBMlZRZ2xnXwiuGKMwzTE4ps7r1D+E8fT9pmVWkPwa361hZmbWVbjUs0TbCIdqP5WXWcs0/cKqmj6LMytMch5vUFmWZtYV6AzyLv20xUzUJPlTegv9TZqrLrC8VU+G7imJ4TX4dtpU/hltkdtgodcGxUg+8lELaUtxwlYQMiunqCLETnhI5ICOiuxYnV8CKpJdwYMwjiaQ85swE8j8h2SPmbgHdKxSMgb0r67G3G6Fv4LshM/QFf8b+FwZzYAp+Q5ZZvwtMgq0DzXjf8/41cLg/FVb4jiEbs3w5MNH3N3L1rfdD+Ap+Q2Km50s4Er8hy6x292FkeJa7JxS67yH/W10fwBauWtTljHMFHOzUw6eOH1G7aY5OMNlxCjX9yf4K/MS+BbXuZW9G9V+xj4dW+xVhmTXd3jLmN4Iyq8VeGU/xt2Oe4VPEzKerS3k0dsShc+y5sIX9KJfGSi5dnc0ps5rtj6NlVpO9F2TteyO0QmKEZk5uRvXtfzWRHWEb+/ZG2gkPjrWvcSKfvP2wG/8S/Jv/HyyIr4AigRPuF7hgbyH5NOa8BFKTSP6SSHOGJDmgO8kOlyfTvamil/Cs6AUcLSarxRRZJ3HDrJQGeDXF6KJueRsGpHvgTBnHXWatkuXDSfJb8LG8m6fMOkhxBJ5UMF7kQfkV3KisggLVOF+ZdYbqDnym6uUvs+aqf4an1KYAek+zAm7TVMMk7YRgmXWO9g50anuEUFndEXhBx1SiN/Sr4A59PUw2TKzCOxruQbehZ7gM/3IdhteM+uoy/Iv2JdzPVEO1aUJNmXWZ6Q4Mm3rUllnHm4/CG2ZLXZm1PbsDbmaN9WXWEPsdzEn9IqEgY19qPeybOjWxIOMF64AL2NFJBRkK9k+439w5uSCji3kfvG5SiAoy3jMtgl7GC+czo8UFGSLmKtxp7CApyGhj3AMvGBQpBRkjDYuhQx+As/XvSgsyEvRX4VZde1lBhk33AzyllcoLMgZpv4CPNR44WTNaUZDB0VyDG9SdlQUZmeqD8IxKqyrIGKIqhI+VHviRcqC6IMOn2A4/UvwDH8ibYC+5VIOdy3QwWcbAKVIzvJdCZscskpggR0JX88VGWCoywFdEergume6tTtLC0THPJmpgaszlCRRxC8khQpr5i4DWUQtawnnxA+EL/hy6yj8Iz/DawEDlHexteuVHMBpqwv7XhFbDtBADTwR/wjv2wylRkPF34AHefSJOiYKMWn8TcrLC/w00+Fl4yPcL8tYdp0RBxh3v38jnBO9EWO2pRp6/9iyDjEcLj7gPoRbd3T3gLddfqNFYVz4MOatRu6XO5VDt1MADDqpvN8dr8G/7L6j7fHsG7Gxfg36Q26vRIdGK0bCu4qywIKOmIjXmMgF2WOGOJ4fE/IVPqvl0dS6Pxk/jCjIaKnrDpor93IKM+opkGK6YwsFOKsqiBRnBimxYVVEUofkc2FjxQTN5rYnufaWJxusaCzJ49tqGggyVfSzsZM9yFmSMqs+AVfUWuKaBbNWYDq/GnNBEVyNNLeC3zZmwYyQV3o0Y4WdRA0zkMHAvJw324tLMR9zWcHZcNlTwhsAjvGmwD78IPuSfgdPj/4QpgtvwR8Ed2Fd4Fz6P+UUCqU+k+MmYQ5Nopi/pFlyRfBNaRdfheRGtM0ZM1okpslFC97ZJeQavp8S5CjL+J+0Kq6Qr4RyZE9bKBrnR1fIT8Jk83VOQ8aZiIzyj4HnxZSmnwG3K/2CSqp8Pd6l+hXZVph87UW+B59T8ALpdUwB3ah5BibZ/EDvX/gq9WmuoIOMd3SZ4VcevLMhor/8c7tKXQ6lhcFVBxiLDaRgwZIbRV8aN8JYxrhpdxEyBPzKPod40sAbva/oV1pmstehq8yZYZo6vK8jowc6BxWwAilM/qscbpb6Et1IHCkWZkbTzcFtaxwRR5mtpB+H1VCZRlDkhdQ2sYzlJosxVbAFk2afwF3Nusigzx3wKlpkyRKLMD0zrYTUThcuYT8WiTDXzHyw2DpCIMrsYf4M3DZkposxxhk2wUh8nFWUu1U+BCv1DuFvXXybKbK87CS9rLXJR5ijtOujUROFczWSFKFOkeQK/V7+pFGV2UP8Or6laq0SZ76m2Q6+SpxZlzlHmw4jiBJyrCEG3XKURZQ6Xt4C/yV6DjKwDXCztBCtSyIExj0hIuaQjnCmmOQ9F7WAPEd21O7ktFMb8NKkNvJPYGraPuTWBbBZSfLyQ5lwW0AotBTlwTfxEWMsvgh/w/4X3eSlaUWZvXjd4JG4C1MQthF9wP4Nnwl2hLRzGzJ1V30JzFe1qf+VNvFGHynHwciiEt84LLaZ3D8rhwuBe5EQa7AK/C9xCrl4NjIV/+EPI4XD/UvjSp4IzffuQ5wRfZ/it9zry38r7DvzD40J1RnrmQodbDGe7d6F2QncHuNV1FTVt4RoNS5wu1PpN51z43JEEZzi+RT8kOixwt30v+mSgXQOT7IvRRS8q7OiruxUDqbsqfkK/XatQxJwlIB/Gkz1j7uGTCbC04lOeKPPPirtx6J+KDvBWxTYurdDMEWVeqZgAL1ZciYoyL1S0hJcr1kRoflUzzR8V80wTzWebKF7YSCu4GkSZDyqGQH/Fb/WiTK29ySHK7F7nhg/qXsDp9c+htOEZPBSzX2M5fNFI44VNL6Gh2Q5PNtP8YZHH0B/5F66IPoBWzkN4nkPz3+PSynXcMNwQJ3SiLrxW8DJvDBzNXwO9/F9gYfwFaBZchacFpfBt4TVYGfObBLJFIsUvxxyfRDObk67ArcmXYXvRRXhHROt8Kj4PhRKK7JbQvT1SHsD/Uurg59LWLlEmXzYHrpbdhhL5q25R5tf4K0yUyVFwPKLMAsUU+Bh/haGayoFe7Ep5ErZSpfvQOar1UKiO84syp6mnwnL1E/imZlBAlPm75lfYWmsJooe166FIxw3hq9QVQAf+CkOn6QdXooL6M7CtwVaFr9uwCaYYeWF8C/grTJTpMz6B7zGDqlFB5hTsbMqowdli2gA1Zm6tKHO5eQoMm5/A8ezgOlSZPQc7p7ZFfXencjjFmQ5rEXRbs7nFmS7rPfjSOiWuOPOxNYlXnHnXuheetr7OL85cb/0TjrQOjS/OFFpvw0OWfoLizP6WElie/qqwOHNm+k6YlC5JKM7cmfYFbJvmg5dS30sszhyVeh262deTijPnswdgCqtJLs783lwI25iD8A/Te6LizLdM1+AzpqO4OPNzZg/kMQpJceYm4xJoM4bgacO4lOLMwYab8Im+i7Q4c4q+GHL0Kllx5jrdUpimC8Jj2vflxZk52uvwvqazojjzQ80B2Kg2KIsz16pXQau6GZ7C33fFmYNU/8D/lF3VxZn5ys2wQvEYvqMQa4ozr8ht8BV5R7he1hXWSLvDd6Q94LkUMi3mlxLSI6arb4q7wWOi16FG1AXOS+4My5OyYU5SJ1icSIpiFiSQZUK6mi2k+TsEPSFXMBJ+GL8I3uWfhW/wo/AEr6sWb8GbBjfE7YZRbin8iPsI3uS8hK9xKuDm6HPYEHkM3488hBeaaZzZ/BSubCIDjRQZHvPXBooYYi6qL4cv657B/jEP1ZLSmNNraP6/1Xdht+qf4d7wbKgMZ8C1VZexT3XVGLirMoR8vla5FF4MKeHI0F7k3BXsAOcHr6IW4uB7sCgQRKWyAovhOb8cDvXvQR2f+zrC6b5S1Ffgewdu8XpRfZt3ASzxiOBbniL0xgt3azjdfRE9w3e/TV3kcqKjMl1z4ClnIsx1fot+e+poBT93nEEfxjsGwCL7TXRpN3sfWFlxFN17oUINf6yYh67eVfEU3f5dRW+4s2K/gEyOWRBP8TI+mc2nSBGPxhwe3ZWP72t3xTUujV+BOyrW4RvcVlEdLc7cWjE6SuNzEborLUJzljfTfHdTceYPFUOaaJ1fGvHVVGgaKT6voTjzcMWzemSyIheGKi7UFWd2tufAjXaREx1VW+bAU2pPwo51P8K7dcXws3oysYHcG7NX4374uJHGs5toprL5EDzafBDmRvZAZ+R7uDT6HTRzdsEzHJo5ivsrrOReg6vjXsIMngxPP8MbBHP5hfAx/xCcFv87lAguw4OCK7Cv8Cp8FnNBAqlLJE8k0tWhSTTTl3QJrki+CC2i8/AP0R/wPTGtViem8UYJzWyTcgdeT3HCD6RSF7506UC4SrYOauTPYZH8T+T2ivUDZPuRlcPJsXXMKIKdM7K5ObZOGWWwXUZBXI4tK0PEy7GZM/ZBYUY3fo7tifUG/A4nYY7tTestGLL0EeTYVlp+hakWmzDHdiJ9C+yXHp+QY3uQ9jn8OK0cNqQOScTM1LOQSc1KyrH9xG6HvdiE5BzbX+YZcIL5GQyZhohybItNZ6DM1EKcY9vFbIHtGYEkx3bFOAPmGV9Ct2F4So5tvuEClBhaS7E3/Q7YWp8sy7H9oZsDh+kc8IV2hDzHNl17AfK1bRQ5tk2a72ELjVyZYzunLoTD1dXQqfpAlWObq7oLk1Sd1Dm2jcoNUK18BFfhJMyx1eHXY47tfXkneFHWDWbKesKV0l7Qn0IOi3lSQuoldPULcQ/4XETz+4i6wgPJr0Nxchc4NakzvJ9Ido5ZlEByEuhqvpBmlgponSzBW3Bd/AxYzz8KP+aH4SNeJy3qwpsFz8cdh23jXHAnV6zLsQm4ZjiJY4G3o2mwXdQEt0QMsLHZCMc205yLTSzMaKKrXzcy0N9A42ENdPVkPV3V16fCBXXks1qyTy3FD9TQTHGNEk6tbsLT/wlfgznhufBslR6+UfUzdnursg/lsPIBsuoPfQIXhhqRc1loFdwdZGCH4FFU5HKgNxwZuI96OfwfwLn+GtRR5P8K7vTpYGvfj1Rxb3c41HsHPfDcMw7O8ITQGwmeJfBbtxK2dO9D55xxZcPBrlL0VblzNPzc6Ua/xTvnwc0OMbQ5dqAbz9gz4Qj7fvRqU4UOnq5Ygh7eVOFAVy/DL1jsvOIIev6LCjlcUDET38L8iv/iadw9nuI/8Mn4mB/zaP5NfF9LKtrG3MSlSD2+wbkVY+Csij+ipCVKka8idJe3mWa+FfN4U45tUYW2ieLzGunepw34Xip6w68qiutzbNsr5PBKxfI69LBdAPPta2tzbH/aWdjR8XNNjm2PozdUOP+uzrEtdX4EK52N4RzbeNcqeMdlgt3dR6tybIfdvaHRc78SHe75ANZ5qkM5tg+8y+E9rw729v0YzLH94usKWf/NQI7tG/9Y2OQP+nNsnwSWwH8DStg/uM+XY/s12AlaQ1e9Obb1odGQW+nzoGcqF8LyShkcUvWDO8dWUvUabBm+5MqxbQ2/DYXVDicqWz0f2qt1cGxNqSPH9rJmPZxVOxNK6z6Fh+omwf715Mt6iixuIJlGipyKObLpMxhqmgJXN0+GLSIfwyuRfDgh+j8YiX4Iv+V8Djtyl8O73B/gJ3GXYRyvBm7htcdOMvifwxP8XXBA/Bn4Iv4SXIjTPsdmwDmfY/st5ogEMhhzVSJdteG0z7FdSqL543Ha59iaky/AbTjt8S3gtMdzY34mOQ+TUujefSllsJfUCx/izM+xTZN1h4lyPrplv3Ur/NfaGl3EybgGjRn56KtXMjiccls/nPzltv44+cttfXDyl9t6ZUyJK7d1yUjmldtaZ+yFuoyu/HJbCCd/ue2kdXh8ue0j610osvYXlNuKLWdgD0srYbntXvq38IP0hIRyW03aDPhl2nOoTXsrsdx2IPUcfD31laRy202c/OW2sWxicrktiJO/3LYIJ3+5TWoeIiq3fY+Tv9zWFid/ue0CTv5y2wgmXlJusxunw9nGFzDZOCyl3LbD8AdsbXhFWm77Q78dDtUnysptz3Wz4HRdBRTohsvLbVu0v8NM7SuKcttvmh0wVyNRltueqRfDWepKKFKPV5XbvlPdgq1VHdTlttPKdbCr8j94TCHSlNvMihZwOU7+cpsHJ3+57U2c/LiKk7/cpok5P+UNWC6hcU7MYjHNEeH3cLmtQER3lSV3hdk4/8ttRUldIBfnP7KXSF5LIF9JoPg6Ic2pFtC9owUD4Ln4j6A1fgfcwH8GBfwMbbltHm/S/zm47+goqjYM4LvJpve+m7bJ7gaSbdmgNEU6SieICkgE6aEpoghIBGkSegsdBGmKUiX0FjryBekgTUK2957sZtv3vPPP78y5c+fOnbnvnYf15AitYcfhuLAm+C+7lIdVZg+BR1ljYTprApwTouPXwVGwW3Ak3B/4EsYEqH2an3zgGwPb+UbDbS10HPSOg2MYb3rGQzHj6mZqcTRRn6FNFfC8ux8scBfBZa63mEnAuRTOcxbAGGct5rzV8REscdC7PWefBvvaWfClbT3e/zSbEAatp7Aua629YaH1X6xaraUS9rZ4sZovzCvgVHMeDJqOYa3XmHpAvukpKuGYcSLsZvSiQh4blsMJhlzo0R9G/SzXfwDz9P+guo7pRsEeOjuq7ol2ERyvzYRNmgOoyeUaOWyl+RMV+1CdAzerF6GSZ+H731A8Wd0fTlAfo8pXp8Nx6tmR5KsIsmsEte/jUJ9oDh1Pw56aqH6AXTZJ3TaMRtjKppYAduIY9Wg4Sn0j1FA8Ui2Go9Wrg3StI0A9P2M856f++X5qX+gjtS3U0q+Fzh71NhTPVGfC9erFnobi2+pgc0NxpmYhnKlJgm80u5tQ/9o28Jz2uhuroBsKt+j0robiKP1cOFOfAFX6Xc6G4o8NbeAVw3VHQ7HC+CncaVTbG4pjTbPgbFMs1Jp22hqKPzPL4XXzZWtDcRvLYPirRWlpKE6yzoQ/WqOg0brV3FD8uU0Mb9vOmxqK29r7wz32N8aG4hTHDLjAwYE2x0ZDQ/EXzlbwf84z+obijq6+8DfXS11DcYb7K7jYHQE97oNazLlpLGQ1d4SbmotgmacA1nv4sNJLx5wWcjdjJx+1/8v4nb8QJgeE8FCAjj8K5kJlkAfnh8gcFp09xaLxB7MroJ5dDeeFnYOp4S64N7wd5qPgzISXOPvgkIgL0IQUaCiuRgo0FIvw/cf3irEimvQw1sTQ2VKkAJ43lvpPRAo0FIfj3/z4LiEF8P3E97+h+Bnjt4nUkphEff5IugM/TH4G3yYbYFVKON5VZqoIHkmdgGq5XOSH+qIaVFFsKznqSohEwPtHItCXn8WqKpEiEcgO7KoSMRKhqqQIvwWqSvj4LVBVktHqNxjeqiunquRt0UP4Z1FFRFXJmKL/YFzR0MiqkoOiethd1DmqquSZ8AicLMyNrirxC1bAVQIPzBdMjKkqOVr4BHYr7BlbVfKo4C84rqAgrqrEzV8Fl/C9MIM/Ib6qZH/+Y9guv3tCVcmtvGNwWB4/sarEkLsaVuUGYGLu1KSqkt05L2CbnN7JVSXXsk/CIdmilKoSNW8DnMVjp1aVRPO+glu5L2EJt09aVcm5rLNwYJYkvaqkMXMnnJ2ZlFFVkpA5D+7KMEB5xqDMqpLT6b/BdukGeDAtM6uqJD1NDuekdoT/pXSG3ZEImDOyoKokhnEaEqGq5EEiHbdl3IrfAngn8dT/SyRCVcl1JEJVSTESoapkJRKhqsQWQ2MOYTwdTeZEU/v8KOqjjKRrP4rsD/+MmAbTIvbDBRwDdIcruFUlk8JnwzdhN+HQsEwe5sAeCT9ir4UnWH9CHusEnBf6C74NHoG9gofgwcBRmBCg9m/85BPfcdiBcUcLyWqh9nFeGuG2pxZKPXS8ppnanU3H4NCmg/C8exMscE+Dy11iGHD+g1nNd46HcU4P5rzDsRzKHHnwov0Y3vAAew/42vYU73+arRIGrS1YnbXWFVBgzYEnLX9i7Xpb3ocvzfVY02nmkTBksmHF15oWQb4pCx41HkQ9dDW+Dx8Y7qJOxhq+gG69GfVTrf8R5uoT4FHdL6ixbjoFfKi9htobox0KHRotanKxZgbM19hRsTfVY+ESdT0qeZS6DA5Sb0SF91V7UPl91BWwt7oOO+IjtYixOoJaTBw6O4jxRDiZBfur52KvDVC/YdNxDzb1/w37sYc6FnZTfxWi44dBam8H+6m3Bah/0E/9x/hpnBs+soRxVQtp91KfT+Fw9QUPalstgcfU+5uxghoJHK0501RV8j9Nb9hB+9xdVXJAOwVm6AIuPK9uLXTqCuEY/QlnVcl9fS/YxfDMUVVyxFAJc41eO1bWuBx6jHlwoumorarkqakb7GV+aEW9mcdBgaXJUlWyzlINQxYenGb9w4y1s3aCfW13TVUlZ2wjYZHdaqwq2WBfAMMcafAbx35DVUmDox0c6Lylryq54BwOxS6Drqpki2sujHInwu/dB7RVJUZ3fzi56aoGz8J6AI+znLAPuxjtr9gT4JSwfbAlTAWXhRfj2kzOZLiXsxO2izgL70dcg1Px9cbXI4rch683aimafMU4O4baM/D1xl3w9cY7j6Or9Pg3PCoEX++qkkJ8t6tKLjF+nkg2JVL7+iTqKU++De8k34MTUp7DsFQt/CXVDzum5eJJH6RtxZqOK5JgfbcXXYU3ikZg3VVFbthStBb1ENdKitrgtboNhfi24yuHbztX7CzaAR1FHdhcsa3oMTQVTQ/jirVFceFc8Zui3+DDoq4crvhM0VO4omhcBFfcr0gPfaKJkVzxL6L/4HuiwVFc8QPhVThe2CaaK/YIdsPlgsQYrjhX8CM8UmiEXQqHx6JnwS04tqBtHFfs4u+Bi/lJ8VxxBr8K7s/Xw3b5QxO44lt5N+DwvHcSuWJj7h74Y25KElecnPsT3JNjge/kjEjmiq9n/w0/zW6fgvnzDsA5vPRUrjiOtwDu4FqglFuRxhVfzKqH5VkfpHPFmsyjcG5mQQbGzFwD92S0wLKMkZlc8dn0E7BduhP+npaTxRWnpingrNT34Ct827nirvi2c8X78FXniqMZp+LbzhXfT6Tjdxm34NvOFdO3nSumbztmi287V0zfdq6Yvu14//iqc8WfMJ6NJvOiqX1BFPVRR9K1ffBtx5vEtx3vKmIfXMzRQQ++7VzxtPA5UBVWD0eFteJxxQ3sKjiSfRU+YtlhZ1ZENmYbioXRoSg4NUgt9wOR8N1ADNzip7N+Hx1/yXijhVpKGFd546DdQ37KeLaZ2vOao+GCpjCodtO9+rrvwhOu1VDkag/3Oh9gbnLnWHjZ4cLMBzt+ho12HvzWfhjvOdzeDW6wPcYqCG0TYK3VgzX60FoNn1u4cJrld6wg29IBbjDfwcoWmSvgaZMV6/4RvvBc8TNjJpyILzxX3Gx4Hy4z1KNacg0V8KjehFrqrq+CT3UJcBK+8KhqbRu4QnsTFZitHQ7/0OhRn50138AXagvqdql6JOyvvoF6FqvFME+9GtXOUztQ/1z1Z4znsC+y1PxIOl4UQWo51Kcf41HsrGx1GsxVz8KOy1e/ZNNxFzZdtRe7Mk0dBVPUU0J0fD9I7e8Gqc+WAPX3++n4Sz+Nc91HYxYzrmwhbV6uOAdfeLxD9TkPV9xRXQTHq7c3c8WH1XkwRvN7E1c8XdMevtTccnPFvbXD4Smt0YX3qZsHN+qSYbh+r5MrnqFvC9/qbzmwdwzD4SWDwY49ZZwLtxkTYbRptw27w9QGqk3XrKhn82fwmllv4YrbWH6Auy3xMNG604x9Z5VDvbXOxBUPsw2GN22NRuxo+3fwV3skTHZsMXDF8x1iaHac13PFI5z94W3nax32putruM/FgqnujVqueJG7DLa4X2u44nlNu2FC8zy4v3k67OqZCl8xzvaS6S3kMcb+vslQ55sCF/unwYLA1/BCgI6HBSdBZ3AiXBP6CkpY1fAG6xydZbNxXyV7IJwcthm6wl7Bn8IFmFscZzzcwtkGJRGn4fWIq3BU5A3oQ45wxZuRIHj2aPIe45QYao+KpT57kSD4fiJBUIdxdO33SBA8NbID3wTGvomXoCaRjhcm0dn8ZOp5Lpmu/SyFxnSk/A+uTn0ES9Ia4I00D80kPQ9vtSn9E1idMRDVskv0BJpFY1BFpUUuOL5oBaprbZEQlXa06BK8XjTcTxnhhi+L1qEyG4ukqFJd0W1oKRoXonxhsWrFe5A1teJfkTW14l3ImlrxdmRNrXhzUXx4rXh90e9wWVEPTq34+6KXcEjRtIhacV5RM3wsmhNZK54ncsI80aSoWvFp4Us4QNgvulbcIDgHZwiKY2rFHMFmuKkwIrZW3LrwO3i24C3sWzAorlb8kn8BTuWXxNeK/fmb4Kp8TkKtOD9/Bjya1wC75g1MrBU/zL0Ix+VKk2rFzTnb4bKcmORacXbO9/DPbBXslD0kpVb8D+8q/JKnSK0V27k74UJubFqtOJU7G+7L0sEOWZ+n14rvZtbDMZkfZNSKmzL+hNUZGZm14oyMmXB7+k06Tg/BxWmCrFqxKfVdODi1EzyZ0gXykDW14h+RMrXit0iZWnEvxoOJ1JKQSGe/SaCeT5A1teKOyJpa8c44GoGNrKkVj0fW1Ir/RsrUimWM66JJdxS1D4+iPhcjabTCyI/hzxFzoJVzEo7i+ODj8B7cWnGf8LXwapgBdg/ry6sV32YfhP3ZPniL1T67Vtye9RncFfoShodGwYnBL+D/AiNhaYDaN/jHwGbfaDiC8XILtQgZl3pJo4ccxHiimcxqpmvnNg2Db9y9YE93Hjzieom7F7gWwt3OHChxHsEMLzg6w0GOe/Te7KPhDLsL7zncvhRusGVDoe0wVqTW2gX2st7HSj2zfAmnWGxYwaD5J7jenAJF5r1Y5ZOmdvBD099Y/afGL+B4ow1V0WRYCJcaUqlaDHtQOYf178Cu+muoqMe6T+AEnQaV5tHOgdXaBJil/RXV+JumDeyouYQqva/uDmeoz6B6i9Ui6FEtR22/UVlR7U9VQ+Bj1ekoModxfiSpxH55ovqI8U8Omcg4A/vrmeopdtwL1XuMv7CpJQw+VE3A3rynuhNCPavk8IFqfZDu0hygnp/Dl6pL/lrxvyqBn9p/9tGYhhZyYAu1/OWls1mwUfWjp1bsU+mba8VS9Wg4W61uwr3U38AuGhb8Q7PWTU8tgD9ra12oQO1HcJzuhZPe0jTYQx9y1Ir/0q+DhQYhXGOotdeKA4YP4RTjvzbMzTgJ9jb5rLXiU6aVsMjMhzXm4xasr6UHnGF5YsZXwjIeDrA2mWrF563VsMSWDbfYDhlrxZH2D+B39nuGWrHSPhoOdjj1teI6x2Ioc6bDbc79ulpxtKsdnOm6pUVP1wj4ibtJg6p2/woHNI2Fr5o6w++a5TDJUwL/9BTDj7x0rGSc30ItOb7W8DTjED+1W/1SuCIgga2D1H4tKIKjQnTWF+oGN7JmwmL2VXiMzcMcysKmwZNhZ+AH4SF4O7wX5vkJZxFUcg7BORGXYToSB1chcbBbkTi1Yh3j4miyIIbaL8RQn2FInFqxi3EtEgerGX8F3kbuYKUSaDQWEqdWvIOxQxK1PGacnkx94lOo/++MPVNphIZUGrkq7R/ITf8PnkhvgQMyivCGGzPGwW8yf0GFqIW5qJxuot1wg0iCinopugDTiz5GjXUtMsDRRUtQe7OKClCNS4ouwFVFw/yUJi5Yg98+lC9SVPI25FGt+BfkEWUQi1Uu6Yo8Kpd0QR6VSzohj8olHYu+DiuXtMNvn3JJG/z2KZfIirpzyiUFRa9gVNGMiHLJSxErslyyU7QUDhRFRpVLXMJ5cJ3QAYuFY6LLJRcFD+AgQdeYcsnbwiPw28K82HJJROEKuLnAC4sLJsSVS87yH8I+/C7x5ZIX+Yfg5PzshHKJP68arsprgvy88YnlkuO5j2GP3O5J5ZKnOcdhZU5+crnEm70SLs9ugTnZlSnlkiO8Z7Arr2dqueQB9zgczc1PK5c4slbBxVlByMuano6emW9hz8yPM8olzzIuw8qM1pnlEnf6Ejg7/QG0p0VllUtGprWCN1PbQQnyqFyyBnlULnEiicolQxnPI4nwrhgXJ1KLLqEr7J9APY8hicol6fF07WwkUbnkFZKoXNIttiPcH0PGME6LJh9E0dm2UdR/a2QPGIwYBsdGLIH/cK7Drpw4brnkZPgQKAnfBw+EhfHKJeKwSljLvgs/YBdnl0sus76G77K2wV2hPyEndAhWBum4PkDHisARWOM/Cr0+8gvGKy3HYBHjMi9p9pCDPcfhqWY6zm6ma+c1HYCN7vWwt3sS/MvVGopc9zGTfc7JUOYMYp4XHWtguaMAKu3H8Swz7fSMUfYneOdbbJWwxObDipy1roF9rIXwpeUvrNc0SzfItjzEOm40j4WtzS6s8lnTUtjXlA1fGo+gBiYbu0Gf4RFqY5VhLCwwOFE5J/SL4Yf6DPhcdwB1NUXXEfq19VR12lEwT+tENR7WLIGdNenwoXoXanWqmg/T1BtQw/dUAdT2AdUYuEF1CzW/UiVhXBNFOrFHVqmGMp6PIPmMizmkDvtrtao/XKc6FkYjpMP1qtlsan+NvblM1Q0uVe0PkTFwuWpaELWnehCg/u0Yt/nLJWtVQR9dNcZHI99sIcUt1LLaS+M7PeWSHarP4WnVreZyiVHVFXZU32xCdak/hmGat268W80M+FLDgX20m13lkjNaMSzWXXBi5+oGwUh9owPrpZ8JVfooOMSwxY46MYhhqfGCrVzyi3EgjDe9sZZL5pimQ60pHH5m3mgpl9wwt4bvWM6ayyW/WvrCJOtLU7mkyjoNGq0s+LltvbFcctsmhO3sJw2oH/tHMM3xXF8uWeCYDC2OFl25ZIRzBbztzIXtXIe15ZK9rq4wzf1Cg3foXghjmrrBTU08KGuOhLeaQ2rsJk8Qhjx0vN1Ltm8hH7VQ+1e+AIz10/EBPxtXdQ+Ewf8C1OeHoA9mhqjP8VAC2vuzOsBG1gI4lU13N7LbYSaTwpZDU9hjODOc5snifAlXcjbB/IhT8BR+DZVLPkY24bmQTZg5Ugn7Lpq8wvhFDLV7Y6jPRqRSuaQMv4bKJXfj6NpKpBL2NVKpXLKbsRNSqVzybyIdf5dEJieTfyZTz49S6FjJOD+Veuak0fHpNBp5SPp9mkm6GlZnRONtF2R2gicyF8MPsl7Di1ndsCLvcg/BA1weViqDtxQu5rmhgzcW6/hl9gN4L7sLVrlzzmF4KCcHq5+duxxW53qhO3ciamNs3hP4MK8HKqdr/nF4JJ+Pisrjr4Ir+H7o5U9GvU0s+Bc+LeiFauxVeALWFhaiSgWCdXCNIBzV6xXMgaOELnhZOBMVninyw7Gi5aj8faJ87IWnopOwRTQIeyQNeVouESJPKfUKfZSAF2Fb/L4j3YzrApSP0iBl5e0g5ea4EGUoi2WSPBftgP+KOrBNkieix/ChaHqYSXJPFB9uktwV/Q7/J+rJMUmuid7A46LZESbJOlFcpEkySrQF5ohyo0yS28KtcLIwKdokiRAuhNsFDigXjI4xSeoK78MhhV1iTRJ1wWE4qyAnziSJLqiGW/guWMwfHW+SnMm/B/vkd0owSV7k/Qmn5PESTZJAbjVck9sMBbkTkkyS2pzHsFdO92ST5Gn2UTgxOz/FJPHyVsIVvBaYy6tMNUkOc5/AD7g90vBcWSfgmCxRuknSnLkJrsyMzjBJCjNnwdoMJeyR0TsTz57+K+yfroF1aWlZJokkTQrXpXaATSmd4ef4ZWeSXEKSYlaMPyNJTRJDIjkwkVqOJ1CfjATqPwd5apK8xi87k6Qb8tQk2Y88NUlikKcmybQY8kE02Taa2rdGkYFIump0ZG94I2IClEZso7Oc/2ACp4hrkiwMnw69Ybfg7DAJzyQJsTfCVewA5LFHZJskO1kHYDrrKfwppIfqoAn2CRrh4YAZpgSscKYf/8iWPPeRHzD+2kJGtNjhJC9Z7yEVHgesaaZjT5MFVjSp4BX3XdjKvRuuc9HdI1xhcIlzJ+aT6GwDdzquYbaljk/gVbsKz/KJ/XuotUXB2batePMxNincZq3DuoitH8NzFiVWbYDlO9hg5sBvzTVY00hzK7jZdAZrXWzqB88a/0MN9DF+A58bwuEUwwbUSVAvhOv1J1A/In0veEr3DHXVWzcJ/qv1o+omaddAr0YAl2tOoCZzNT3hUfU91OpH6iFQr7qDSv5F1Q5+rdqBCh+qYsGBqnGo/AGq21GkNIpa1kaSzghyKON5DsmHg1SLsMsGq7TYd5+o+jEeZVNLGuyvmoUd2kf1MoQZqrrAvqq9QboqCg5RTQmYJJ+q7vnp+B1Yrtrso5F9LeQoxmteam/tpRmu9ODpVO5mE/K3Ej5S6ZpQUeoZcL2aBQPqdW7sZY0A/qs56cLz4lce3pL2hRNrqpsKN+pCDpOEg195eP96IWzUn7TjLobe8LLhhQ173zgF7jT6rSZJrGkVnGXKh2rTMQue0dwdXjM/NpskZfiVZ5LssjSZUM/4lWeSzLXmQKP1iBG7zNYF/m27bzBJ2tvHwH12p94kScWvPFSyIwNaHAd0JqRqe/i387YWPV3D4X6XRWOSZLlXwXXuznTcFAMPNpnUJkn35gb4X/Mr+IOHzPS+hn8xDmyhFgPjz76XUOCn9kt+uurzANkUoJb1wRewNEQtd0JeOI5Virs0sebDKvZr6GW/j/nMDFsLPWEv4IJwAWYbzxmvo728DdJ/YzRJ6L8xmiRfIk9NEj/jFqSqSfJuNHmfcWoMtUfH3oD7kKomSVekKn1b6No5SFX65lzW0ffnEhyQSOoTqWVJElmYTF5kHJ5CulOoz7rUi1CWRv6dRuOMT6c7sjOewh0ZNtguk4d3fjfzU/hF1n6ozArHuoziToGPuc9gT14vrNoJ3glYmC3Aaq7JXgsD2UE4NWcaVvxFzivYO7cfKuFU7lkoyitGhazP2wRZ+RGon6/yv4Wv89/CfvxBqK5z/EuwuECKqttUsA1GFEajJr8rnAUbCzVwkGAYKvac4B9YIOyLSp4vvAsfCz9DheeJtHCY6EfU/2L6vxxJ9oqOwdOi/tgj10U6L6XeYuydf0QF2E33RRfgA9EwPx27/JSPawN0LA1SYt4OUnqOC1GSsljV0vlI1WrpPKRqtXSu6BGcLfo6rFr6vSguvFo6U/Qb/E7UnVMtnS76D45HqlZLy0XJkdVSqWgPbBbKoqqlx4RHYYVQEl0t9Qt+hZsFaTHVUplgMbxS6IKfFo6NrZbqCh7CHwq6xFVL4wsOwR18XjxG4/8ML+Y74cD80QnV0jd59+A3eR8kVkvD8/6EG3Ozk6qlrXOr4dmcJtgvZ1xytfRV9gM4LbtLSrU0xDsC1/FyU6ulQt4yWMttgr2449Oqpc+ynsDJWR+mo2fmabgxszijWlqSuQmez2BlVkv7ZIyB99JPwv7pDngxLTurWtoqTQFXpr4H7UhVPBFSFTNBnlZL8xgXIlWrpZpEsm8itRxJoD6pCdR/FlK1WvoSqVot7YJUrZbujaXRopCq1dKpMeT9aPLdaGrfEkX6I+kqStVqKaUq3hVStVq6DalaLaVUrZYuQqpWS1vCbsI5SNVqaVjYJriOzc6ulhawx8ODrHOwFasZbg5l5uANBAvg2GAhvB0QQGlABNf6W0GXjxzmK4IXW+i4kHGJtzXUe8gBnmL4VzOZ2Uxnf2jiw//cCbCnW497HXIdgbmuCrjF6ces8pw18A9Ha/ie4yzmXG/vC0fZX9K7tU2Fi21BvPlM21r4m1UI21tPYY1uW/rA4ZYXWDuTeTKcb/ZhTVPNK+F+Uz5sZzqOFb9l7AmHGZ+hHnSGSfAHQwvqJMGwHO7W58B39IdRRTd0XeBnuoeoMZ12HJytbUbtxWiXwe2aHCjTHEZlXlZ3gp+ob6JuLapecJPqDOr5U1UhlKt+Rp3nqYyof65qEMxSnYii4yzIU82NJBsiyJ4R1P47h4znUMs32Gu5qifYfXxVR8ad2I85KjbMVE3APk1T3QnhSVVymKFaH6SrmgPV0nzViAD1v+ynuwthtqraRyObWsjyFupZ66XReLBQNc9TLS1TaZpp5sNgjepZU7XUqPoSDlJb3NXSc+r5sLUmBW7U7HVVSznadvBb7d/OammjtgIO1lkceCe6n6Bcnwp36PfZq6VxhnZ2ett/2+jNj4BDjSZrtfS6sQqWmRLhLtNuC9bC3AZWma+bq6UG82dwmEVnqpbetMyB71rj4V7rLiOe2lYGF9iuGvDmbZ/ACrtaXy29Y/8ednBEw/2ObTq8JacELnBe0FZLrc6B8AtXowY15qqCPdyt4HW3Tl0tHdJ0AxqbTsGfm4/BQs9ReNFDx8O9pJtxXQsp9dHZ24zj/H9BVqAW7gicgO2D1OdRkI6/DtHIMSwH/IX1Hu5YzN4ED7A9kB/2KWa1I+w3WBhug3+Et8Oc23JmwWuc/XBoxAVoj7gOVyFb8Y1CtmLmjF9Gk37GLTF09l0kLL5asdR/ChIWX5X4K3AvEhZfGyRstfQFEhbf9kQyNYlajjD2TaY+6mQ6XpBC5iFb8WVLpTl8mkba0uiqlek0fnHGfZpnhhqOzIzEm2/KfA8uy1oA07gv4AZuF6xRLO8POJeXhbUz8JbAYdkueDN7DK1vzn24J6cL1j059wj8MTcP9WDMXQGH5XnhzbyJqJa2+U/g3vweqKUU/nH4E5+PGrPg1yvWt8AP7xRMRgV2KHwO9xf2QX2mCs7DKkEZ6rZRcAh2E5ainjcJz8FXwv6o9jSREnYUVWEXDBFlYV+ME52A00QDsVNmiAxeysGfsYNmiQQ+ysdLPjoe7qeUdDOuC5CyIJ29HaQkHReiVGWxRLIOSFiRrD0SViRri9+tIlkb0TdhIlmpKCGcPMjYiyOSyUVvYbHoxwiRLEeUFSmScURH4Gth1yiR7IDwf3CkcGC0SBYjvAP/EHSPEck+FJyC/xWWxIpk3xVuhdGFMXEi2baCWVBaoIYX+R/Hi2QD+HXwv3xZgkj2df52yMqPTRTJ1uXNhsI8DazN/TQJY+Zeg89yypJFssqcXdCbnZAikq3IroJ52QZ4hDcsVSTryrsJH3DfTRPJxnD3QldWWrpItjRrMczNcsNjmeMzRLLumQ/gw4x2mSLZiIy18GX6M1ieHp0lkl1IawWFaW1hdWonaErpAulv3UUy+lt3kSyLcS4SViR7k0jHPRgPJFCfWCSsSPYVEhZ3iaMR2iFh8R6QsFgaZKtINprxRjRZEk3tq6Kojz2Srv00si88GzEJFkTshqs5KsjmSLgi2azwWdASdg9OC2vLE8ma2XvgUnZSNubG/h7uYd2HQlZGjki2OfQBZIX6w/HBcvh3YDCUBT6B6/yfQZePHMZ4oYUsaBkKF3tJnWcY7O8ZDo82k2nN1DKr6WP40t0TdnWL4G8uC+6b4foVrnJ2hynOl5jbDsfXUOJgwwv29Zj5QLsQNthq8VwzbL0gx0arsMk6Cba2+rFGpy2rYW8LH74wH8MKTjN3hSzzfazvetMYKDK5se61xmrY05gNnxgOoSomGj6AXv1d1MwK/UiYr7ehlo7qFsKuunT4QHsAlTZG2wG6NHdQh0s0I2CWxoz6PKiugp3UUfCJahmqd44qhKouU02CEap7qHar8h2oU27GLtAoW7AvtMqRjFcjqb1VJB0vj6CzFg45mEMtJ7HX9EoeNCl/xB40K99iPxqVvdjU5yD2aaMyATYop4dEsrfKx0GRTK3sAA3KHQHqz2Ic56eW2z4aU+Kja9e0kE4v3X2ol8Y87xHJnMpCGKNa0YxqVLHhfNXiJqydKgn2UP/ixptRK2Ce5opLJFup+QT6NFqnSDZF+wN8qY2HfXQ7HSLZGZ0cttLX2UWyGv1gGGZQ2kSybwzfwTeGSDjQuNkqkp03FsMS0zmLSLbFNABGm/8zi2Tfm6dDtZkNh1jWm0SyOosQyq0njSLZTutHMN723IBdZpsM9Ta/XiQbal8Nb9oLYFvHcZ1Its/RA6Y6H2tFsp+c46HZ2aQRySpcK+BdVwn80P1cLZLVu/fCUU1LoadpLqxpng0Vnll0lrHSSy2cFvJXxg981P7cR8cz/XRVSqAKHg7Qcd/gD1ATXAgXhn6F2ayX8E/8ksW3lL0WHmS7YUHYJ5jb9rADsAA5i29meHvMnHJWJKOcFcmGI2exUshZkWwNchb7BQkrkt1iHBtNhhh3xNDZDshZkexxLPWfjpzFG0POimS/I2exF5CzqBzkrEj2YyLJS6KWk4yDk6mPOZmOl6eQrZCzItnVVJrDyLTzsCWNWjal05htMu7AfzKew8mZTsjJysMqbMsaDsXcP+AxbgxWSsKbAXfx/oNJ2f2xjvOyz0FzdgnWd0TOZngnJxLr3iF3Jtyfq4ZpeUNQGwvyrkJrngI1MzJ/J7ybH4da6sSfA//ka2F2wWeot2UFN2BTQVvU4djCA/CfwmzUZwfBWrhTEIfqDQhWwU+EWajqncKD8LGwK6q9RfgSpoq+xy4oEKV6KOmOQKmor5eyTwMVokXYR2Uivo88zzjUT+1OP6XkmgApDVKG3g5Sno4LUbayWHUyn3AHbBF2YNfJmoWPoUs4PaxO5hDGh5O/M/bk1MmcwrfQJqyKqJPphdzIOtlL4V/wmrBPVB3m/ApWCiuj62RCoQU+FEyLqZPNEYzNrJNtyjgBkzOs8Kf0zCyMkCaDg9I6whOpH8Cs1C5wLpKrTvYGmVUn68H4G5KrThbH+HUitTxKoD7tkVx1su3xdG0IyVUnG4PkqpPdRHLVycSxNPLqGNIRTX7GeC6KzuZHUf+Fkb2gJmIk7B+xGp7h3KNrOZncOtmu8C9hZngtXB+WxauT8cIWwt/ZNvgeuyK7TvY36zIczErLqZPdDQ2CH4S+gvuCc2BMsApOC8yHD/wLYVv/IrjVRwZayC8Zr3vJYu9iuNKzBNqal8JPGM80UUtu04/wJ/dkqHb1gANd4bDOeQRz+MDZD95wvMXcPnZ8BxvtkfBb+xbMP8Iuhptt5/F0JbZ+8IL1FdZioPUr+MbChtMtGzLqZGxLEVxvPpleJysy94JnTU/S8H5MlfC10Z9aJ5tqXAMDhkK42nA8pU5WYOgOT+gfJdfJeunHw6c6T1KdbKJuOfRoc+Ey7ZHEOlmOtgs8rHmQUCfrohkDH6id8XWyseqFsFkVB9erVsTVyTqqgrFoUU6E95X1qKWLSgU8raxBdZ1SeqLIiihqqYskRZHUUo36PKk0cchyDrWcQA2fUWbB88q5qO0Lyjeo87PKHrBW+Rvq/5gyDh5Rfh2i40dBam8fpD7bA9Q/5Kdrx/qp5ZaPxpT4aPw1LaTTSy1DvXT2vKdOdllZAB8olzXj2ZW+JnqWuXCditNEz7jBjVpVi+B99UlXnayzpreL3slLZ50sT/s1XKUNgwFtjQNvW1cEX+hO2utkH+k/hLX6p7Y6WaFhIlxj8FrrZEHDCiutSx58aTxqqZP1NfWA50xPzFhx8wS42ewxoRIsy+C3Fh5ssPxhrJMNsL5vpHq4a0Dl20bCLTa7vk4WZV8MZ9mzoNZ+UIcd5HgfXnfUa+tkbZwVcJfTpKmTxbvmwyoXD9pdV9R1shnunyCr6XO4uakPbNPcA/7T3B1O9nSDkV5yj5daOreQLxi/95Gp/p7wqP9D2C9AagO94KIgjcYPjYRnQ2vhANZr+JjVCXcvZ++FN9ixmNv7YRPhmbDTsHN4CNLf3mBPcRZB+tsbfJ0iLkP62xusO1IMdY78qpPpGOlvb1DbMdROf3tTJ6O/vamTuRnXxV2FMqQYvgNIsTrZ+AQajY38wveQsWMStTxh/CaZTEghD6bQ2V5IMexTpFidbB5SrE6WnU4tp9JptI8zbkNLxmO4LFMPRVnxWIsLWd3gIO5y+C9XBYfx+mDV/uHVwq7ZhVjNY9lrID8nAFfnTMFa+3NewMm5fVEJz3LPwl55rVEhJ/I2QkF+GCpnXf50yOa/htP5/VBdb/hn4YCCYlTd+YItsLgwBtW4ofBH6C90wy8FM1CrlwQumCach0quECahtjcJD8BLSDHcESmGr5ZwFnaESZiG3WEVHvVQmvTzUr5ovZQvi1ooffg+8gLjMD+1u/zUZ22AlAap/XaQ0mpciJKLxaqQn0GKVchPI8Uq5LVIsQr5X0ixCvkxpFiF/ChSrEJ+HClGNjBWRVTIDwuzIivkB4Qn4FbhgKgK+UKhGo4W/hBdIS8TxsZUyN2CGnhIkBVbIR8ueJxZIf8kIyKrQl6XLoSt09+FK9M6QRvyC2dTu8IzKWRuSjf4UzKpQn5VyHszHkqkluRE6jMzga56Ht8ZfoAsq5D/GkejRSDLKuSTkGUV8rtIMcyHcWM06Y2i9i+iqM+VSBqnKHIwXB4xGzo5J+BYjhf+G96NWyEfEL4W3gozw75hn/Iq5E/Z12Elu012hbyFtR0uZflgPKtPToV8SehH6AhugsOCu+DFwB5YGDhAZ/0Hod73BxzAeLyFWjIY53ip5bXnT9jNcwjubz4CYxinNVH7A/evsJ17GdzhGgGjXOmwynkWcwg6hsBqhw4zzHLMhb/ZE2AH+y7M/46tDFbYruDpLFZ66oXWRqxLhvU7eMASBdtbtmXgec1SOMx8Ib1CbjL1gz+ZXqVVyNNMX8O9xnDYxrgptUJ+zdAafmo4k1Ih1+l7w7n6F8kV8gT9NLhTx4Yy3YakCvklbREs155KrJA3anrD7zTPEyrkkZrJcKvaF18hl6iXwzpVGhyhWh9XIQ9XceA15TRU0Q7lQ1TUcmV7uEi5HZW2QBmKIsdSBSpvRZKSSGpZE0E6OeRQDrWfRyUvVvLhUuUiVHi1UotqX6LsB39SHsUuqFKmwR+Us0N4CuWrYIV8vrJrkK7aF6Crohmn+umq+z4a810fjb+lhfR7yS+9NLfrHhq/BG5WrmtGVSvZ0KWc14RKVkXAP5FlePNqIVyornVVyK3qD+FIzQtnhfwfzVewM7IMe1C70VEh5+taw1W603ZUne4jOEH/zFYhf6ifCLsgy7ArkWXYO8iyCvkK43FLhdxn7AmnmJ6ZK+QvTZNgH7PPhP1uXgmLLLlwneWQEZVj6QSnIMuwp6yj4Ec2h75Cfsq2BLa28+Bm+2Ed6s3RBX7vuK+tkCsdo+Agp0VTIT/v/AmWuDLhdtdpNSrQPRXucr8H32kqhHebsmBlczrkeMjdnjTYyUvH/zJ+15IBk310fMhHx739dJXKz4M/BcjcIHkm2AoOCfWHhtBqOIulhc2sAZjDNPZp+Iadjxl+GjYHPgq7CUeEJ2L+6vAh8BvOKsiO+AtujbgC30WiVcjvI9Eq5FORZRXy6GhyH2PXGGp/FUN9ZiPLKuTp+EWGryUSrULeL55G0MZfhosSSD6yDG+GcWgStTgZ1+B3Gao9hY5vpdDZsciyCnko9Tzcnka2T6eWR+nU8+sMum9c5n14IPMt7JYVhC+zJFiX6dxpMMC9An/iCbB2LbwV8KvsJvgmexxWdmDOQ3gxpytWXJJ7FG7NzUc9ROatgt/l+WBjXiWqZXD+E3glvweqSME/Bnfx81FjCQWr4NwCP9QVTEMFflLYAC8WDkNlFgqewHmC4ajYBwIV5Aq/Rz2XC+NR4XOQaBXyGmE3VP5e4Wuqf+GcZsqRDA+lzHHG/l7KHZ2XUmZxCyVRgY+8wDjMT+0uP/VcG6Ce0iC13w5Sco0LUYqxWB75FCSaRz4ZieaRTxQ+guOEX4d55GOFceHkb+HU0oPjkY8X/sf4QwS1ZEZ65F/id5lH/jkSzSMfJNTBzsIF0R65UMiN8cgDgkPwjuC9WI98heAq7CLoEeeR6wovwerCd+I9ckHhfni6ID3BI+9bsAi+4tvhV/xRiR45i38Xrs9/Pwlj5h+EJ/Mykz3yD/MWw2e5Djgpd3SKR+7LuQ9X53RO9cgLcg7Dv7Kz0zzyntnL4BNeM5zIG5/ukbdwH8MV3G4ZHnku9xD8Mysl0yNvmzUVnso8DeWZVrgzIzPLI4/MkMGp6e/BB2ldYNu0bnBrKhlA/nrko1Po+GYyKWZcjfz1yB2J5GeJ1HI+gXry8VvSI1+E/PXItchfj7wf8tcjPxZL46fjt6RHPjuGfBVNdo2m9v1RZEwUXTUt8iP4MGIs7BCxic5y/oVcDp+L+4ZPghHhl+GiMCHPI48PWwt3sENQzp6a7ZFfZj2C/VilOR753dAs2CO0Hx4NnoPpwatwTuAmfO2/A7v56+F+310Yy/hVC7U89JLtvNSyzfMPDDXfg2ObH8BbTaSkic6ucddBl2svHOH6Cv7tLIDdnVcwk1uO4XCIw4wZKu3z4Xf2VBhh34en2GxrC0tsN/GMF6yfwXKrFqujtMyGMy3xMMKyC+u40VwGW5uvYH3Pm8rhIFMj1r3ROBN+Y4yFbOMO1MZ6gwwWGS6iZs7oB8J++reopVe67+BUXTT0a7ej3lZppZCvvYQ6PK4ZBHtqGlCfT9Uz4CR1OPSp1qOG16pyoVi1A7X9QJkMVyt/QM2PV77BLihX9oS9lb9jd3yojGecHkU+iSQ7Mu6MINmM47HXPlLewe7ro5TDfsr12JX9lU3YoX2Vn7Opz2Xs3O5KIeyiXBpCtSiNQcxQWR6ke9UGqD+XscpPVzX4qL2Xj0Y+2EIjJDB+46WWpx7q+R78XLmnGTWgTIHHlSubPPh3RRocr9rt9sj/USlgR3WdyyM/oB4M0zUqJ+pNMwe6NIlwvHavA29J2w5+qLtp98hP6D6DfL3G5pEv18+EzfpIOM6wxYpaMkhgN+NlC+5oHAIFJo3ZI19nmg1Z5lj4lXmHCWtklsI+lgtGfA0s/WGh9bUBb9v6FfRb2XCKbaPeI39pK4H97Rd1qBx7OZQ43mqxcx3TIccZ0njkXztXw5dOAezruqj2yK+4JsDu7lbwvpsFJzZZVB55WLMO7mzWwI4e8gnjN14yoUULf2fs6SMbfNS/ym+E3IAJngiY4aCgCxqDCRh5cagnzGRthNtZzTCdPRoz+ZldD5vZZZjnV2HLoCXsCfw+PBdPweZ8CVdxNkF+xCl4OuIqHIIsRk9kMd4wstgjbxVNXmUcGUPt9Nez2CnIYo+c/noWX4A4unYSflfinSCFPfLdjPTXsx45/fUs9mMSmZRM0l/PolpS6FiZQn3mI4s98mykML6fjB+nU4slnfosy6B7FWXWwyuZL2BFlgM2ZXGxOqu4H8M83i64j+eHhdljsIKbs+/C6Jz3sL6zc36HmpxMrPunuYvh1VwnVOSNQVXszLsP4/I7o2Z+yP8T6vO5qKXh/J/hLb4Lti0Yh0rbU/AYJhZ+hDqcVXgJvip8D/X5nuASXCXoi7p9IHgFI4XfoqplwgTU+UfC3+Fnwh6o/5HCN3CMcG4zJWOWh/zLQ2k40EsavJSPP7eQAuyyCcKLPjoe7qezbj/1XxcgZUFquR2kzB0XovxlsWpKs5HFNaU8ZHFNaRZ+XdaUpuPXZU1pKn5dkr+HU0svTk1phvAtzBT+GEHHvEhqPwlThIOjakoThGYYIayOrin1CIQxNaUqwQV4UzAktqZ0h0AFxwq+jqspzRXY4c3CKfE1peMLG2CwYHBCTen6giuwqKA0sab0NP8X2Icfn1RT+iJ/Lpyar4eBvKHJNaVr8m7Agrx3U2pK/8rdC3vmpqbWlD7LWQArc6ywJfuLtJrSldn1MC/7vfSa0qO8g7AbLyujpvQRdxEcwzVBS1b/zJrSb7N+gZbM1/DLzNismtI7Ga1gWUZ7uCm9C2xJ6w5HMl5FFteUtsIv4prS5SmkJZlaBjOeTKI+PMYfE6nlbQL16ZVA4xxEFuONxXeC3yCLa0qfIItrSjsii2tKd8aQLMZx0eTtKDorjaL+ayN7QlfECPh5RDW8wfkbtuckc2tKD4UPh4LwQ/CXsAReTakobA48wdbBXuyh2XhLrCtwPEuYU1NqQhbjjYVOwufBf2G3oBYeCFhgbMABv/K74UNfM2zna4LbWsigl9rHeOn4pofOij0euKrZC+1NLfDTJmo567bCPPcLuMh1BJqdlXStMxEqHb9hPtMcnaDf/g/mucr+Jcy3O/AUR22LYTdbBnxk3Y8nnWBtC72Wm1iplZZhMM9ixDoeNs+Dnc1J8L7pF6z1OJMcNhuvoAaqjZ/CLKMOtfG7YQ58zxAD7+q3oX5G6aXQpruMulqg+xim6FSotz3a7+E72mh4Q7MVNTlUI4Z69QXU6lz1AJig/g81vEs1FbZVOVHbD5VU5/OUb1Dz3ZW9IV95CHshSZkMY5TfYY9EKf+NIjvBaOXuSJITSWcrI8h67LVYpYKxBnswXunBrkxUjmC8zKYWIZtGWIr9G640hmpKw5SDIEd5IkijZQWpz9wA3feNn67qAeOUv/lozDjGr1voXg+9ZDsv9d/uwe5WsqBEOaW5pnSYsqGppnS3cgz0KU3umtLRqh9gvSoWdlBvc9WU7ldLYJrmkhPrqxkC3Rq9o6Z0onYe/FebDHvrfrVjX+gUsFB/2YZV1g+CXn2DFT0NM+ATQwTsZdxiQU+jFLYyXTbXlG40DYYcc6OppnSG+VvYYObAAZYNRlSXRQhbWU8Yako3WHvBMNu/euws21T41saCH9trdDWl1+ytYBvHKS12h6MnjHE+1NSUfuccAxucbnVNablrLbzl6gj7uD2qmtKn7vtwWtMFGN18Eu5rPgG7eshXnlo420umt5DHGPv7SJ3vFFzsPwsLA+fhxcBFODz4P+gKWuHKkAL34rGq4TaWGaawh2M+C9g3oZ0txTwnhi2BurAHcHo4D0/REv4FXMqh5+JFnITHkci4LxIZ9YlErildgkTGfaPJi4zDY6jdHUN91iGRa0plSOSa0r/j6NrxSOSaUjayGF8hxveQyHgDiXQ8I4lMTCb/SKaeH6bQcWMK9ZmHREaaIItrSk8xUiLXlFrT6eyKDBq/deZtWoXMh3BklpKeIisMq7OB2wa25s2CJ3h3YdtsBdbxSPZWWJgTgfVdl/MtZOe+hV/nDsLqv869BPvlyVEbZ/N2wtb5caiZjfmzIYevgd/yP0FFNfKvwfKCd1FvFwp+g0WFeajDFYVboaEwF/XZRfAbXCJ4D9V7XvAANgimuCjLolDnUcK9MFHYpYky8WUTZd+sZjLNQx5l7OelZNQyLmqhrOT7yPM+ahnmpz4uP42wNkBKg9RyO0jJOy5EKcxiKRTPBTvgv4IObIXiieAxfCj4OkyheCCICyd/g48EPTgKxWPBGw71mRtBZkVSy4lIOjsoiq4ywHuCn6MVijsCQYxCUSe4CP8SDI1VKLYJLHCmYEGcQtFFEBevUDQXroC7CsMTFIpOhd/DRwVaOLHgs0SFwsu/Dlfw2yQpFHn83fBIflKyQtE1/0f4MM8Ex+eNSME4uX/DZbkdUhWKnNzf4OGcjDTcJWcRfJDtgGOzR6crFE28e7Ca90GGQsHjHYQHuUmZCsU73KnwVNYZKM+yw52ZmVkKRWSmHE7NeB/eT+8G26b3gFvTyEBqdzg6ldpvIJEVipIUOl6VTNqT6OxnjOcSqSWfcSESWaHQxHeGfZHLeC78RlYoUuPoLrOQywrFS2Qx5s+4N5qMiqb2KVHU514kjfBO5EC4JeJbyI44DKdzHFAd/h5Xofg8vBo+ClPCT8P68RSKt+xz8Ft2STaei70ZbmaFoIg1KgfvIXQMikImWBNMzFUo/IE8ODpQBG/4S6DYL4GrfVLoaCE/a6GWc14yn3Ghh9o1zTLYr1kOjzaRaU1iOMudD1+52LCH6y7udcw5H5Y4+fCo4yTm08nRG9bbX2C2I+3ToNUWwlMssK2FaTYB3G89gSdtb+0J71ieYL0qLBOgxezFms43r4Ap5ly413QIK97e9AG8Y7yHShhhHAuNhibUyVzDUphg4MLd+j9QRW30H8BruvuoriG6MVCtdaH2vtf+DKO1WXCb5iAqU6p5D15S30XFDlKPgm9VNtTzt6p5MEYVCfcrF6Pay5VuVH6KciQ0Nl7Hjvi3sRg+bFyJnXK/0RZFfsJ4BrvpQWNeJJ1dgF32qFHNIfswHsZOfNyYAp82zsQOfdb4nPZsY2c2XbUHu/ifxkhY3zg5pFDcbfwnSO1tgtRnU4D6+/x07Sg/jXPNR2O2ZlzRQlq95BAv9TnjUSjeNOZDT+PyZoWitZIFpysXNWF8ZSJ8R7XDrVD8opLCOPUFF9ZXPQCq1A1OvD3Nd/C6Jha20+5yKBS/a9+BPN0Nu0Lxs+4T6NCpbFhl/bfwjp4D2xs2WvHeDMUw3XjBolAsNpZDt1FpVijGmWbCR6Yo2N281YSaMZfAPMtZI74Alj7QbXluUCjGWKfA+9aAHvvItg4etRVBvv2sTqFYa+8PWY7XWoVimmMq/NfRosGYzmp42JkNc1xH1djLroEw0u1TKRTL3Zcgr2kbPN60DPZvXgS1jIs8JN9Lnmcc2kI6Gdf4lkCJfym86V8OxwRWwWBgE9wWPAHfCRnh9dAHuGNv1i54hRWLmbzDng33sJUwNexDzHZF2HaYEK6Gm8KleJZCzlfwCGc37B5xDr6MuAZnIZexa6LIo0hn7MpoUsu4MIba82NvwHNIZ+zoOLrKgXTGTkc6Y9cjlzHnhEtwdCIZSKSWrUlk22TyAeO0FDIm9SLcj3RWKLohl7HfGWenU0t6Bo1wLOMK7J9Jd9dl/gMXZb2GfG4zPMMtxEoN5I2Cr3lH4ZjsBKzmm+zv4Cc5b+CNnP5Y67a55+C+3GLUQGreZjg/LxK1Yc6jOhmRTzXzd/5g1E97/mV4gC+juirYCX8qSEa9GQp+huWFbFTj0cLFMFyQhCrtI9gD5ws6onr3CR7B84KvUNu3BbGo9n8EB9yUjN2bKPX+a6IE/KGZzPRQJh5nHOAl9YxLWigxC33kRR+1DPdTf7efxlkXIKVBGu027VbBuBAlMotVrziHdK5XnEU61ytOIZ3rFScE34TVI1UTwsmDsFbQi0Nn3zL+GEHyIslT8KTg4yjSEkU9l0fTVa1i6hVHBFfhb4KRsfVIZw9cKFgTV68YLsiPr1fkCvbB/xUWJNQrphZuhBGFkYnoWfA9lBao4CX+x0n1ikH8Ovg2vzS5XjEj/xfIyU9IqVdszquCJXlGeD7389R6xYDcv+GbnA5p9Ypvcg7A8JyM9HrFxuzFsHW2E57ljc6oV/Tl1cPn3LLMesUY7nL4Nuse/CyLnVWvuJpZAEsy34GrMzpDB3IZZ9N7wnNpZD5+NeOJkM71CnUK2YfxcDKZwjgzifo8T6TjToy78asZ80+gMSuRzvWKeqRzPT5w78MapHO9ohm5XK8YwXg5mhRGU/vSKOpjjKRrB0b2gycipsDsiD2wmqOB/nA5F88e/gPUhz2Ck8Le49UrnOzf4WI2N7tewWUvhX+wnLAja3hOveIafi/XK3qGQvB88J3cekVxcBBcE6iATv8YONQ/AZ73TYR8xkUtpNZL7X0Zj3ioJZXx++ZK+KKJ7NxEZ391fwEj3R/CKS4efOp8iDv2c34P7zqS4DDHHsxKb38H/mC/gTnH2YfCHTY9nkVumwsvWxNgufUXPG+jpZTes+Uy1i7KMhhuNTdiZSXmb+FFUzgsN23AuiuNRXCm8QyqIsLYD240vEa1tDJ8DU/r2bCPfgNq6YWuFZysO4NK82n7wFXaF6hAvnYqPK4JoDJ7aFbDJ+oCOEH9F6q3WdUTVqseU22rRsFapRLV/qlyBIxW/o36f9RYCk811mBf/NHowU450FgB9zdejiKFUdSyFHvq90YjdtnBxkGMJzhkJuMP4XTtf9ihhxq7Mx5gU0ssm679Cnt5b+ODUL1iT2NbuK9xa5BGCwSo52jGG/56xZ+NJX4abaWPtLXQCJ8wnvFSn1x4onGBp15xs9HQXK8wN34B5cqXTfWKJcpx0KB0uPF0qoXwqioVytV7XPWK7ep3YIzmprNeMUczAho0Nke94gvtEviPlgs76w7aMQddB5ilv2VDLemHQptea0VPwxxYb4iH7xt3WzAf4zsw13TTXK9YaRoGfSaDCbVtngufmeNgT8s2I1bHIoZ51nOGesVya3/otb7RY6/ZZsDntkjYx75Nh11sl8ESx0VtvWKTox9kO59r8C1yVsJnTq+6XvGhaw0845LBNu7nKnzl3Nthz6bv4aumCXBW85cwzUMeZeznJXWMi1vIAh95wTcWDvPTVS7/JLg28BWUBX+Ct4N/wJEhO9SH+uOOE1kn4CtWAebTn70GnmO3QGnY55jtb2GHoCTcDU+Gd8KzdONUwXuc3+H4iIswFHEdbkdG1yvaI53rFY8Zp0eT8THU/jtjT2R0vaIhlvr/iIyuV/Dir8CTyOh6xWBkNGoAGV2vWJZIFiVRy1XGkclkC+OmFDrbJpXu/g8yGjsd6Yy9mU7uTaf2LhnU52UGjT8rk+6YlnUHHs16CvtxTVDDTcJKzeP1hMnZK+H2bBXMzfkIa7ox5xiMzs3FWs/JXQ51uR74Wd5EVMKNvKfwnfxeqJNf80/AJL4A9fMjfy008lmoq+EF38DrBRooLfwStbeqUAmVhdNQk2IBC1U6WrAZ/ixogxreKbgL/xRMQm0fF0S4KSV/dVPedW4iXzB+30w5mOohjzD29VJKahkXtZB8H3mecaifrnL6KTHXBEhpkEa+HaSz40KUyyxWZVkdMrqy7DIyurLsIjK6suycYHpYZdkZ/IKuLDuLX9CVZefxC7qy7AJ+QVOfuRFkViS1nGAcFEUaGX+Opv6CGBrnEjwl+Dy2suyowA1/EayKqyz7UVAQX1nWW3AQBguLEyrL9hXugl0LUxMry54WLISTC2zQx/8iqbJsJf9/MJ/fMRnj5P8Ou+VnplSWPcpbAifkuaAnd2xqZdmK3IcwL7dbWmXZsZyjsHtOfnpl2ePslXB8dgts5k3KqCxbxnsMubyOmZVlv3LXwULuE7gxi5NVWcbKEsCJme/CemR0ZVlZRg+4ERldWeZNI79Io5YryOjKsiJG+i/blWX0X7Yryz5mPIWMrizLZpyXSC2NCdTnQ/yOriz7AxldWZYU3wl+i4yuLHuGjK4sez+2I9wVQ4YzTowm/xdFZ0ujqP+GSLq7J+JzODJiKfybc4uu5SRy8ezhQ2Gr8INwT1gsr7KsOGwmPM1Ww77sT7Mry16zrsGvWfIcrEJoA1wassDoUIfcyrL5wcnQFFgCPw6sg6f9m2GOfxud9W2HypYdsHcLHR/y/p+j+w5vqvrjOJ406V7pXulIyhJBIGnSIGWvsldVlgwFRIYCVtk/i2xkKiA4oIAoaGWrZYMgIIICMgookDRN2zRp0zTdbfp7n/zzeu5zcnLvufd8v/k89+GpChUes+uEBbXCDI+5NUJ5jTjDzOoNeNs1F9Nc6bi/qoTrKqvW4n5nInZ2HmVtlyt74ZjKf1iz2TEDP3TUcUc+jg24q0KJL1Uc4a7PlovnObz8b3bwhX0qfmB3sr/e9k9wty0cO9j2s/sXy9JwVNl1asNonYDzreXUjNS6Aj8vjcBWpd9RUT+XGHBAyU3q7VHxRHy32E4dNlr+h5stoZhiyaVKTxZpsF/RNWr4gXkszjAXU9sNhR/g54U11Lyu8H0sMf1HF5w09cMdpkN0xzpTMK40zadrPjE98BXHXXGV6Rs6a7VJimtM0+m4taY/5MKOcjHymUxY4yXOMB7Xmy5IxadqqfjuGjo6x2RtYadMw3GF6aRbnC3GLeYvbRbznzeJ475N4jzfNwoDG8UZ3m8Qn/5TT9+ZDLjTtKeOvjP547+m/9XO7KIudNfM7LK0cB0aC2NwmPlQNf1u7opti266ZnbZXjQBvSzlVTxhyydossRgVnGec2aX34t7YlrJnUp2vGQKhpRWOGZ2WVz6PywqDcXR1n0V1IA1DTuX3SinisomYpitws7d2VZghS0CJ9kP2ugOuw4N5b+X8XtSnoVhFUVWfm0qPsKyCn8c7/i6dGaXm44u2K3y9xLqtnIsJjhLi7lr52Ksdvri5KqdFs5Z1QYNrjNFM7scco3BxOpqMxVVfRhVNR/iqZoJOKx2JJbWDsfVdcKUeuE5j2MbhqGrQRxvbRQzOzSNwRtNb+C0ZnGGluZ38Sv3ZtS03MGLLW25Yi/JJvxFUo9tpDNZz3bpA5R5vco6l3htw0avf3GVLJV7CZXPwK/kX+Er3vl4nbfpmV3eIqnpdI9fktQzu+j9hPc8vucvxgMCxDP5jqTmlzNQfEv8VybYF5J6ZhfxX5mY2UX8Vya43xCh+K9McL+hQvFfmSAXPI4NE7rCxJytJDX3S1Jzvx6nRYoRSdR5/DpKzDREX8b70eKK78f8gYGx/+D3scXYO86X/XoS1xXfi1+GDfF3cHlCF/a0NmE3zlZ6s+NPlR/g4EQj5ieOoB7aJp3HHUkvUyfy5C9xQbIfVfQ8eREOSynB0ykTqDG16h6uUY2i9oyqx9hRPYvKnKGWUqub1F/ht2o9NXxCfa9K5ON7LpF0AdUi9b7z2KdG+MzjklphVJ3wuMdh9cJSj6sbRIaqGoXnG8XIuCZxtuomkblbm8X5O7hFht5wiznTWkRGSyRyzX/ktVzzL3kt1zwmr+Wah+S1XPNAHSQTHsJH5LVcU0BeizlLvYUxPmLkpMcRvsIyj2v9hKn+wov+4mwTAuSaO+oa/I13arnmoDo1SK75QH0EO6o7BTNHdQizVcoQuSZItRFzUxpRkzIzVK65kvwQs5L7KuSaoqTj+FFScphc45u0CXcnNuHLiXPC5ZoLyqc4Sjk4Qq4xJ5zGjxLaRjIzYQfujpdFyTXt4+fjubh/cUhc72i55n7sLhwT+wSvxfjFyDVdYlrhF9E6bCKv5Zqp5LVc83tkf3yJ1JZrNkWIkcrwPvgaeS3XnA4TJnpcoRAWhYpPB3s8EiJGwkN64UfktVzzJEicuQepLdfs581arvEhteWaWaS2XPMXSc0T8LjTT9jgK8Yn+4o5V3zEedr6jMKN3guxWn4Cp8vr8LGsV6xcM0K2BW94leEQr6w4dkR6BWdJ0+LlGrfkAG6TKBLkGrVkMR5peYq6li5KueakewG2cX+FW5qPYnVTPo5rOo/nGy+gqvEirmm4hNZ64fB6MXKiThjtcUmt8FmNmN+n5hx+V30KA6r34DyXuMrTqg44kvdrueaucxZOdDazNnvlZvy4MgUVladYea5jIHZxPOaOfquYjVkVTdyvpXwzLipPxsDyY+zjN3axs53td9nlK7Yp+IbNQQ2Ula3A5WWRGFL2PRWyx9oNO1r/FvVTOhVHlLqoqBcla3BeSSx6lfxA1W0vzsDWxbepxl8tk3CwpZwqfVb0Mc4rCkdp0UEqeZs5HVPNv1Ph+YXDMavwLyq/wdQPT5qO0gurTVE4x7SYHnnL9IyumWzqg5NM3/kKA3zFyHv011TTPW8xR+/xS7kYcdOVU0xvycTxNbr1bVN7j1ukYqSKjn7T9AaON51tESbjRNNKt/hWcbOYOcTj0SYxP6JJjC9sFMf/NojxXjjT9G29XLPAFIDrTNl1YuXFtXKNyzQNBxfaauSavMLFGG0OwJXmr6vlGqe5I04uuuCSa24XjcRulsIqueZHy0JUFgfhpuJcp1zTXKzBOSW/VVKZJaOwX+kLh1xzrHQeKq1S3GDdXiHX1Fvb4syyM+XMLBuOg2wmO8/Wlo1t7T64w77TJtfIytvg++W/lFFX5QMws+KRVa75uWImpjoaS+WazxxbUFaZitmVv5bwW1E5GMc4nxbLNZeds7FjVb1FrtlVtR7lrnhc4DpSJNeYXAPxjepSs1zzT/U3OKFmDlbUjMH1tYOxVV0mXvI4sX4g1nnc3iDs3CjGbzUOwZlNw1HePBpzm8dhN/f7+NCdi++22LCyZQhXnCs5hS8kalYyQroNz0mb8BWviaz2sNdPYs2yGvxV1p176cP7Nd3E+7VcM4P3a7lG4nMVvyav5RoDec3vnkfxfs2vrr8YP+RRvF9zrQAxfxmpLdfE8n7N7pPaXJ3Upo9IbblmbYgwNVSMXPQ4QSGs9fh5mLBTuLj6n6S2XPMOec2TjxTuiRTjr0aJMzyMEmdeEC2uEhIjrvhDzA0cEHsXTbGFYiVxUvYrKr4T/hA/Dw0JV/BcQio7m678FH9Q1mF84gz2fX3ifaxN7EM9zEg6ig+SEqmTfsmf4onkBkxJmUUtbUp5inUpw6mxKarreEU1iNqLV/+DU9XvUJmfq1vwpPpLKvZ3Uluu+ZvU5hmq57pExvlXi7w7WC2SsXeN8D+Pi2vFeFSd8LjHYfXCUo+rG8QcVaPwfKMYGdsk0tbVJJJ3a7Owg1uc/4ZbzJnWIpJaIsnVNJDauZp6UjtXU0Nq52pcpHauxklqCw/LxEh/ea6mWm2UiznLvYVxPmLkZ4+jfIV2XzG+3k/Y2j9XU6u+7C+O3wzI1TjU9Vio/iwwV3Nd3TYoV7NLfQpfU6cH52ok6hOYq2oTkqsxqL7AWyk+obmaySnZ6Eg24YrkEYpcTVjyedyf1D4sV6NN2oVXE33COU/ih1iiLMKlyqyIXE2w8gruTegSmavpkrAXf4sPjsrVjIlfiuY4Cy6IGxydq2mM3YuLYl+gNSYwJleTFdMGz5LauZrk6B64itTm/KR2rmaIx6O8a+dqIiL64EJSO1fzlLfsXE3PMHF8QCH09Tg7VMz5O0QcazzuJLV58kHizJNIbdZGaudq2pDauZoNpHauppy8ztWM9viLnzDeT4wv9xVzjD7iDP19huIP3u9huPd3mCMvQ5dME5ureVf2MRq9HuNbXr3icjV26RH8WJocz3zpFvxO0ozpkpkJuZrfW27j8JZ2ylzNHVI7VzPAvR9PNJ/D2OYbuLzpLzQ23sH+jXfxUMM9DPI4r154v05o8Ph1rZgjqRXzp9WI796ovo4dyO5czTbXRmyoGoJzqlxcvcy5GT90qtDbeYK17arshy9VPmLlpx2zcZCjmTt6UrEZ51SkYHP5ce56S7l4zqryf9jHU/ZpOMDuYpcf21biXFsESm0HqITtZTpsXfYHFfKz9U3sZ3VQOfdLV+K00misLjlEda0peRVjSm5RdYeL38RXiyuoxluWj0V98q6dq6kqyqViV/OunauJ5l2bp8q7Nk+Vd+1czZ+8a/P8C+uofK/CbDxmMtML2aahONJ0nB7pYYrCdNNieifN9J+vsLfHg/SXzuSPetNcbzHnrlwcp8nF+C6ZsMlLjE9Bg+mqVHzaDjWmjfR1J5OjJVfziikLO5vy3XSNSekW83OaxfzCJnE8sEmc58dG8d1Q7Gr6oIFKNhXU52qGmXrgu6Yf6nI1X5lSsNCUW5uryShsh7mFv9TkagLMA3ChuaA6V2Mxz8KsokZXruZK0SbsYknBXMvJKvq3OBM/KX7qzNVUFs/BKSXNlbma2yWb8NVSJX5XmuegPq3dMcf6VwW9YJ2Kb5a5yplZtha72xLwiO0ne64m0d4TP7XfsfE7Zp+CM8odZbmae+U52LMiDH+q2G/N1SQ40nC943opMx0TcFZlRQm1VPkJDnZG4mnnt8V0YlUaflZ1xZKrcVeNwdkuSxEzXUtxaHUMXq2+ZKYLanLwfs1EnF07FH3qBuL+ugHYs174tL4/LmwQRjSKkaNkN78kTWJ+cdNIXNn8Gia7Z+IZ93Yc0fIvPmnpyrXekOTiLUkIK+kmXY6HpaUY5zVUrNMrF6NkVtwr68JdtJcvwHz5fhzqfRYt3lfxE1I7V5NEXnMVj6/7CZ0eN/uLT9uT2rmaawFi/tukdq6mhXdtdp/UplpI7VzNP6R2rub9EGFgqBj53mNfhZjzXCGOl4YJY0lt+pHUptojhDaP6yLFd1tFXcZLUeJaE6PFGuqib+L2mDvYOfYJ3oq14TtxfuyXJF6PO+M/xFYJYh8PJ7RjT1spt+IuZTP6Jc5mxz9KfIxFiQOph6ykU3glSU2daJK34r5kN4amvEcVLUt5jiUpY6ixUaqb+LNqMLUXSmrnasapp1OTW9WiSn9Wf0HF/qnWUsMF6r/QqJ5FbZeofah5u3o/Vqp70gtV6qc1IjcX1goj6oRHPQ6pF1lZ7HFlg8jH5Ebh2UYx8kaTmONqEsm7tVnYwS1GbrjFnGktIqklkgxtWOrXqEg1SDO0wan/YEDq+14ZWr/UQFmG1j/1e5kY6SvP0AalPve4xFsY7SM8gYGpw32FVl8xstpPnEfln6ENST3vL47HBYjzuLBZvTkwQ2tWtwrK0J5Rn8ClpHaGtr36FN5SvRSSoZ2h+gobUwJCM7RbUhahKsWCJ5LHKDK0fZMv4T9JHcMytNOSvkRXol94hnZN4kcYk2jGH5RjIjK0Gcrf8K+EzpEZ2ikJe7AyPjAqQ7syfhFGxBfi/riB0Rnal+P24OHY56iMDYzhbDGt0U5qZ2hHR3fHX6L6YHxUP/yY1M7QFkaI44G8cWdofyS1M7ShHrPDhAUKYYbH3FDxXbnHmSFi5HZwL+wS3AN3BInz15PaGdo3Se0M7WVSO0PbJqArbvAXlvsJR3v8xVd8muArvvWxj2cl3pNxsPcW8an8DraTx8RmaPfIpmKk7Gfc5hUTl6GN81qJh6VVmCGdFp+hvSO5h29JeiZkaJ0t3+P/WnyVrLZlHOa4d6Kj+TSOa76JF5ruobrpAa5tfIRlDQU4ouExnqwXxzEel9YJX9QK+9WKmYdqxLeCau7gvOrf8IFrP3Z3vYt5VXHYtiqfNfzkHIbdnM9Z2+3KeTilUoaVjp2sfIXjJQxznOW+DlQMQ13Fc+76evk8HFcuRZv9M3bzf/ZUDLOfZK8P2vpgV9s/VMKtsmk4qayWCqmwfoofW5Mx1HqC+tlb2h87lz6iui6XzMLRJU1Unbl4M35UnIJ+xcepyS8tvbGj5S4Ve7nobRxdVEslF5o34AdmJXqbf6TOvyzUo6bwLPX/j0mHq0zf0hGDTcHYxrSATokwPaJ3Akzd0Ne011co8ziTLvMz3aLv/E2dvcXxdrkYr6M3fUwTZWLkspf4bmsvMWe9VHxqp69lplEoMf3SIoxvESP/c4tvmZrFzAHN4ls/NokzhHr8oJFeNj1qyNCGmzJQbTpQn6HtaVLgfNPqugxtvskbFYWbaqn2wgT8r/DHGu7FnIH55r+ruaOiqbijqMrFFS2rcYElDk2WvKoM7ajinni5+K6T51zyNn5TUlXJSkpX4cLSSDSXHnQw05qOF61/VGRoXymbgF+X2cuZacvBJbZItNq+s2dox9oNeM3+hy1Dm1Y+DveVl5bx+1OxFJdWBKO1Yq+VmY4ueM1xpZTKqXwDD1ZaS+gU53Jc5QxFpzO3mKqr6oy3qi5bqBzXaPzOZS7K0EZVL8Y11VHYXH3RTP2Q3fzi1b6JB2uHYS/etTO0/5LgGdpFZDfnJ7UztEc9DmkUI8WNPDPtyiYxP7l5FJ5pHo+vu7Oxwv0DrmhpQF/JBK61QnINqyRprGSK9AD+JQ1ihb29ZuF5r9PYV+bF+m/LMnGsfBWWyH/C/3lfxDif3/EU2Z2hHUlq0yke1/kJW/mL8Yv+Ys4EUjtDW+vxc1I7Q9uJN+4M7Z9kN7/SweJsXqQ2vzMeXw0VIw89zleIOcFhwsNhYqR/uJhj9Lg8QozERopznooU1x0Z9ZdYSdRDXBv9HFNjxI5ciGnAcbEK9qgqtjNujJuCKfH78Ei8C7skZLGbeQnnMVn5Eru8RfkFupXe1MCcxA/waeILHJw0jAo5nXQW2yW/ROXsTN6F8hQ/6mpeymJ8klKOvVXvUnX7VDasVi2iGl9VB1Klc9UH8DN1BtX7k/ohXlHPp6ofqIOqRa4dwgp1X7qgVv28RuTdUrrDKzWafvFOPYG+qcPrRRpa60WqrmkQualqFLl53uO4JjFe3STmbGsWKdzRLUZuuEWSTmsRSS2RFGjbkdoF2rakdoG2dep9VKfO8yrQpqQGyYSHZGKkv7xAm5pqxFapy72FcT5i5GePo3yFdo/r/cSnrf3F2S57fDNAnKEeY1I/DyzQSlLbBxVoH6vP4Dfq3sEF2uHqC1ipSgsp0H6q+g5VqujQAu2plNU4IMWFBclTFQXad5P/xvqkjLAC7fqkQxiXFBVeoP0hcSW+mliJfyonRxRo31T+hRUJGZEF2hUJP2J4QmxUgfZA/GrUxlfg5bjR0QXazLjv8PfYItTHhsYUaHNj2qFPjB5n865doP2b1OZbpHaB9gtSu0DbECGOJ5HaBVrxF1sF2jYexb9rF2jFv2sXaEd7FP+uXaCN9yj+XbtAK/5dm/vijbtAK/5iq0Ar/mKrQCv+YqtAK/5iq0Ar/mKL5+MvlHqc7if8w1d82tFXzN/mI9ZQ7T0exV9scRfyG5guD40t0Iq/2OLJy35E8Rdb7IvXIhR/sVWgHSgdF1+gfSK5gXMluoQCbXPLN7i+xY2hLaOV7IV7GzY3/4LTm//Am0138ZWm+/hZ40OsaXiE48nuAu2FeqG6XoysqRNaa4XDa8XMEzXiW9G8cRdol1Sfx2euL3GgaxL+WhWI2qpDXP2MsztmOv8WK6ycgnMqnay52bEaNztiMNlxmPs6VtENe1fc5q7/KZ8knlJ5OftYZ/8YN9gVmGjPZa+P2TpjX9tlKuFh2WicWVZEhdRZF+E6ayDGWfdQP4dLO4taKr1Cdf1Z8hpOLCmm6uzFi/Dj4gAMK/6KmjxgeRn1lnNU7I2i4TiuyEglW83ZuMTsjUHmHdR5bqEa9YWHqf9/TG1xuekrOqKryQcDTHPplHLjXXrnhVGHT4276aYnxmYf4VSPv3sLX8LHxk10YoGxUiZ8TSbGT9Oz/xoTvcR3V0jFuJm+fmDMxHvGvBahokWMZLvFGQqaxfwMj7lN4lty/M84s7FAazbebijQVhm1GGLaU1+gzTCF4cemzXUF2vumSNQV5tZSV4Wd0N98qaZAu9A8GovM5uoCbVbRR3ilyA81lq9cBdp9lldc4rldqirQ5hSPxopis5M+LfnQKZ6zDxpKv6gs0H5X2g6jrGccBdqV1qHotP5XUaCdUvYe3i5rKS/QdrN9hj/aWmG8/Rc7O2jPxFr7Y5uogXfxXnlDWYG2V8UmPFqRgkmO49YC7SZHX2x03C/l96RyBhZU1pVQh85P8RdnIrauOlJcoP28qidKXH9b6BHXFHzqchYVaAdXr8Wz1WrU1Pxp5peq5lPsUzsdH9eOxuy6IRhan4l5pDb13CA0e8xpFOPKJjEnv2kEZjWPQUfzFLPou1WY2nIVj7ckcBWtJAd/kNgxXjqRlayV/oE10s6scI7XOrR73Ufx/yRizfIpKP6fRNy19y8o/qq6QCv+qponT2pzFfKaX34/4RWPk/3FeKO/mPMFec11edfm1y9QfHc2eV2g9SWvC7TfeuxFXlM/IeJ4UagwUiHmHFNcxqFhwpIw8d1V4eI8KRHi/OcibuPYyEfoirTglqh6bB8dyl78Hv0STo4ZhHUx83Fz7LeojivGo3FdreLXezcejZeyp6kJc/HzhKfopRzEvs9X/orPla2ph+GJn+P5RAl10jFpLn6d9C8GJg+hlhYln8Wi5I7U2IiU/fhLSiK1F63ai3NV7ajJX1W/Yo1qMBX7svo5jlN/RCWvUIdQ29+qv8fL6j41ItH+Q5t6ER3RxPt1AZl7FMNTh9A7sanFmJi6skGkanKjyMSzHsc2CV1NYnxrs7CDW4zccIv0nNYi0lkiyU4bSlJnpw0hqbPTMknq7LT+JHV2Wr/UYJnwsEyM9Jdnpw0kqYXLvYVxPtlpA0hq4WhfMafcVxxv8BOftvEXZ/vN46QAcZ4G7Ja6IzA7rU1qh6DsNEnqebym7hecnbZY/Rsq1YaQ7LRfVD/iUFVCaHbai5QNuCClHuUp7yiy03YkP8A2yX3CstN+TTqKA5OU4dlpjxLX4TuJNVirnBaRnbZOeQ/jlb0js9PyEo5hj4TEqOy0v+LX46R4J5bFZUVnp82PO4T22GKcFKuIyU67QVJnp71CUmenfcb7dXZaDUmdnTaepM5Ou0BSZ6epPa4hqbPTrOHi0+EkdXbaiTBhlMfFCuF/oeLT3h4PhogR/5BeOJekzk67E9QD04LEVXbxlp2d1hTQDaeQ19lpV8no7LR2Hjf6CSt8xfgYXzHnVx9xtgSfMZjjvVSsRJ4v1il341+yAbE8edlOvODlwt5eb8YxLr2NU6Xd47PTXJI8XCuJS8hOi5F8ggdairB9Szdldtoh93JMcH+Pq5vPorXpdxze9AeeaPwToxtv4ZKG2/isXtinXox8Vyf09zi3Vsy8WyO+pav5DXdXn0C3azPOcI3CR1XNXHdM1Vf4xNkF33FeYW11la/hhkoLa06oXIR5jkDs7viGO/q7ohNOqbjM/VaWj8aV5Sb2Mbr8Azxkl+Or9h3s9S1bG5xs+4VKcJYNxFVlT6iQqLK5eNDaQuXordvwemkqji39heoqLRmEi0ueUHUBJbPxm+ImqrFT8Wa8bEnGMZZjVKy5qC9+WPSASvYpmolfmOup8HbmDXi2MBZHFh6g/ktM7XC9aT8dYTBFYINxGZ1yz2iid84ZB+BJ4w900zFjiMcFPsIH9N1RY1c8YvyGTvzJKPU4XSbG/6Bnjxs7etwmFXNc9PWPxrF4yHiuRZiCPxhXucWnJc1i5tBmca1jTdlpp4yReNq4qJGuND5roPuMmehvyq+nr01dcIfpVB1Pz9QDxxbeqs1Ou1L4JnY2l9dkp+0x52BwURguLTpQTbUU6XCc5YaLnrKMR0OxvSo77fvijzG6RIGrSvY5OWeJBqeUXq2kPktfx+7WUgd3Z12KyrIgXF/2dQWdWNYB37ZdLOeJ2UZhH3uhnedjz8akcm/cWL7TxlMtb4czK86WZac9rhiOmY4XVrrGMQ9bVUrxs8rPSvktcrbC95y/lNCtzkwcWvWkODvtTNVsbOdqtGSn7XRtRFl1Ei6oPlGUnWaqHoJjayrNVG/NYXyrdinW1k7FbXVZ2KF+ON6oH4zTGgahpFEcf904FLs2jcQHTWNwfvNYDHbPNIu+24o9Wx7gny2duMpgyU68JJFx9U7SBfiN9BkGe/Vhhau9dqGfzITbZO1Zv1I+Bw/L92B379P40PsKLiCjs9NCfIU/kNTsrJ+w0OPH/mI8IeB3/JWkprYDxbcqSOrstE9J6uy0tmQ0v0vBF3BKiLApRIzsChWfpinEzDsK8d05YTfQL/w2Hgy/j70ijPhvhAsXRobyzMOiNHg4aiL2jN6M/0Rfx+kxfuxOVUwWLo39EZtjg9nBj+I+QmucCcfHj2R/b8RfxPSEjuz7wYSvMUIZQFV8olyElcoinJo4hpq5k3gZeyZ1ppbyknIxLjmCSluZvBbLkiVU4PCU/+EPKRIqU6pag6NUodTt16qv0KhqTz0nq8/hG+qR1Pk6tQVPqZfTBU/U0fRFvfoYhqUOpV/UpDP7RTqz16QzVyeds9P6pr7RJDKxqkkcb20WdnCLDL3hFok5rUUkskSi0C0inRW6haSzQvch6azQLSCdFbp5pLPwsEyM9JcrdB+QzsLl3sI4HzH+M87nPVpY7nGDnxhv4y/m/OZxUoA4TwPOIJ0VutGks0LXkXRW6Fzq/sEK3ffqKzhE/WqIQmdR/YTLVImhCp1CtQkPpDShLmW2QqG7nvwYxyYPCFPoSpNO4uKklHCFzj9pE+5ObMT2ie9GKHRnlY9wmHJApEL3POEUzktQRyl00oTNuDW+BpXxb0QrdPvjDmNiXDFuJp0VulrSWaF7M0aHv5HOCl2b6N64gXRW6OzkskI3yuPPEWIkLqIPLg8Xc4y8Ryt0/cPE8WGFMMjjvFAx536IODZ4/DpYzJQE98BpQeIqN0hnhe5l3qYVui2ks0JXRS4rdG94POsnTPYT4yt9xRyLj/juYJ+heNR7DsZ4f4ur5SVYJ+scq9C9J1uGFq8HON0rI06hc0h/wBXSuHiFLkK6Dg9KXJgmmZig0F1qOY8DWiKUCt1V9+uY7s7Bfc070ad5L85q+hb/avwONY3f484GYUO9cJLH3+qEbTyurxUz7TXiW6Nq9uDP1ZswvnoWfuLqiM6qp1z3vaolWOUMx4+d37OqYGc3/KbyL9bcsXIKXnA4uZcRjlX4oiIG51cc5n69KsTz2VF+k31sVz4Bz9ht7PIQ+//wP1sovm/bSyV42brg9rIrVEjrstfxZ2sJlTPAuhgLSgNxVuk3VFdDSWf8tOQ3qk5ZMgaPFJupxl7FH+E9iy9Os3xJxVYXdcA1RReo5OiikXjIbKLCu5o/wD8LZTipcCv17zLF4VbTbjoi3RSK5caldMp5o5HeySWdWRvpzBzSmUowzqfLNpPOCt0m0lmh20g6syrSWRxPl4k5f9Cz20hn4VapmO+irzeQzgrdWtJZmILrSWdxnpJmMXMo7iCdFbovSWc60bikUaG7bDQ3KHRW4xhsbfqznuo1DcE/Tf/UKXSdCqfirsLKWoXO2/wJfmCORJP5YI1CN7IoHS8W/VHNflnG41cWm0uhCyj+GJcUh2Fp8YEqurhEh9dKrjmpvdKxeKDUWqnQhVmX4QprKDqs+xwK3eQyDd4u+62C52kbjd/bisp5zvaFuNruj1X2L+0K3VvlL+Od8nM2ha57xXDMqzCVsXeObNzo8MYGx06rQvdOZVt8UJlfqtD1dQ7G486nJQpdStVc3FzlLlbomqq24CxXCj5yHbfQ19V98VR1QRG1XTMfv6qJxvja22aF7tvaLzG9bgneqXsHZ9e/ib4N4/BAw1js2SiOnzZOwIVNkzGi+W082jwLh7hXYJH7FC5ukXBmqWQyLpfcwEqJjqtPkX6Lf0mDWVVvr9l4wesM9pN5sfK/ZYNwvHw1WuU/4Qrvi6jkDVqhyyedFboscpln63Gjn7Cdvxi/6i/mTCGXFbrmgCu4m1zmtzfoMt4lnRW6ucHibP4hwoMee4eKT5+Fim8tUdzE6LB7eCLsOQ4Ld2BJuD9P+JOIDpgQOQGPRe7AXlFP8FaU2Ius6GX4KPohvhGTzk7djdmLA2ID2MdfYxdhm7hi3B73GrvsFX8V58WnsfvP4g/gkIQwauNMwv+wvbIMdyvHUTl+iddxYWI6FWVOPIQjk+Kot7NJG7F1spQ63Ji8CJ3JlZiVMocqPZVS5hIZNJcanqFy4q+qJdS2TO1dK9Lqc9yobkUv/K4+XSeybCQ9Ep9qxfTUVfTOcBKZ6iWRFbp3SWSeHonMrxCJLDKxg1tk5Q23SN5pLSKFJZI83Vckcp7uSxI5T7eLRM7T7SCR83SfpwbJhIdwe2o/uRh/4XGZtzDWR4yf8hFzRvoKbR7X+Qlb+YtPL3mcGJCn25Zah+tSPw/M02WnvhyUpxtFIuex/gHBebo76mu4UN0zJE8XqT6JearWoXm6Pqqd+DDFR5GnezflQ2xMLsRNySPD8nRJyefxSNLL4Xm6nkm78E6iT0SebmpiNjqVhbhKOSoyTxetvIjfJ3SMytMZEnbh9fgWHB0/KZrzx/2EI+NK8RKJnKd7KbYdbiGR83RV0Rn4Bomcpzsb1ReTo/rjykhhMYmcpxsSIcaPhos5ER4XhgmfKoQ9PR4gkfN0vh5nh4iRv0nkPJ2WRM7TfUEic3eB4lqTSeQ83RUSOU/XNqArfuovrPATjvH4q6/4VPyrdJ5O/Kt0nk78q3SebpD3FvxZfgfFv0rn6b6RTcUI2c+41SsmjqfhtQK/lZajTjo+Pk93VfIbjpS0ScjTPWpZgeNa7uA9d6CSXXB3wh+be6OieTBmNw3HgsYRmNE4EnMbhHKPM+uFt+qEnT1urxUz62qG4cSagXipWo+tq8Nxk6uAazVXrcePql7BWudt1rPc+S76OL1wa+VuVptY2RHzHJe4lwzHGLxdUcSdTqpYiI5yX7Ev5bvYx+jyl/B7+zmx4/ZheNP2jBqYaHsfK8qkuKLscyokrKwN7rf+Sv2kWTPxWukT6mps6VwsKZHg4pLPqLqAklT8pvgUNdmpeABeshRQq6Mss9BU1EQNZxdtQe8iFe40n6DC25n74ZnC+1T+0MK30Wiy0QvLTO+hymSmRx4ZR+G3xnx6Z51RicuNOXTTYqOZ/lpkzMSFxjz67kOjArON2XJhAb35kTFDJubk0rNLjHIv8a2ZUjF+i75eYOyM84zbW/J08411bvGtiW4x/1KzuEorXG1c38QeGR2Nebrjxgn4wnirgTo39ce5pmv19ItpOLYvfFJHdxfOQom5sTZP9555E/5rTsYhRcdruNOivtjOcr+aJ2CZjvLiWhcrKd6AxmIljiw5UpWnu1jSC18pvefM031dOg0DrdWVrN+6Dkus8fhGWZ6DHSnrjmm2vyrydPtskzHU7izP0/3Pvhrt9micWP69nV0uN2B6xR+2PN3BiokY6agooyocOeh0hOHkyv1WKqdSi92cv5fm6Q4738CYqpISnkbVYqyqCsCprq+K6VNXR+xefdFC7VWPQWWNtYjfh5q16FfbBTfUlps5Q90FzKvbi/3qN+Hz+lW4tGGF+LRReLJxJY5oWotlTRtwbfMWTHXvwQvuq/haiw/nLGyZiNMkl/BfSXuuO1z6BV6QSllPF6/J+JPXMdTI6vGcrCdrzpT/Dx/KD+Mc7wvo63MVD5DF/BaRwvwueVzoJ4zwF+NHPQ7hTZnftAAxfyVvytQAWczvHlnMXpDFPBmPW0LEyMuhYs710Jv4tuIhuhWluDtMzvPUhrfDP8PH4uSIHVgeYcSFkXqefH3kdvwoqgYroiayL9Ojr2FBtIZdGxSTi/kxIexmm9jluD22DL3ixrPX8+Ju4n9xr1IJg+MPYX58NBXSNmElfpHgQB/lJOonW3kbTcruVNeIxJ/wXGIiVfdS0kbckdSMXsnvUZNzk1/go+TXqNieKbfxQMoAKtlb9RtOU/Wiwi+pLmOsegD1/676Lh5TT6EvytVVmJq6nn4Znqqmg+amnsNPUsfSWRtTXbiVFM7TfUYKi0y8gV+QwiJ5JZJM/ZekcKZ+Nymcqd+Z+g9+nvq+V6Z+W2qgTPg9fpbaR56p3576zOMSb2G0j5h5wkd8OsxXWOor5q/2E8cqf+F5j2MDMvVbUl24NnVLYKb+o9S2QZn611PPYuvUgcGZepP6Fm5TDw7J1OvVV/AflSE0Uz9H9SPKVEpFpv6LlE/x5ZQGPJ88MyxTPyL5Ab5I6hOeqZ+fdAy9kpIiWFviRmyd2IC/KmdGZuoHKR/ik4S+UZn62QlHsCE+IjpTvzL+PfSOP43L4hxYFhsZk6kfE/sSniaFM/VJMRn4SXQvtJDCmfohvB1n6o+Swpn6iEhxvDBCjD8N74O9SOFM/bdhQj+PcxTCu6HiU53H3SFipDlYnHNqcE+8FtQD2weJa20OFDoDuuHrZHGm/iwpnKlP9rjST1jsK8aH+oo5x3zE2SJ9snCJ93I0y89gllwSm6n/QzYIe8p24WkvF2Z4jYvL1P8u/Q1HS9vGs3LJWpwieYYvWl5OyNSPbZmJf7i3odZ9CHc3n0R302l8q+ksXms8h+09bm4QVtUL3/B4tk6Y7HFVrbCk5gwOrTmBx6pzMbp6Of7PNRBtVTKcUvULayhwvo2vOQPxfuUR1jm2chC+cLxg/XMd2dhc4YubK3aLJ1PRHk+Un2UH+5cPxUf25+zyu/b5Yq9tXrjR9jk1kGxrjSfKfqU2+pYNxn+s/1I5061zsa60hYraULoNE0pbYV7Jr9Rb95JB+HfxE6pxavEcrLK4qdJVlm0YbUnF74t+poYNRaKeb5ofU9sTzbPRXthMzX9cuAnDCxPwsOkAvTDApMIK4w56JM/YQtd8YpyOc4x/0EfTjK/gW8bP6K8pxho6brJxPE4yXqQH3zSmysXxWnpzqrGMbn3bOMLjKakYiZWKOcvo6/HGFy2Z+nHG/jjBeNgtzhOM040LmjP17xsfNWXqc4w9cb/xp0aevDEVU0y5DZn6bFMrvGf6qZ6uLHwVcwtv1mXqg8wTcLHZXksdmj/G14vC8PeiAzVUi0WH+yzXqjP1ocVjcVmx1UVnFS/DcSWheKNkX1WmPr1UiwdLrzrpI+vrmGMtqeSZWJfgpLJgvF2215Gp72brjIdtv1Vk6mPsr+Eae0l5pr7avgSnlQfhvfKv7dR5RUfMq7hoy9THO0bjekdhWaa+lvdiZlZ6493KL6zMdL6ER5xnSzP1yqphuKHqeQk1UDUPZ7ikeN/1eXGmvk91WzxRfc6SqU+tGYNf1DiKuLvaXbildiTG1Skxr67OTF3Vm/FZ/WNc3PAAoxqFxxsf4rAmMV7S9C+uan6OKW4rnnX7cIaslu5oaVmPcyVFWCYZwhWnSk/hfWkcKxnilY1/eF3GUTJ/1vlUNlysWb4Ba+RHcZP3JWzHu3Cm/ir5y76TvJn6Ro9f+Am1/mL8b38xZxbJm6n3IXmpBN6FM/U9yN9M/eMgcZ4PSd5MfViIOP4pRHw6iOTldyb0MX6scGJcWCzP8FjYEOwb/ineDX+MYyO0POdHETtwZGQzXo2cwS6kR93DQ1E92KPY6DxcE53A3rmi1+PUmFq8EzOdne0Rex/zYvuy73FxJ8Tux6moB1fcZnwrvgnvxr9LtfRKeIRHEwZQS0rlz7hBmUqN1Sm34YzEFryfOJcK7Jv0FI8nDaY+k5PP4KfJL1O3Ncnf4JQUBfX8R8pq7Kxqwh2qj6j5alU1jlAvphf2q2V0R5l6G76U2oauGZt6ERemjqeb1qRW46bUbXTZ1tSObpGVN9wiYae1iLSVSMz66SSvWT+N5DXr3+L916yfzPuvWf8m77/CQziJ918x/gKn8P4rjPURI6d8xKcjfYU2j+v8hK38hZc8Tgww6yfw/mvWj+H916zvl9oxyKxvn3oVpamvBZv1f6iNuEo9I8Ss16ot+Fg1JdSsX6R6gGGqTIVZfyjlNGaktAsz6/9K3olTkuXhZn1l0nxckfQcI5KGRZj13yaeRV3iS5Fm/XXlFzhW6R1l1pcmzMfFCU/RJ6F7tFm/KX4b+sffxWVxbrTEJsSY9cNiO+AJktesj47phkuie+KzqD7Yl+Q1678nec36gEhx/B7Ja9bfI3PNer3HL8OEboXwLY/XQsV323vcHCJGnCSvWf96sDjzGd5/zfokktes/yRQXNFC5pr1gz0eIXPN+nCPH/kJn/iK8R6+Yv5+H3FOH583cI73J/hQfhkHyn1jzfpzshGoke3FH73qsYPXhDiz/qT0DKZLw+PN+l8kb2JHyZe4p+UG+rcU4Ty3Cx80N2LXZmmCWf9NkwylTXKc3iiO/2gQdmwQI9vqhdV1wnEez9cKVbVeuLrGzXlKq504rPpfPOk6g/Guzbi6ajw6ncn4lvMpa3tQuRFHVHbGO44/Wfl4x1Qsrqjm7hZWrEW/ihj8qvwQe/dKeVe8ZL/F/o6yT0KTrYLdz7bloK8tDHeXfUtttC/T4xnrDWpmqHUcPi+1UlHzSpejtFSB20r2U2+pJVr8ufgqdTiw+HV8bCmhPmdZlmJjUTBuLNpL9SYWdcGj5itUdS/za3iv0EK1Tyv8CGtNctxk2kgXvGQKwHvG/9EdW4wl9Ms043AcbjxBB/U3RmMf4xI6q5fxGb3W09gHexi/kwsD5GL8PZmYc48+7WfUe/ySzu1tdNPL3Y1vYTfjtRaz/lVj+xYxstkt5jubzfpBxjfwDeP5JrN+gfEl3G/c02jWlxiV2MO0r4FdNrVHWeGv9Wb93MKB+LiwoM6sH2B+F0+ZG2rNenXRRtxWlIQtvPnSBZY++J/ln2rqtnga5hfXuMz6NiXrcEdJPPJeVMV1S7vji9K/nFSCdTKetVZWin1ZVSn2KAb9bYcd/ALYXkWL7VaFWZ9ln4xXePPlV6J8Ne4vj0JFxUE7/VuhR2vFDRv97hiP1x1lZWZ9WuVS3FcZhKHOPVazfrmzM9qcV0r5Xap6DW9WWUrMeoNrIX7n8seo6j3F1GS1Duur71iojZr30VoTg7Nr/yqizmu/xHV1CzGl/i08U/8Gvt4wGp0No3Bzo7B9UxZeaxKfvtU8Ft3NE/BL97uoa9mAt1uu4GSJgvNbJLNxuvQ2PpN2YA3jvT7Bf71u43RZJCt0yMbiMvk2DPY+iQe9L2Nv0pZdIG35rSNnuRc/4XGPw/zFeKm/mLOatKU3SVv6lLSlZ4PEGaqDLuK2YGHHEDHyR4j47vTQByhRVOJuRSLPrVPYeLwQ9j0OCG/B6+FTeba9Im7iyYh0nnlq5Lf4eaSCHZFFLccPosrQFDWe/RoR/Qeejzawjy/HHMQvYyLYZf/YT3BhrAOLYidTA2PibuPluG7URqf4w7gnPpbKCU5Yg0sTXE7xC/92lfi1v4PXlD1cIgXyXCIR4qpFOqzFT5Kqq0VqTKNWJyf/g7eT+1DDr6acwO9SWtWJxNmFi1WhVP4z1afYXR1ER2xX78Dn6jZ0SmzqeezOG65ZP5I3XK7LG65Iug5ukXo33CJPp7WIbJVIctLd6q+xWW2Q5qQ3qu9jnXqeV056tTpIJjyMNer+cjFu9LjcWxjnk5Neq/7ZR3w6ylfMtKNLvd4vJ71K3cY/J71S/RuWqycF5KSXqhvwhXpHYE76XXWnoJz00+rr+IX6zeCc9FnqcuyiXhKSk16masHdquWhOendVdX4OOVdRU76/JQn6JMyOIxPk/OxfXKb8Jz0s0mf45AkaURO+r+J7+N7if9hi3JwZE76VmU+pihbR+WkH0vYij0TavFm/OhovhX/Nf4Wdw87x9XgrtigGJ5GTAK+FdMKr0V3wPbRGtwcZUBnZAa+HtkDz0T0xCSPn4QLLWG9cDA5m5N+RNEXwxX98MPQ/vg4RNg9ZADuCxbH3sHi03eDhLcDxfwuHncECOv8++BEj5f8xEgrPzFzna/4rs1nEI70eR1PeX+ISu8fcb28HJtkabE8N9kytHjdxqlerePYBekSfJM33Jz0e5I67CVJjM9JP9yShiEtPXGBuy8+bB6ArzYPxj1NQ9DL44xGMXKzQfiKx8/qhTV1wnEez9cOQlXtQFxdI85WWt0Nh1W/gidcCRjjkuGyKgtrKHRewqHOzZhfOQRfrqxhzYccO7GjoxPmV1zlvgZUiPt9VF7Mfr1bvhgb7YG40b6HnVXaO+NPtt/Y9562MXinzEI9TC1bjE5rIK60fk3NRFlfwe9KL1FL6aVj8HqJhRobW7IQrcW+uLx4FxUYWtwe91nOUZkay3C8UvSCin2taD5azF64yPw59RxoboXfFJ6izjsX9sWrpr+p/Imm17DJeIeOOGzsjbONP9Ap/Y2hqDV+QO+8bHxEN7U1dsPWxr10WSujDFON78jF8U2ZGH8F2xk/o0NfMtZIxfzxUvHpBbo4xajGJOOalpz0ZKPVnZOuNg53i5knmsVVYnCgMaeJHjFWNuak5xnnYovR2ZCTPtm0DH83+WOnwl31OelfFbZDP/PpOqrXPAiN5se1OekjimbhuaLGGvrCshF3WZToXZxXTb0VZ+Cz4tsu+qtkEp4pcVSx5tIc3FkahjLrPmdO+vtWDf5nvVrJvpe9jufKrA6eg20ZfmkLRj/73oqc9IV2LRbbr5WzO+Vj8Xp5qT0nPa1iCe6vCMIwx15bTvoKhwYdjitlOemTKrPwVqXFmpPezbkEf3QGY0LVvlKqpSoNm6qul7AXrvH41OUoFvX5KV6t7oi9ax5Z2Oua9Ti4djA+rk3E9+q80K++qign/UB9GfZsKManDUW4qNGMkU0WPNZUikObrVjSLI5XuW2Y0tKIZ1vE2bIkWVgk2SvOLHWhU5rJ1T/02o7NXo9xvSyJFUbJp+AB+Weo9z6Cd7zzcY7PWfTzPYff+p7HXn4X8F+Pi/zFSGSA8JjHYYFiZqnH1UHiu6pg4flgMTKObOX3POQ2bgu14MuKCJ7VJUUWDg/7Du+FyXmSI8LfxWvh99EQ0Yen/X3EMYyKTGQXVkeux5rIanwn6m326GHUPewX3YsdPBF9BFUxCezs1pj1KImtwfdjp7Pv/8X+g0Pi+lAVp+OOY9v4FKplR/wWlCU04/yEOdTSi4QnOFyZSaWdV/6CLye2pgJ3J36OfkleVOZHSfPRnPQCRyePoHovJl/EDimdqepdKfvRSxVNtc9SbcHbqhC6oB2pynfVremR4+rz+Eg9tklkmatJpNvWZpF3HdwiB2+4RXpOaxFJKpEoDVtIVaVhM6mqNHyq/gfXqd/3UhpWqwNlwu9xjbqPXGlYq37mcYm3MNpHjB/3EXOG+SoNK9WlmKNe7ac0LFWn+CsNH6rP4Vz1GwFKw1S1E0erNwUqDd3VbYKUBrX6AraosoKVhgcqC+aqPghRGiapGjBUtShUaTiV4sBRKdMUSkNp8n1cntw3TGlQJB/HfUnJ4UqDNmkjXk1swNcSZ0YoDcXKh7hI2SdSafBTHsFdCXFRSkPbhJX4c7wFM+K7RSsNZ+KWY8e4PNwdewulsYU4I6Yab0XLY5SGLtHhuDMqCRsi2+HkyE54JSIN20ak48bwrugI64ZZYT0wX9ELExV9cEVoPywiT5WGQeSp0nAkWBju8aMg4ZNAYQ+PBwKEvh5n+w/Ev/0yMc1vEO7yHYxNPsNxis84/N37I+zgfRh3y60YKO8YqzR8LFuAVV7ncJaXf5zSUCgdgWOlq/B3ybfYUXIKP2s5jbVu4QSPF5vPYmrzBVzbJLQ1nseRjefwVIMw1uPyeqGxTti/TnzrcK04Q0jtr7igRpz/YfUxfLX6B9zr2o8y1xc4s2ot3na+j1pnJn5dGYqBlb+x5lWO6ejrkOLWii/E86xoL55e+Tl2p1f5CLxrN7GbU+0fYaXNHz+xfc2OR9g64bdlv1EJaWWv4e/WYirkdetiLCkNwsWle6ki/1It7i75nep6ueQ1vFBsEVVXvBDNFn/80PI1NelreQV3FV2kVtsXjcLzZiM1PNK8AAsLvXBh4WdUeGBhCuaafqTmXzV1wqfGH+iFDcZ4HGH8hB7paCyhXxKMQzHCeIw+CjVGYbBxMf0VZPxPLuzt8SA9GGIMkIk579GbCuM9qZipxwDjV/Svj7GlRWnwNr6NvsbrbjHeAcOMW5t5bsaaJp6DcSpONj5oVBr2G8dgvfFpAztuegevmGrqlYZXClfjl4VR6GM+WMcOmtPwmflqrdIwuCgLfyky11Ablg9xi0WOjZbPq+maYjXeLT7popJL+mFeyYMqpSG+dAauLa11Uo2la3GKNRZvW3+opBPLuuOPZXcczLS9jettrgqq0bYWZ9gT8JH9WLnSMLC8L/5Sft+uNLSumIGfVzTYlAYvx2b8wKHGQsepMn5nKgfi5cqnVvrX+T7uc8oxomp3KXVV9Qq6qi6XKA3TXK/jQ1dFMXdXvQ2vV/fGoTXNFqWhoOY6zqr9BiV1K/HLug9RV/8+3q2fg3MaZqNf47v4beNM7NUkjp82iU8XNotPI9xi5KhbfDq4ZR5aWtZgjuQYRkvteFCq5bpdvBbjOa+zOEjWjA9lvVjh2/LFWCXfgxu8j2Jrn5/xss+v+KZvPtb5nsbtfmews7/wlsd3AoSyQOFej92ChA89LiBPqa6QS/hDyJ/YP9SEz0NDeErZipEoDTuIK8N8eIbNYXNxQXgBFoYPEE87QjzzSxEqnn/nyI24L7IGI6LeYo9WRt1BZ1QP9m5KdB7+FR3HnvaIWY0/xTgxMXYK+/5p7F/YECvq4Z24PLwfl0Cd9Ilfj0fj6zAx4R1q6dMEUVf1CX2psXeUx/GBMoXa65O4BY8lujExaS6VuSHpX6xNGkrdTks+j3eSX6Geu6Xk4sEUUedBqk34niqYLrih2oER6rZ0x2D1RZytHt8kEq0aV6i30U2r1B3dIgFvuEViTmsR6SmR5Bs6kKT5hpdJ0nxDO5I039CaJM0n6QJl+QYVSSrsI883pJKkwiXe4tNoHzF+HBNJ0nxDLEmabwhVr/LLN8jVyf75BpfqND5XjQnIN/yusuFB1crAfEOOKi4o3/Ca6idsreoZnG8oT7mNR1NeD8k3TE8pwNCU0aGMJF/HzOSuinzDf0mHcF5STFi+wStpFW5PrMI2iVPD8w35yjs4RNkjIt/wb8JhnJ0QGZlvaIj/H66LL8Ho+OFR+YbcuB8xNa4Wv4rVRucbAmOn4sKYNfg8+jscGH0Vj0Q9x6ioGlwS6ReTb3gREY39I1R4OPwlDAnvhAvCdPhQ8Sp2U3THvaG9URbaF98hQ/MNf5Kb+YbOHrcHDcS6wEyc6PFywCBs7XG9/2C0+w3BUX7D8Bff4RjvOwr/5zMBC70/wEHe+/CU/Ln4rlwVm2/YJXsLA2Tf4nIvCzqkSXH5hsnSfnhD8jp2lEzEz1omYI17LI53i/ELzeI4tXk8rm0SljWKkRGNb+CpBmGsx2X1Yv6LutewX10WHq4djcG1I3F+zXB8UD0EX60ehHtc/dHL1QtnVKXjn8622NkZgF9UPmGdssoduMjRA2sq/uWOlldko3+FePK7y79iF14q74Sn7VfZu0z7WCyw2djZmbaPsa4sQux12ffsfmzZq3jIepuq6GqdgjdLRbVMKF2L1pJ4XFqSR0UFl2RgbvFtKk1bPAl/t1RSgW9YVmJJUSQuLTpIfQYX6THXfI26TTO/hjcKi6jniYXZWGmS4jrTp9R5qikYrxnXUP+LjdV0RB/jRFQbL9Mj4cY2GGjcQO/4GMvpJrlxNMqMv9JfXsYEjx/LxEghnehtzPQSc/LoTalRgc0vsunZxhePW6jwF92x6cU+d75BYvRGX+Os5nxDpPFOE91tzMDxxuON+YZ9xi7YYDzdkG940zQAr5nu17MLhW/jV4WVdazHnIPzzSH41PxNbb5hQFEHPFF0toZOtwzGdZaC6nyD0zIDJxZXu/IN14tXo7YkGveVfF9FX5QacGnpDSfPsHQsZllLK6lz61LsXBaCe8v2Oeh0Wxout12ryDfYbONwor28PN9w274Se5TH4JHyH+xcvaI7bqy4a+MJVLyD7zuayqhDx1YcWdkKL1eesbIS50g86LSUUglVy3BDVRg2Vn1Xkm+Y4+qBL1xPi/MNY6vX4NPqATizJhaba+os+YadtYXYue4R/ll3F9+p/xtlDX/h3obb+Grjn/iw8SYuaBLHIc1i/HDzLezvvoFG9zVc3iLmxEoe40lJPQ6VvsS1Xkjfwvlee1Aq+xe3yhJZW6J8AubJP8Ve3t/iE95G8w0f+hzHMN+T+JPvz5jp9wua/X7FHH+hMiAf8z2OCTyNFaRnvuHTIGFb3kDzDb8FX8JJITexIeQZbg/15vm8rOiHpxW7MCOsAX8Jm8qTbB/+J34dns4TDor4FpdGhPH8yyKW4puRRfh35Eh2p3fUOTwe1Y5dU0XvxK3RMva0JXoevh/zLz6LGcyOD4vNx7OxbaiEl+J24BdxcupEHv8Bzo834bP40VTRkITLeDqhE9XVRrkHtyuDqT1p4nJ8L9GGTxMnUpkDk27jyaQeVGxS8lFcn6ymkp3JO3BCSiB1fjllDapUvtT/QtVneEHVmr5wqC5gELmZb4gjNzkDuSkyrqNbZOINt8jHaS0iKyWSrK7/qb7Gf1Xp0qyuj1X/4APV+15ZXe+pAmVZXe+qvvPYRy5GnsnF8RLvrK5/q6J8srreVB3H31RDfbO6/qwqxgOqHL+srutUsf5ZXd9RHcHuqj4BWV2DVPfxfsrbgVldv0hx4Gspy4KyuipSvIOzul5L3oAfJgeEZHVNTF6F55Ia8PWkOaFZXW2JT/HjxMGKrK7hifl4QNk2LKurXrkT/0jwCc/qOjHhAyyPf47L4zMjsroGxB/HL+ISIrO6to5bhcdjLdg1tmdUVtfTMZ9il5hbeCDaJzqra0R0Bq6Ieg/tkV/i2MhLeDniGbaLqMHN4QExWV1dYfE4LqwNnld0QrVCj2tCu2FZSE8cEdIbTwb3xZjg/riMN82sri9Iyayu/QIH4aGAwRgcMATn+w/DB37DsavfSNzjOxq9fF/HGT5T8U/vZajxzhOfyksxRP5SbFbXHNl0rPTKxSleD/AvaTOmS8Pjsrp+I4lHL48zWmLwpjsCO7nFp583R2JtUxROaBLjlxrDsFWjAtc1CG31oTiqPgR/rgvCuLoAXF7rh6YaHxxQI8cfqr0wpLqFq3/gasJHVXXYraoSc52FKHfewNmVu8Snjiwc4mjmXm5WfIWjKrT4X/kNnvac8jex0e5kjzbY12GsPRG/s51gH3W2Afh72VN2OavsfSy0yvAD605qQG5tj9tLL1AhrUpH48n/c3Df0U3WbRjHu5vumTQdSVpllCHLCrRJ05QtW/YQKTLFAqKAslU2lCECVl5AlCIbAZGNgpQhgpYpoAJPkjZpVtO9Mt7v4z+fk5O2yZP7vn65zsM5ai4lOb3MC/AvUxDONH1FrtxlbXBz2UXyllY2EH8s/Zc09imdhU+NblI6y1iAfsZk/MpwmPS2N3TDa/pfSfXb+n7YLNwg7fuFLJwsFHEKugmhmCrM4VzECw85KRFCdwwRdnGCggQfDBSmcqYChN/8RV/zF5/5wk/8aR0n0V8Yhz7Cz5xQ18tXsPnlGq+o1TMi0/NyiEf8q9NuzpeQiCnCp64RmRqhonlE5jzhPfxVsDWNyFTp5+NKvS/a9JsbOX2GFPzFcKiBbBu74hfGa/W8svEtnFL6oo4Ulc7C7mVNtSMyvy1bjaGmePzI9F3NiMznptdxgPla9YjMc+YR2LLcWMXrlM9Dd3kgzrTsqByR+cTSBvtaLztHZJ61DsVWNn3FiMzttvkYYA/FBfa9jhGZZntXHOu4bScPjncwq6LaNiLzSMV6VDrT8AvnWSuTqRyI8ysNFv6qcjGOr4rDP6uOlI/I7FndA89UPzGPyGxT8wHuqgnDuNofTaSidg6q6nrg6bo2OLg+Gcvr43BVQxSmNkbgpcZwHNMkWtMUipubg7GdS/SmKwQnu0U97iDc6fHFrl4fvO8NwFk+4mtKfDvht77jsZvfZrztdwvH+wdxVRb/3vgJ95gjMsMCd+K+wIOoDTqGz4J+wPnBJzFG8iMek5zGN0POoJGu5BuAlmT79CO7CLuIw8MvY0X4L7gh4hq25u6SPNCSIzInRPkxn5qobFwZvRlDYhy4ImYkM2yM+Rnfj23DhP+N3Y6D43yY/C9xM7Fz/AMsitewHZn0e1wrjWVrjdJlOFNmwaey0ey0X0IxnkvozMZby7/B7fIIkuCfuATnJlrxeeJ4cjIg6TaeS8oiRS2SD+MXyYmky528DmemNOBfKTPIXk/FU/xB0Z9kJikv4UplBxLrUH6Lo1XxJPmKaj22SvUl4etTl6Ep1Y/kZ6ZtwcW05IjMA7Qkv5k2jvPye1qtS2y0L9xix73mERvwN4/YhlO8YjP6+Dgzv6IlnZk70rr7OjO/THuIm9M+8HNmFqSF+zsz16cdwHVpPQNEX+CatMWBzszP0xKCnJmfpJ3C6bSkM3NQmgHbpH0icWY2pYaEODOvpu7A5ampoc7MrqkH0KxqF+bM3K46jjpVh3CeUR7Djcr0CGfma8q9eFshjXRmvqtYgw0pDViQMj3KmalKeYwnk3tHOzN7JZ/Gx0ktYpyZM5O2YnOiBzckzoh1ZsoTS3C/PCvOmdlFvg9/SQiLd2YOSJiN92W3cYRMKXVm3pPOxgHSC3gt3k/mzOwe3wMPxy3CxLjDuDL2HjpiqnBkTFiCM/NitAJTo9viqqguWB7ZHQdFavBkRA5KI3JxUXhPfB7WB3vQj87M72lGZ2Zo6ECcHTIY79OJzEcyHHcGj0RP0Fh8N2gq3gz8FF8L/AHFf4N1ZoYEtJY7Mxf656HZbxuO9LuCV3z/xVa+VtzgU4EVXjsO95bjWU8pJv/np24TGl1l2M9lxKPNAkY3v8R5TaJPGp+jpvEf3NvwDAManuCM+sd4p+4Bdqorwe21d7Gx5jZOqLmJV6uvYcvqS7iu6gd0VIrXOaJymnidzjTMcN7ms5yqmIGZFT543bGDCQ9ztMeX9mtsZJZ9HDbanOxrjW01Sm3JuM96kp12tvbBK5Zn7HqIZRa+KPfFOeU7SILH3BY3mi+RE6V5EJ40/Ut+eplm419lPvhe2Rekq7n0FdxUeorspZXm4hljCZnsb3wHXxqsZHWBYSGGGwJwv34jSdbpo9AorCXhO4R6Mj9BmIhZwnVOQWuhDSqEjZyOBKGS8xInjMJo4QInKFJQYoTwub9omZ/4TH8/8fFxTl+IEItBwgJOpb/wzOvM9BO0GCB853FmSoRgj/j777vJOfePzsz2QhYOF440OzO3Cq2xVDjS5Mzsqc/Ag/qfG/l9Q/9G8VM8anBm/mvIw95GW70z85jxE5SWBuKy0i/qnJllpQocXHawljmUZaDS9GuNM3OtaShWm15WOzMnmj/AO2ZfzCz/ooqZlKdirOVkJefd0hPtlsdOZmKdiXet7gqyZNuCR20tUWm/6HBmbrEPQ3+H2c61OZaiyRGHYysO2/irih6Y63xmdWb+5PwQ21SG4u7K7yy8V5UG11Y9LmfXVXPwo+pgNFXvNTsz367R4IOalyZn5lu12/FZ7WScXfcmBtdr8Lv6bqhteF38aUMnXNDYEWObOuDxptewf3NbLGtOx89dbVDpFp+54BafGeVpgZWeNNzoFW3j0xqv+4ivnOc7Ght9V+Amv7OY5l+Jp/w7cG25AdPEKwzYhDMDv8WAoEO4N+goaoKP4xOakfNIM5KckJ/wKJ3ozOwbeh4NoRdxedhlTA6/gmfDr+HwiJtYEfEnboh8ga2ivPhzVAbzeSv6M3wS/S+OisllhndjDmFubByzPR27BFvHleHOuKHMPyL+HH4Wn8peauLX4QxpNT6TvsPuBspu4yVZN3baPqEIdyXEsPEw+XJcJLejWT6ePIxK/B2vJWaRk05Jh3F3UjL5CUnegPOSXfgyeRYZG5jyL55LGUz2XlVcwU2KLmSyQbEfJykTyept5UbsovInyYWqRehW1eKE1Hnk/GyqCwPSCsh/TtqrzWJDXcYlaWM5KavSalxil23hBG1Ia+8R++6WR+y+KV6xB318CrKG0IkFWYPpxIKsAXRiQVZfOrEgqyd3jgVZuXRiQZaOTizI0tKJBVmZdGJBVqc0WVBBlirtB/RP6x1ckPUs9S8sSp0iKcjKS7VhXOqckIKsX1QVOE2VH1qQFaIy42Hlu2EFWf2Vf6NZMSy8IGuF4hYqFOqIgqzTKcexf4oqsiDrRfIW/CjZi0HJs6MKsr5O+hfbJQ2KLsj6OfEiDk1MjynIein/EufIXehKmBpbkLUu4U+UJWTGFWTtk+3FjrLA+IKsc9JpqJVex1/j06QFWb3iF+H1uD8wNy5ZVpB1PjYPO8Tuwj0xdzE0pho/io5MKMh6GpWK2qh2uC+yCwZHdsP3I9T4Z7gWM8J7YGFYb3SF9sM87hALsoq5QyzISg8ZigX0YEGWk3vDgqyRwWPxfFAeKoLm4ueB29AS8BuODgiQF2Td9NdgV/85uM9vF0b4XcL5vnfxmc8D1P7nd94SDPLewZme3/AP923s4v4dv3KJzzQ3X8eJzcV4rekatm66ihsaf8GKBvGVhzecx7P1ZzGl/kf8tO4EGmuPYr/ag3i0pgija/bivOr/4dOqLzC7apl4JZXjMbTyFVzkfMRnqapYiPMqpOh2HGOq6xy9UOr4h/l/a5+P7e3heM62jx31tmXhfes9NjjROh3tFhebXWz5AkMtLfHr8gvsPb18CJ4160lFX/NH+NTkj7NM28iMj6klbi07Q5ZalPXFs6WPSdqA0qn40lhNAhcYP8NwYwTuM+wkn1mGlvhAf5zcztF3xhj9MfL8s6DC5cI6cj5SqCD5WmE4dhbOcSLShRR8VfiUk6ISjJyaFKEfJglHOU2JQvR/zuOUyYWnnDipkI0xwrecxEghECOE97zi47uegqxYoTMmCDvcBVlKocnFfIRJ+KbwR3NB1hKhF14XrjXxLvp+uERf0sjZ0Y/FXgZ9Q0HWIUM+Rhrr6kmL8TP82xiOPUu/quM8lqZhdNnRWiZQ1g2fl12rKcjqY3oLT9CDvLJ5Dq41+2CNeUtVQdYkerAg6275iUqmZMnFg5aHTq7TOgPXWJsrCrLqrZtxBj3ILmyXHAVZg+zD8YrdaueMOD7DAw45JlWcsBVkbarojwFOo1VMy1KscCbg1MpTloKsfyoH4/Cq8vKCrNtVKzG3WoVnqy+YOa01o/FAjctUkNWy9gQeq12Curo8fFo3HOfVD8Lohv54tKEv9mvsjcbGnvhpUw9MadbhuWYNDneJVriycYNbfNzak4nXPG/gRO/r2Oztil/55GIX37F4x3c5TvY7jg1+Rlzvr+LakgPEKzwasAJ7BP4P/wkswo9pQ74tg4/gD7QhmZScRBN3iHwP0IPsPVT8jBdCL+OosCtYFVaMm8JvYtuIO3gj4iFOijSgK9KHyeyI6oxtoz/B09ElmBHThRkejynEFrE+zLYwdgaGx5Xgp3HdmX9N3Df4Xnwwe3kePweHSf/CG9JcdpcpO4qHZXJ2mpSwCtcnVGJTwkT2/p78Lv4l15CH3olH8FRiMjlRJW3ADUkurEuaTYomJb/AO8lixrqliHn7NuUNshemOIjzFclk8rliM/ZRBpDVY8pFGKeqwo9V75Pnpyozdk3NJ+frU+uxJHV9k9hHr3AiWtCDBVlv0IN8F3FvKLbYFrfYa+09Ysfd8oh9N8Urdp+PT7o6gB5MV/vTg+lqH3owXe1K/cAvXd2QGuGfrq5NPYTVqb0D0tXOVAEtqUsD09X/piYEpauvpx7Hb1Jzg9PV76XewRapwyTp6geqB7hINTQkXa1Q3cZLyp6h6eqxyotYq+gSlq7eojiIbRSK8HT1rylbcGyKf0S6uiJ5Pq5KNmFS8pjIdPXxpFuYm9Q9Kl39MPEATk+URXOF8pW4Tu5EuXx8TLr6QMJ1zEjoGJuuviorxMEy37h09TPpDJwqvYuO+M7x6eoF8dvRE1ePq+JGS9PVoXE/4obYEFm6OiR2DH4eswvrou/j5OhGvBMVm5Cu7hKVhjsi22FzRGecGNENr4WrsVW4DteH9UIHDZiuHsadYLr6TMgQTAoZjssko1EfPA77BL+Dh7gTTFdHBH2CHwbuwr8DSrBvQIicv/XX4qv+s3Gz3w5s8D2J7/j+gtd8rmGr/1zvFZ9xeC7iMM958W/dFzDpP5e5zqLQfBp7N5/CQ00nMKLpOM5tPIKPGg5gZkMR7q7fiz71u3BKXSHeqv0S29duxC01a7GmegWOqV6Kl6rmYmrVOFxd2RkrnNV8ijznPnxW0RsnVAhMstSxGD9wxGOT/TiTX2nvi5H2l2zka9sn2NIWhSesB9hatjUbf7M8YKejLTOwtNzNrueVb0W/8lb4hfk8SUgz98fTpmfkpK9pJj4tayY/+WUb0FuajF+WHiJd6aVd8bLxGtkbYRyCNsPfZHKlYSoqDA6yek4/D0frq8mwR5iJp4UnZHuZkIMThCIy31+QoFbI5yx0FUo4HZ2EDGwvFHJe2gguTlBrIQ9bCcWcrJZCOr4qbOCsqYQKTl+KMByThLPedHWikOwVn1nuYZKCwS3+fl98TTjqEt8lDicJnzczJaGpiTkICzFb72pMV/9P/zm69BKcaNjSwMkyyLGV8dt6sm1sh5XG03Xp6lGl2Xip9EYt71I2BFeXPashOWXTcbSpppoTZPoc25tjsdD8XVW6OrC8C84tv1qZrn5ePgwHWAzOdPUFywJsYw3FndY9FenqMFsGLrX97uAdbZNxmt1lJwP2bTjE0R6LHddtJK1iIv5Q0WTlOp07cI+zC8oq/7CkqzdV5qOkKhQ/qzpQTlqqeuKH1S/MfBdVL8OpNa+ioeaRKV09s3YXumoX47a697Fj/RT8vX4iTm94G/0bx+LextGoaRqJT5qG47zmIRjtGoRHXYOxn1u01D0AP/P0RYW3F5739saRPuLzlT7iaxb4LsJWfvvwkt8DFP+rTK7KvwfOD5iLIYFb8LvAPagN2ofPgg7gguDDGCs5jsclp7A/d4LpalPIeVxB95GTsF/xYtgNHB3+O1aH38PNEU+xXaQJb0Z6cVJUG+ZTHzUTV0VfxpCYZKa3OmY5emKMOC92ABO2xJ7CvDg5838UtxwHxJfi1fiBbKeb9DQelaawu1TZatwqq0L/hHfY7LyE39GYkMnGh8sP4K9yGXnolLgKdyfWYUjSdNIyP+kJvkwaQIoGJF/Gn5I7kTFlyj5cm5JA9ipTNuBYhQ+ZvKpYgK2VdtyonCImVvkch6vGkeRTqmcYljqJhI9NdWJh6mryX5yayol4nnoRbamjOSNVqdUusb+2uMUua+8Re+2WR+y4KV6x73x8itWXUnfhxdTuvsXqc6kP8TTdV6w+mRruX6w+nnoQj6T2CihWH0x9iXtTFwcWq79IlQYVq+enHsH+qVnBxeqI1Gv4q6q3pFidr7qGUSptSLH6B+VZHKTsGFqsLld8jysVKWHFaqViK55LCQovVg9NWYSmZAcuS54UUayWJj/AI0m9IovVOUk/4cPEllHFtN42bJT7RRerN8jnYLL8bzyc0CemWN094QTekCXFFquHyz7HF1ILzpQOiStW18SfxqXxifHF6sD4pbgpTkBZXE9psXp37D5Mi/XgvphhsmK1KmYnbqf7itUBdB+fKyo6oVh9P1KF3SLT8X8RndAb3hUnh2vwZlgPbBfWFzfTesXqau74itWjQ0biRclYVEkm4IrgSWgKmo4DgubhicAtKAu8hJ8FVKHDv7W8WP22/2i86fcpdvLbg1/5/oAunzOY53MWi72nMd17Ags8x9DpFh3hPo7nXEcwxXUAP20uQmPTPuzXtBePNu7C6MZCnNewDZ/Ub0FN/QbcW7caA+rEd59RuxDv1HwkXknNLNxWPQ0bqsbjhKq++GtlC2xbaef6C2k9kuAcgJsqLMwwrmI17nKkYUvHJaZ9zD4Gu9qr2MUVWwH2t7XER9bL7CvPOhKtFht7/MQi7jTIIsdt5cfYdVp5DzxhfkwGdObpeN9UT0KmmtZiQ5kcN5QdJD/Ksm54qvQ6uepXOgyfG5+TtwXG9zDSWEMaDxqWYg9DED7XbyCrS/Vh+Kp+JRl+LFST6l3C2/ixcJW05wmtcLiwnlPwpuDgXOQKw1AjnOGkdBOSMENYxgl6XdBzproIfbCjcJhT1l6IxHThQ05fK+Gxl2kIWdha2ONheoKfR/zNaW4mI9x2cVVCZ3xb2NXMJxKi8A9hfRNZ0ofiQv3GRq5QH4tdDV81FKt3GJTYYNhfX6web3wNfzH+VFesfqVUg6tLi2s5j6UDcVDZ45pi9Y9l72KyyVHNCTUtRrspFMead1YVq6+b22CX8vOVxeo95W9imOWZk/e1zEKzxRfHWndUFKtvW9tjtq3YwXeIbQK2stfbmZt9C8Y62uJaR7GtWO1xTMT5FS4r71XxNU53dseXzr8sxepxlR/jo8oEfKvqbHmx+veqkdi7usbMZ6negZqabLxUU2ni+doL+Lj2a5xTtxZD65fj9/WLsUfDAnze8BEuavwAZU2z8VTT+zi4eQZamqfiapfoK27Rn92TcZznHazzjMetXtEOPhPxto/4t9N8P0cfWo+0+93Fjv5evOafwbWNDJiCloBV+HmgeM2KoN14Pug78afB32Ml3Ves3ij5AduE/IjXQ87hJFqvWO0O/RW/DruFb4T/iffCH+OsiBcoibRhUWQAk9FGtcNHUdNxavQZtEXHML2ZMR9iacwjnBCbxYQfxn6DA+ICmP+vce9hZvwfeCI+g+20kv5P3JfUj91Fy97HlbLHWCfrwWanJRzHvxKS2Xgf+Tr8Sd6ArybOIBVbEp+iK7E/aZmedAnvJXUkRerkfbgvOYGMhadswHkpPmTv75QF2ENhw4OKySQzQvk3fqAcSWLvK0uwi2owSd6kuo961dskvG2qAyfResXqVbQe38Opl/D71DEusa1qXGJzbeHsnKD1xEa75RHbbYpXbDofnzzNElovT7OY1svTfELr5Wnm0Xp5mg9ovTzNLFovTzOT1svTTKP18jQTaL08zWBaL0/TJfUwBtN6eZrfVL/iUlUvSZ6mtepX/F2ZHZKneZ/Wy9OEKjuF5mkOKA5iT4UqLE/zImU7LkwJC8/TxKZ8ikeSa7Bn8oyIPM2zpL9xbtKgyDxNUNLPuDOxQ1SepkPibrwiD4vO07wl/wSFBAPOTRgck6fxys5hgSwtNk8jl63FfVI7viYdFpen+Sn+DGbTenma63FLcVDcS3wU20Oapxkf+x2+jPHguzHDZVxh9C4cSevlaa5F1WP7qIiEPM0XkSlYF9EKx0V0wJ9pvTzNK+HZuIZ7vTyNNbQ/Dgkdij/Sd3mahJBxuFiShy+Cp2DP4PfwQNCHGBa0Aj8I3I9PAh6KPw0IludpTvh3w2T/SbjKbwXafb/GYb5FeNbnoPhTnwO43LsPDZ5vsK9nDx52i0a6d+OHrp34uHkHZjV/iXuatqBf00ac1rgWbzeIr9+hYRlurV+IdXUf4fi6fPyldiq+WjsB19SMRGv1IBxS3RN/rHod5VVy8UoqrVx/ufMIjneOx8cVPji64htm+K9Dg1McT5mz1b4AP7THYZPtOLtYYXsTw20GNrXDuhRTrVI8YjnKHrtbeuD18qdseVj5bHxp9sc55u1kwMfcCr80nSEhrUx98HzZY5IzqGwqCqVVJOrj0uUYWRqK3xu3kzedUYXPDAdI43xDR4w1/ERKT+q74ij9SdIboH8Vi4VNpHqHUEPOFwlj8T3hZ/I/QXgFhwurORcDBQtnpI8wGHsIpzg7OYIMs4VFnCm18Jzz1V3ogRnC95y7zkIodhJme8XH9z3i81094u/sdIt/5XGJrzYZxwp3mjlfghrPCCeb+Lz6DjhCf7wxT3NM3wlDDD825GmmG7rhDcOleuZg7IFrjL/VsRHjEOxf+qg2T3O0dDxGlhlrmH/ZbHxS1ljNNEyr8KApDmO5y8vTLDN3Rov5aiXTKB+Kv5YLTq7ZMg+/sQRjtHV3RZ7mM+vrWGP93cFkbFPxhc0HR9p32vM0d+xdsafjni1Pc9ExG1+vCMejFUesfGM4B+B3TpslT6Os3IQ7KztbxEQ9LM/TbK+ajzHVMiyovmDm+6RmCm6sSUJZrcHENddeRV3dD/h33X78uP4bjGvYiT80bMcBjVvR1LgZVzQVoKp5HV5sXoWjXSux+j83u1dgO88yvOlZjJO9C9HrFR//z0f8aTdf8dXu+x7GfL/fMdC/RvypfyuuqmPAKCwOWIjjAzdiHa3HyQr6H3YI3ou3g/fjNMlh9As5gXu41+OEhl7Ex/Qd2wn7DSO4v8vTHAp/ir0jjChEVOGSyBBmIovqgMfpO/IWfRJvRYcwvf4x0/FGzC3UxbZjwudjN2GXuEo8HDeS+b8Sfx53xivYTox0Ba6VWtAtHcbu5souoVHWms2OTPgSbyT4sPGu8tlYJP8HYxMHkorliZfRmtiRtIxMEpPzS5KMFKUnr8ctyV6sT55P0iakWPFayrskMF3xDAsUw0lmheIOvqXsR2JPKK9jpKo3SZ6m+h3PqMaS8AaVHdukriL5b9J3zJa+y9NMpe/EnqpxiZ21xS32V3uP2GW3PGKvTfGKHefj49Jk03cujYa+c2ky6TuX5g36zqXpTN+5NB3oO5emHX3n0rSi71waJX3n0kTRdy5Nreoo3lVpgl2aL1U3sL+qv8SlqVfext3KviEujU55DV8qskNdmuWKM6hQdAhzaS6kfI8jU1LCXRpn8lZcnyyJcGleTV6CF5OcOCzp3UiXxpz4AJck9oxyaaITT+F38tRol+Z1eQFeS2jAYQnvxvAust8xX/Z6LNcgLcTPpG4MkebFuTRfxP+K8viW8S7NN3FrsGWcGY/E9pO6NJ1iD+DpGD+ZS9M1ZiSeou9cmtbR93BbVA26IkMTXJp3IxPxRkQLbEffuTSbw7thdVgOjub+jusPHYypoSNxZch4NEsm4UDJdDwRnI/xwR/iJ0FL8Z/AL7BH4E94OMCA0oBYuUvzqb8aLX7v4Ft+n+A537WY4rtZ/KnPFjR6N2E/7wY86lmD0Z7VOM8t+sS1EjWuT3Fv8xIMaF6IM5oW4J3GudipMR+3NUzDhvo8fLt+LF6tG4Yt6/rjutpctNd0F6+kpiP+VN0Sk6rluKzKX7ySSoErH1B5HM8538P2TikeqjjP9NpWjMMfHI3M+Q1HIV6wd0Od/RFbuGmbi0NsEfiX9SCbyrP2RIvlbzY43/IR+lpCcWP5XracVN4VD5pvs/3u5vF422QjG2+blqCzLAxXlu0kOfKydDxeeppE9S7NwefG38jbJ8ZhGGd8Rg5/MEzCgQYT+bTq38PNehO5zdRPwEpBzPNF4XX8Sigk558KbpI/V5iEU4UbnIi3hbY4UtjEGRkiVHFq+gujsJ9wgdPUW1BiD+FzzpdWKOPEqYX+mCkc94rGesVnFnhc9OMzt0vTS9C6xVf4zkWihBD8UJjXzAaFsiaXRhAmYkf93418Rv14/Ef/dwO5NUzArYaX9S5NhWEKDjaW17k0x4yzMKK0qpbTUfox3il113C6y1bj1rJobCjbWe3STDS1wlum01UuTRdzT9xjflDp0oSWv4sLyqudLo2hfBUOs8jxV8uxCpcmw9oLD1j/cbg0ybaPcastFkPsx+2cQfsAbLSbbXwKx2q0OlritIobVj5LxQx8xxmGfzt/sLg0YytH4JPKpnI+e9UefFzVA0dUm80uzYPqL3FUTX98WROHH9ZWmHivur+xqO5P1NXfxH/qr+InDZcwvvEcnmg8jQObTqK56RiubD6Mqa6DeOk/x7i/xxr3d7jFswfbe3fhrf+c4rMXfXwP4f98xdfsxp2dS3PPz44z/eVcj09Ab9weMBNfC/wMb9J3Ls3kIPHKvUGF+L/gPdhNUiR+IvrOpZkTchJDQ8/h96FXsAd3dmQ17B4uCv8bZRHiBE5GNOLAyBhmUhbZFZdF5WN09I/4v+ggpqeKmYS7Y65gUmwqs90W+xlGxRlwbVxv5u8bfxAXxYexner4D3Cm9BEKUg27GyXbj7/JotmsOmEJHk0wY4p8FHvfIC/GRnkGqZiWuB/vJ8pJiyZpA+5P8mJE8nyyNC/Zis+S3yVjOSlPcV/KMBIYrPgd31P0Jpm/Ka5iG6WWxK5WXkZBmSPmWXULP1eNJuFXVTZ0qFaR/DCajiuh6fh2oun4bqHpxLba4habq71HbLFbHrHRpnjFdvPxKcx2qXZhs6q7b2F2g+oh1qg+8CvMdqrC/QuzbaqDWK7qFVCYbVS9xL9ViwMLs/9QSYMKs8+qjuE2lS64MDtPdRdTVCMk/FT5GD9RjgwpzFYo7+MVxaBQfkdxC30UuWGF2XtSLqA6pUt4YfZfyYfww2RVRGF2ePI23J8UHFmYrUlahPcTrTg9cXxUYXaT/DYWyLtH88ryIjyWEBXD6yQsxFsyAUfI+sYWZj+XHsHp0si4wmxH/Ac4P/4eNsd1iS/M/jRuKwbGVeL62KHSwuyI2KO4JSZQVpgdHTMaN0T/D71Rf2J+VBU+jAxJKMzOpOm4fu7sCrP9Izrj9HA1/h7WGzuGDcZtoaOwIeQdfDtkKl6RvI8tJHNxbfDHaAtahm8FrcefAvdicuA1XBFgF3/qL5UXZo/yfwMv+w3GV/3ycK3v+2jzmYND//O0Nx/l3hm4xDMVX7qnYK//POiahOGuCfhB81h82DQSuze9hbsaB6JPYx+c2qDD3+q742v1nfCLutZYW6vEsbXx+HNNCL5S4+EKV1dXobVKwKFVv+GZyu9QVTkTNzpfEefjvMvcPq34EH0r4nGV4wxzljhGY4G9gfnH2HfgV7YMVNrEHX1vnYWvWSV4xvIte8y1ZOLd8hL2O7Z8OpaZXWx/nnkLBprTcIfpJNloY8rFy2UlZGZY2TtoLrWQqOWl81Fe6iVpp4xrcJAxCi2GHeRwrSEZWxv2kM/begV+qP+K3L6ql6BR+Ig8nxGekfBCIQdXCkUkf4EgwZnCLE7EJOEep2Os8AYOF77m1AwR3JyjgcIkfFO4zsnqLbTBHsJGTlyOUOktzNYKI73i4/Me8XkF9hU+c4t/Vepi+8IAfE/4sZl5CmlYLOxoKswO00fhOH1BY2H2cX0oBhjWNxRmTzCE4llDQX1hdpwxCj8wbq1jbkYpti0trOWTlipqxZnsqynM7l/WHo+X/VRdmB1v0uFi052qwmyDaTwONlsqC7MvmBdiq/IQ3Fr+Pyd7tHTAuZZrFYXZess4HGmtcjA360bMtbXB87Yb9sLszvYpeMTujy0d39kKs79x9MTkilIrG69Yh1JnB9zmfGjhmisX47bKFiitulPOTqs+Qll1En5VfcNcmJ1UswT31eRiRm0S/l4bgFPr6kwkud6Ou+pLsXvDC3zY8Aw/aHyM4U338WDTH9ir+Ta+bL6JS1yicvcNPO2+hkM9P6PNcxHXei9gC59LeMXnKr7t+xvW+z7CL/0s2ME/jGu44Z+BEwLGYE3Ah7gpcDm2DVqD14M24qTgL9Ed/DV+LdmLb4QcxHvc2RVmzwo9j5Kwa1gUdhd13M3xrRtuxo8jXBgTmcg0jkTmYo+oj/Fh1EXMiw5nbmXRk3FazC9YGqNgtpNil+C/sf/gmDgN838QtxsHxXvxZvy7bCdHehPPSl9jd+1l2/FbmRfjEmay31UJj7E2oSd7nyo/iQ/kaeRBl7gVjyYGkBZZ0ie4PMmOZUmTydLA5Gd4MnkYGYtP+R0/TulN9p6kXMHuCg2Z/EpxHmsU3cnqUOU5PKjMJsNNyhvYSzWKbH9Kx/F56Ti+4VWpnIKnqktoUI1xid1U4xJ7aotb7Kz2HrG/bnnELpviFXvNxydDe56Oy9Ceo+MytD/RcRnak3RchvYoHZehPUTHZWj303EZ2m/ouAztDjouQ7teJQvK0C5Q/YBjVL2CM7RtVQ/RoZwgydAWKfU4TDk5JEPbpBDwG8U7oRnaHopnaEgZGZah/TzlD0xL6Rueof05+Rccl9w1IkNbm3QENyWpIjO0rZK24qXEgKgM7VuJ87BUrscF8iHRGdpg+UXckdAyJkPbImETnpDVolo2LjZDWyy9jAOlqrgM7f34T3FM/Av8Ny4nPkM7KW43lsY24YzYUdIMrSXmJL4fEyzL0JZHj8bJdFyG9q+oEuwVVYtHIyMSMrSxkUr8OKI9/hOeibrw3rg/bCiGhI3HWaFT8H5IPnYNmYc7JYvQE/wZvhu8Bm8EbcZ2Qbtwc+BJrA0owbcDqrHYP1bOT/3TcYtfd6z17Yljfd/En30G4Cs+/XG1ty9aPOJPB3t0eMqdgzK3Fhe51Pi8uRv2aO6C3zd1wNCmNji7sQXeb1Bg1wYp7qyPQE+dP06ua+RKbtY6xOusNeCWmr+wpvo2jq2+iJerDuKrVRtwXWUeVjtb4mTnUyb2d8VKHFPRFp86/mTC4xwf4T92GU60n2X+BttocQu2WrbjsG7D+dbO6LLcZYMrLdMwyuJlszvLd2Cr8tfwR/OvbL+HeSTeN5WRiimmBVhfFogFZV+SnLQyMUXnSw+TqGGlGWgzXiZpa4y9sIXxNgm8ZhiCkw0PSGagYTge0f9JYsfoe2OM/keS/FRIwVPC5yS8UDCR+dXCQPxYOMFZyBfi8V1hIadjvPAv52WkkItvCfs5R4OFEOwvzOJk9RHucdZ6CG9grvC1V9TtydD2FCZhX+G6m8QKbXC4sMlFSoWa5gztEmEiHhZKmjK0JqEPdtL/0pihXa5X4339uYYMbWtDN1xmOFOfoX1s6IadjOfqMrQbjFloMl6q5V1Ktbi39FpNhtanrD++W3a/mhyWvY3tTKaqDO2XpnnoMvnjdPPWygztA3Ma5pT/6MzQHivvgwrL3xWcUMtc9LOG4gLrfkeG1m7Nxam2F/YM7QvbMhxrV+FD+xVbhnao41284wjE/hWHrRna3yrewjedjZYM7W3nPhxYOQj/qGwoZ3pV+/Bh1SAcVd1kztA+qz6O79bMwcqaHri6thWq6mR4oS4UR9X7YlV9k4krbKjBto1OvN5oxUlNJnQ36fHr5hf4hutfvPefs9zPMMTzGPd77mOutwT/9d7DhT4PUer7FE/6vsRBfuJrlvv58Y4r/F/BlICeeDpgAg4OnIXlgQtwVdBSTAtegZeD1+EYyRaskRTilpBvsX3oEbwZegYnh/2K3rAS3Bmuxze4g8vQ/hmRzDRmRL6J7sgVuDHqFiZGy5jb3uj38dWYYtwXo2K2r9BufPfGPsOUuO5MvjCuEOPiG3BT/Di2I5Fexk+lr7C7euk6zJdV4UvZBDY7LOEWXkt4g72/Lt+H38pjyUNU4gpcnFiLpYnvkZZBSc/xdNJIspSYfBeXJvchYy+Sr6IuRUP2vkk5j+6UrmRynOIn/EnxBlmNUp7FqUoNGT5Du/H9oxxNtjNpN55XrSbzn6nSOAVf0m4Z2j20Gy1Du4kNtcUttlV7j9hctzxii03xio3m41OinUe7lWg/ot1KtB/QbiXafNqtRDuDdivRTqHdSrQTabcS7VjarUQ7VLUksETbS5UQVKJ9XXUC5aq+wSXaSuUzvKicJinRfqy0YxvlByEl2oeKSlysmBNaok1V2PBayowwXjnFgP4pb4eXaL9NfoTa5IERJdpnSb/ivKRukSXa8KTDuC8xJapE2z2xAH+XN+EE+fToEq094T4uTtDElGhDEopwmyw0tkSrlM3GA9J7+Jq0c1yJ9sf4LdgtvgIvxg2M573iDuGV2ABpibZH7ET8Neas+DgmTFai/Tl6HHaP/gaPRj3CpCgXfh4pSyjRmiPa4OCITDwV3hcTwkfg4rBJ+DI0H3uFfowHQz7FiJA1OFeyCR8Fb8fM4F24O2g/+gadwmmBN/D3gJfYOaAZv/KPkpdoXX7JOMmvBV73bYttfDvgRp+OWOl9DUd6xefPe1qhwvMqfuYWLXWl4ZsuBR5rTsSY5nic3yS+8tPGUMxu9MdvG1y8Y2BDNb5XX453655jl7oHuKP2JjbVnMeJNUfxWvVuTK8uwI1V87G6ciSOq2yJ152lzKqb8ys8UdEDO1SUM9tjji34mqOb+Nj+N/PvaF+CP9oU2M12me1csk7AXGszu7tl2YFDLZ3wWfkt9jutPA+rzHXsfbl5A0aaFbjHdJxUdDZpsbjsDpkZVzYGK0sNZGl96SxsUVpLxq4Yl+AEox+6DGtI4C5DKGoNG0imUR+Cm/SfkdhcfRUZ9tO/g/eF62T7pNAOdwpbyPxaoYZTsEgYi3OEy5yLqUIaviOs4ryMEco5QSOEQfiWcJIzNVCQ4pvCQs5aH+FfryjfnTTafk8J3ReCQ4RZbrYp3HMxZ6ErfijsaS7RbhfC8DdhWVOJNlRf08gr62fhd3pzA5PXT8G+BqFe/CwTsdrwoo53NE7E/cYXtSVarzEPx5Uaakq0Z0tnYEJZRXWJdmHZx/hvmS/2NG2sKtEeMSWh1HyokhSZu6Pd/JuTvy1/G38rd1aUaNWWNXjcosJXrRccJdqvraMx1lZrL9EW2LZjsL0rrrA/tfHu9iW41JGGLsdNa4l2ScUH6K5IwuXO6xbmXDkXV1eqMLSKO3Xt5qpFGFedjoXVf5v59qgpxGM1U1BX2wOf1HbAj+rSMLJehofrI7BPQxDqG3xxWaPLxPltqsczTVU4rNmBjmYrrndZsJW7HH91l+I7HgGbPM9xh1e0i88L/MPHgDN9zRjkJ77Cd37NqPWPEa/Evz1+SLvxrRU4Ag8ETsSeQdPxRdBsXBw8HxMkS/CUZCUODtmIlhDxc60O3Y9pYadQ/L9zk6LwR1gd7sSNEQnMoUVkfzwbuQ77RN3De1HixMZEi9P7J/oWvhOTxlSfxyzBCbFP8O/YDCY/Nm4rPoqrxLfih7GdO/E/Yh9pArv7WboEM2SleEg2hM0mJ1zAjQmt2bs7YRu+Lw8gD0/l87F3ogl/SBxPWuRJJbgsqR8pMiRdxd7JajL2ffJZDEzJIHuTU07hLymdyGSS4gR+pOhCVn9X/IQqpZoMz6HX2JFyVKPYJjZUcNdWos3irq1EO4he45PSa2If1bjEbtriFnuqvUfsrFsesb+meMUu8/HJz+lEr+XndKTX8nPaqx5humquX35OC1WEf36OSnUIk1S9A/Jz4lQChqqWBubneJTyoPwch/IUPlYOCM7POa18gSuVsyX5Ob2VDdisWBqSn3NI4cXhiuWh+TmNKR7ck7I4LD9Hl1KPQvLc8PycT5OtqEyeHJGfcyHpGY5MGhLJ6yf+iisTM6LycxITi/CoPC46P0crX45/JFjw7YQRMfk55bKLOE+WFpuf45auxJXSUgyV9o7Lz9kcvw9j433j83O2x03AhLhzWBgbK83PkcfOxK9irqA0Jk6Wn7MlehKGRH+PS6OeozUyKCE/Z0TkK3gxohumRryJq8LHYHnYdBwcNh9PhX6GstCNuDhkB76Q7MGekv14IPgYhgX/hHOCfsEHgXexW+Bz3BVQhb4B/vL8nGn+kXjbLx47+CXiVl8l1vmk4tj/vOwVn0nzJuEqjwzL3VIc5Bb/6oQrBuNdEfhJswT/aRJfWdfk5l2KGutR0ujE9xtMWFL/L2bU38fCuhvoqj2PebVH8HrNbmxTI36uTdVLsLrqPRxTNQR/rmyLrSprmdWXzhMY7MzDTyvC0e34idkudryDTfZAXGg/xPybbQNxmc3Odnxtm3CVtSOGWu+wuy2WGZho8cV95V+z3w7lnfGC+QZ772ceh3+ZbKRihmkJNpeF4Zayr8hM67JX8JfSo2RpLPdr+Tm1xotk7EujDrsYr5O9+4a+ON9wi0wmG/rgdf0vZHW+/nXsrN8rZlgIwYfCHLJ9TnhI2ouETPxS2M0pWCX44SJhGudirnCbkzJT6IBThS84QXlCLafpbWEsjhEuc8pGCmk4XFjlJUuC2ZOfM0oYiOOEE27x9+NxuvCJi2sQnjczZ6EfnhXONHEWhPQm8ar2NPKOehne1G9pIGmGMJxhWFOfn3PJEIixxhV1+TnvGX3xivGzWmZY6ofzSlfV8KlLQ7FL2RfVnIWyRGws21eVnzPR1BFvmS5X5ue8bh6Ie8z/OMlq+WxcVO6H1vLCivycdyyd8IHltiM/503rdLxqDUS1bb+dq7X1xdftFlt+zkn7ZuzkeAN/cPxj5XHFajxV0RnfcD635OecdxagtlKNxZXW8vycAVW78F7VQBxd7TVzgqov4Ps1n6G7Zixuq9Vhh7pO+FtdC5xan4S+DTG4uyEMMxsD8VGjD85tajLl50Q01+Gh5irs7XKi3lWBy9w2TPKY8YynFId5jVjxnxt8TNja14rXfMXfn+hXi83cr/G94R+PXQJa492A7vheYC8MCBqMe4NGoiZ4Aj4JnoLzJLMwOuRjPBryOfYL3YLG0D24POwHTAq/gT+FG3FwRCRzMEb0xo8j12JA1H3cFJXKxKQ0Wn7OzugbqIhRMNVvYhZgamyJ+Di2HZNXxq3FXXFlKI/vzXa2xYubipIGs7V10nz0kT3A+bLsCvG79CCOS4hn478nrMBMeTV+L59CKmITH+OSxP6kpTTxCg5I6k6KTiSdwtjk10jXh8mH8c/kdFLXLuUgrkpJJ43PUw5hV0V7UrpBcRKfK7qT3vbKYvxQOZJUH1Va8S/lStJeq1SR/2DVxWaxfUa7xCaqdomttNktNlQ7j9hWtzxic03xii3m4yPROZS70K7s7ivRWZUP0KSc4yfR6ZVh/hLdv8oD+ETZI0Ciu6d8jjeVCwMluovK+CCJ7ojyB9yu7Bcs0X2s/BcH0GgSXayyCe8qPg2R6JYrAkIlunaKVfgwJTBMoluUsgJVKV68mrw4XKJ7N7kWfZNnR0h03ySVYlbSuEh+P/EPzE/URfHTxBO4Xa6Mluhayzfg2YQ67J0wMUaiuy+7gRNkbWMlujLpRpwtdWB1/KA4ie6T+MPYHBcUL9EtjZuE3tgLuJxGk+g8MTNwScxlbIyOlEl086LfRnvUPnyXRuP1I0MTJLrsyHa4P6InhkWMxg/CZ+CjsE8wK2wNfhO6DQNC9+KMkMN4V/IjdpZcwh3BxdgUdBffCfoLrwUaMD2wEgsCvFjpHyKX6EbRaBLdBb9YVPrJ8HPfRCzzScYB//mDV3wmzivFjz3ib/7tjsYcdxQWucJR4grG/GY/LGly8foZTXX4NV0m0bkbzDip4TneqH+Abetv4ua6C1hTewzH1O7ByzWb8JWapbim+n20V43CYVVqPF8pFX9a+ZJZbXbuRn/nEFxS4WKqDY4DON/xFlbbm5j8h/ZvsNrWE+fbythOg3UdLra2RR/rLXa32jIFoyweNvt1+VfYorwDnjQXs3eteQz+YbKQijzTIqwpk+C6sm1kRvwXSKZXepAsjSrtiNXGM2RsqzELuxh/JnuPDDliGg0/k8xXDFn4p/4UiV2pfxV767eQ4Xh9A6l2Cu/gI6GYtF8V2uAJYROn4FuhihOxXRiNG4SLnJSVggqXCSs5QYsEM6dpvjAQ5wonOGWzhXicJSz0io//9ZAfIRfnCfvdEt1CIRQ/E2a7JLqNwsNmNihk42/CoSbSKyRhpn5zI6+vD8Rb+mUNEp3U0FAv0U0xfIQ/GSrqJLoQYz5OMFpqJbofje9haGl5jUQ3ufR9vFLqrOb0lS3AT8vcVRKdoWwN9jPF4QnT3kqJLsncEVeZrzhJo3kY5pWXVfANUL4Ue1lkeM5ywiHRdbQOwgNWu50Z2jbhbltnTLI/skl0hfbFmOB4RXzsuGOV6BIrPsZdFS0x1fnAwmlyrsB2lRl4stJUzmes2olXqgZhv2p/vFd9xcx5qVmHFTXv4urafpha1w0v1rXFUfUqrOR+jek1RGKbRgkWN/phXpPLJNG5uF/jSpqr8XVXJf5Jr0l077vtGOyx4D5PGWq9pfjsPxf4mDGWRpPojtNoEl1/vyos9WvEz/wDeH1FQCyeC0jF4YHt0BH4Bq4PysZWwX3wavBgnCAZgw0S8VNsC5mDHUOX4u3QjTg17Fv0Cb+AO8OfY5eICCZwI+JNHBW5CfWRT3FmVGsmVhn1CS6Ivo1N0alMdWmMOGFPTAkui23L5N2xq3BJnB4b43RsZ378N+iM92V3M6VTUC+9jWNkr7PZ32V7MDshlL0fTViISfJyXC0fTyoq5X/guMQepOXXxHOYntSJLBUkHUZ7UisyNiC5CA8kv0r2fFOKcGxKSzJ5IuUABirakdUxNJpEd1CRRYarFTewq3IMqZ6ldOBXyjWk/ZTyFfJfrPwZS5RjXWIT1brEVvrCLTbUax6xrW55xOaa4hVbzMenSPcDjSba3bdId1T5EA8qP/Ar0u1ThvsX6b5RHsSvlT0DinRfKF/gGuWiwCLdIqUsqEg3U3kCRyrfDC7SdVe+xCjlh5Ii3VOFF3co1oYU6QYowkOLdI0pm7EoJTqsSDcwZQtWJUeG8zvJ67F7cmBEke5J0jJckFSHsUn5kUW6Y4kvsVfi8Kgi3TP5NZwl7xxdpPMm7MHNCZKYIp0iYS4elj3BN2Sa2CLdZek32Evqxdvx78QV6QbFX8CSOGl8ke6tuDl4P/am+DhWIS3S/RkzFwfGFOPN6HhZkS6Xe7Qi3fmoA9ghyoB7ImMTinShkW/ghxFD8En4FMwOX4Dfha3G4LAdmB9ahPdCTuIbIZdwp+QGeoL/xHeDn+CNoJfYLsiCmwNrsZouK9KNCQiWF+ku+YdjKo1WpFvpF4NmXykO9E3AEz6JGO8jx0+84vP/0GVFOp0nCovcEShxh2G+S3y1ErqMK2l28/pf02VFOndjBU5qNON1uqxI16bhAW6iy9gLXVakG113FC/V7sbU2gJcVbMYLdUzcEj1CPyJLivSJVel4OeVTqZkc57B8c45eK8iFftX/MFUbzgWYQ9HS/zFfpfJa+0f4S+2BMy1idsptk7AvlY3W7tj+R8Ot3TFf8r/ZLPTymdgpdnD3peZv8QIc0vcYzpDKjqbeuGNsnukZULZ21hXWkqKtpbmY8fSKjL2h3EBzjE2kr1Y4yI8a2gkkxMN8zHcYCerV/QTcZn+Luntr38DX9XvItXBej90CtNJ+7/CHfJ/V+iEvwjbORE/Co2ckcPCBCwSrnJ29ggtcaewntO0XXBwvrYKw3CLcMYrmuQVn1nmEX+qd4u/2Qf3CoddnD4hCs8J85uLdA+EF01FdNlA7KS/3Mj167vgaf3BBhKlT8X+hq/ri3SFhjgsN2yuK9KpjWG4ybi2tkhnMAZjVumamiLdNu7OmGHppuoi3dCyeDxVtquqSCc1tcYlph8ri3RGUy4ONpc4i3QXzJMwvby2gtcv34BhlldxueWyo0hXaxmLs6wN9iKdyfo1Trap8aXtpa1I9459NT63dxAfO55Yed6xEqdUdMHyCr2lSDfb+SXWOnvjksrG8iJdQNVx3Fg1GWXVybi3+i9zka59zR68XPMhDq8dgbbaXFxT1wVfqW+FP9en4NiGOKxtCMcvuEcr0r3W5DUV6X5rasSpzbXoS5cV6XbTZXzzuB340G3FDzwmDKfF2MJ/9vIRn3npY8ElvnaU+4l/dZpGY4b+DWjz9+Vd1gaI7/hqoAx/CVTh+KB0rAvqhFuDs7CDpDfelgzFqSET0Dc0H3fRaEW6bmFf4P2wY/h++AP0iwhkAjsiemBL7s6KdCcj72NWlIqJ/Ro1B/tFX8G70fFM9a2Ymfgg5iqOiE1i8g9j5+HwuBK8H9eB7QyO32gXvxUddvEbcqhD/LY8g6/LlGz2oGwdJiWIG1+XMIXt1yc8wsnyvqTirvwidk3sRFp2J36P/klKUjQt6Wu8kSQjXS2St+OyZBmp+yv5K3wtJYk0rkjZg49TXiWlrRWHcb4ig/ReVlxDt2Ikqe6itOFY5WrS/pEyjfyvUl5uFntnjEvsoBqX2Edb3GI3tfeIPXXLI3bWFK/YXz4+utxFdJkudyFdpsv9mC7T5X5El+lyZ9Nlutz36DJd7mRlrwBd7ji6TJc7VLk4UJfbgy7T5XZWnsQUZf9gXa5XIeATxTyJLrdI4RfCXyk2YKIiJlSX+1vKdpyfkhCmy1WlFOLN5IRwXW5+8jaMSo6K0OX+kLQeByf5RepyrYkLcXWiHRWJE6N0uT/K/8Q+8uxo3iXhMM5IkMbocutkS/FzmRHDZf1idbnbpYcxWRoap8vdGz8DW8Rfw/1xynhdbqu4Bbg/9g6+Gpsm5XdiPsIUukyXuyM6TkaVRb+Da6KKsDnyJb4fGZ2gy/0r4nXMiRiE+8MnYyhdpsudw32ZLvdh6FeYGfo97gn5Ef1CfsHpkt/w9+AH2DH4H/wyyIgNgXZ8my7T5V4JcGGLAF+5Lnetvz/a/AJxqJ8ET/uGodw3Apf4ROJLr/i4lzcUD3qCMNwTgB+4/fChy8urdXc1465m8fV9mitwSpMZbzW+xPaNf+GWhrtYU38Vx9afxst14vW/UrcD19SuQlvNR/hWTR6eqR6AydVv4GdViWiqrGE+Qyqv4UXnKmzv1OB3FXZxqhX/w68c/TDOUc3Mt9j/h1H2XPGxrZS9xNjW4ZfWdphg/Z3d7bJMxxYWPzxWvpPNdi/vgsXmm+x9mHk86k028jDPtBhDTBL8puxL0tK9LAUflBaRpQ9K22BU6XEydsLYCYcbT5K9BkMn3Gs4RiYHGlqiV/81Wb2oD8YV+rlkeKz+CXnO1GsxTV9EzsP1EmwSZpF/i3Cfs/Cv0BXvCzs5I7cFD6emWHgXfxFucI4uCm3xrLCJ83VaqPKKjsKfhAse8XmlR/ydz9263KtCmYsTIQxwia92olmXWyYkYJD+8yZd7ut6ZyMJ1L+LR/WPG3S5lfpBmGUorueMGLLxoeFsHRMzdsb5xmO1bNnYFhWlh2qYUmlb/LP0WLUu97WyLlhQdr5Kl+so64HDTXcruRLTWGxhNjt1uZvNn6DLHIbvl39Tocv9p7wbDrWUOHS5Nyz5mG0NxbPWI3au0DYYT9iqbLrcDvav8bg9Fzs6rFZd7klHIb5R0QcvVNRZdLk650G85Xwbh1bG4NPKW+W63HerlqGtqht+XF1t1uX615zDbdyX6XLTa6fj1dq3cHydDuvqXset9en4WoMSf2uQ4tTGSPRtCsbdTb6Y2ewy6XIfNTfgXFcdRrhr8JC7Ent7HCh4rLjUK5roY8OffCrwLd8qtPvW4jo/8W9b+jfhVX8vTggQ36UxIAq3B8qxc1Aq3glqgzOCxSsMkGhxr6Q/qkPG4F8h4mf5MHQhRoRtwoNhhzE3/B4+CQ9gAvm0GN8/EWtwTeQ9jIlKYVZfR83E1OgL+H10BFNtFzMJj8ecw06xUUz+ZOx72DmuGE/EpbKd1+KX46H4F9hC2oPd7ZYewHhZJJtd93+O6zu8qbKN43g6091mNwvKEBkVUFBBGbZJm6ZWQWZBAZEyBBVkWVB2GTLL3oIMBWUUUBGpoMyigqKgAgUkq2nSNh3pzni/5/3nc52rTU6ec9+/59zXo8zHVqUdp6mG0fd7qqtoTO5DKk4kH0Oluj1pWaDeiRa1lBRlaNbhIU0M6QrRrsY3tbGk7rR2PYp1UtL4pm47HtfpSalf9wVm6Z8lvev1P+Gv+mGkOqCvwA5MsVfS+jHFmAJtiluFiZPrE6aP1ydMokK/MJVSA8KEKgkI0yovKEwukag0bShTTLBPSCkT6g7mMMVK00xMsVKm1RHsxxQrTevFFCtNe5opVpqmZoqVpkVxIitNq9Vni0vT7jLFStNOMMVK0+YzxUrT+urXYrVOFlOadkC3HQfrNLGlaa3aPXhIq40rTcvW7sRKjSK+NG29ZgN210QllKb9ql6EE9V16E+emFiatjn5LnZKNiSVpp1VnUSTSiPhd5VLcbzSiW5FjrQ0bZbiODbL42WlaQvk76JIfgWXMMVK00Jkc3Cx9Bf0S3SK0rR8yQdYl/Qjvp8UoyxNsycOw7cSd+DvCbdxQEIAj8anqErTkuJfwo/iBmNp7ARMi52DX8SswNiYrTgj+gDeiTqBfaPO4V7xZQwR/4oTI//CGxEPsHvEE9wUXoYNYS4cHVaBF0KrsH1oDa4I8aJL1ICv/99TQeEviqDw33kB4ZMP/W5hJX7hDod9Doz2CXd+v1X4ldstd/CFlt9wV7OwkkCTsKp3moQVXmv8HLs1bsENDQXorZ+No+rHCyvxvo4dvH3x07oOWFUbg8Nq3dTkPPOrNK1jzQbcWP06hlVH4DzPWepZWzVJqGqVHJ2VF6j5pMpJaK+IE64riuhLmXsYTnU30LVK1xahg66e6Cv/hZ6uKH8HJeXNdPwz5zp8xpmCF8qKyMMbZQOwzHGDnCxyDEW14wEp+tY+HofZ7aSr3jYFd9jKSV1/2xS0W+2ksdA6DtOsd0hpi8WIFywnSW+hRYXvWxaQ5yEWKwl/2ZKFnS3HSb7KIsEoy1z2QuuT++yOmicD0PXkALvG/iQS/3sylX304Mktdta/T57Df55sCwq2BErT7j0Ziw+fXPKXplmedMKyJ6t97JQnntbStOCT4a3Cr/zYwr6zdMEPLDubyZ4lDt2WxU2lac9aGxrZZdb38arV0VCaJrO9je/Y7teXpp2xjcBI+x0vGbYP9QrVuFtHbh2jcLrjUS2pdkzCXmXVNaVpO8s+wRBnNE5z7qhmnc6umFF+wVOa9l35cOziqqqi/q5PUeF+Gje4r1eWpsVUTMWVFYkYWfltRWna8sqxKK6Kwk+rvnGXpsV7JuAmjxzV1dddpWn7qz/GLjXP4uma8nL6UnsAr9e+iUPqVPi47oGT1XqPYlj9ctxVPw17N4zG3xtexWmNAzGyqTceaOqGA5o74P1mHc5tUaCkNRGPt8ai2ReFdl8kLvGHY5uACH8I+MtK00YEfVgbFK7Xi4LYNSSM/14LicB3QsUYCI0WVhKWgC+Ey/HPcC1+ENEeYyK74uHIXpgm7o8PxWbMjxqB8ug8PBk9C1+NEZ7IEbMLF8d+h5q4h3gqLpFnz4h/De/Eb8S3E+6hO6EDtZrNKYx9kXgBlyUlUs9oyTu4TnIWE6UJ1HyjdBJKZT8J1zIdfUmUz8e18vsoVrxM75Yo9mOTQkxnP1DOwCfKh/iGKoe+X1T9iF2Te5KHLcmHsDVZQ1rGqzfhNXUsKeqsWYkrNeGky6ZZjv21kaRus3Y1OrUJpPEl3RZco9OS0nu6Q9hB35P0TmZ+8f5nfglTowJb9CvIuZz5xRue+VWa9hzzi33H/BJmUKFfmEepAWE2lQSEOZUXFGaWSJSf3o/5lZ/+MvMrP70v8ys//XnmV356T+ZXfnpX5ld+esc2hvD8dA3zKz89oc38iPx0URtFZH56pf4k/qPPEuenn9M/xo36mVH56WP0ouj8dL1+Nd7RSWLy01cwv7gz8ys//QnzKz99jVYXl5/+LPMrP/2uRhmfn/6RphCVmuiE/PRvmF/56a8zv/LTHcyv/PSPmV/8OvMrP30f8ys/vYdKLclPL1YuxiylA28rzNL89FzFUXwkj5Llp78jn4A22Y+YJ1PKuZZOw/HSi/hIIlHkp4+SjMe/kk5gTlILXk5MU+an90lcil8nfI/JCRZcGh+iyk8vj9PioLie+G2sETWxI3BRzGS0Rc9Fc/QyPBG1AaVRu3Cu+BA+iDyOAyO/wYMR51Ec8TO+F34N/wi7gb3DfsEdoTfRF/IHvh3yJ14R3cHOor9wbfA2Vgdu4bDAr/i9X/iuzi/cZ7HvkrCS1h8xq/U7PNZyAiUth3FO8x6817QRBzQtxwON+cJKGqfitIZRwkrqTfh8fW/c5W2LIm80TqyrpQ6/1v6Dz9V+hztr1mJYzUicUa1Ei+cWNcz1LMbbVT3x1aqHVPt65UrMqOyOVyvu0JGMinl43a1Hs/sCXbvpehOHuRrp5sPyQpxS3hm9zgt0fIlzCEqcVpJwsGwmvlgWJCG3HJ/iZIcUwxw7SdHn9jaYZv+cdFltHXCV7SCp62FLwXvW3aTxU6uQzIHWpaQ0xOoht7csI/GI5QJJXm3piB9aVpPwtyweMm+2DMO+lnPsgq4WPba1LGF3KC129kuSJRtjLCfYQZEWKYZa5rKzRJb7wfz04JMBGGI5EMhPD7dEYpRlqj8/Pd5yy5efLrf08gl329FKVS3BFtJlmYLzLHeb89OPWzLRZTnXlJ+ean0GZ1kPNZJ8qxajbFsa8tOH2xLwsO3T+vz0BlsEZtsLvEIdwrHVvrKOjjhi8axjU21+urpMiwvLvqjJT7eX9cLXnZeq2cXOofh0ucOTn769/BOMdslxoetkFV1w5eD77srK/HSnewNOrOiFtor7FfnpEyqXoq3yGZxcdc+dn+6uWoUzPH2xwVPh4j7Vn6O4Jhc3cv7KT9fW/lqen/5l7XJ8ri4dL9ZF4CDvX06y5D2O8+o3oaxhEZ5omIHmxglobxyJi5teQ12zEb9v7odDW55HT0sPXNPaFZ/2PY2XfU/hOH97bPW3xe0BHfYKavD3oBanifQoDknBgyHCJweGdsQHoZ3wozDhbtJw4c4nwl/A7Ij+6IjIwKWRr2MbcS6eEwsrHB4lrLY6aiGujV4vrCRmH16K+Rbfiv0DG2K9uC7uKZ66Xfx4PB1/EAcmuPCXhOeo0rDEBfgw8VfMS9JQT1fSezhd8hPWSRTUfI70PWyUXsWPOHnlp9fLFuAseSl65P3p3buKz/EJkys/fQSTi/srS/ElVTZ9P6o6j/Lk7uRhYfLBGuHdqyYnr6o34kl1DPmRaFbgDI2Qq980QsaeYnLxfmZyUUOtkMN2uq04Q6cjnz9y8mJH6J8jt6/qL+FK/Qjy/IO+Ev/TryTnLfp2JD++zY+twpTJ9QkTx+sTpk+hX5hEqQFhKpUEhAmVFxSmlUgkN3RlcskNXZhccsPTTC65oUOb6aFyQ5s2sWFyQ3KbL1HSJj1cbhC3eYSt+nkRcgMvm0i54Z7+BP6szxTLDQf1D3G+fnqU3JCh92O4fmW03FCsS4iRGz7QbUa9ThUrN/yi3Ymzteo4uUGr3Y4XNbJ4uWG8Zh2KNJEJcsNe9SfYR+3B35PHJ8oNecl/YKNqQJLcsEp1FFUqmURuOKScjz2Vj/Cc4hWp3DBQsR+vyP1okufK5IYbslNolkXJ5YYS6RjMkBbhz5IQhdzQTzIIv03ag88k2fFQYjclz574Ln6asAcb4q/guHgLXo9rxWfiJCq5YVNsR2yKeRHHxJjwUvQIfDp6Aq6Nmo7V4nk4XLwMz0WuRX3kFlwasRsd4fsxO/wQngz7EmVhR/Cj0K/xQcgJHBhShAdFp1AsEq7fCx7HPwJfYe+A8K0d/sPo8x3At32f4dXWHdildSOua1mFtc2LcETzbPyh6V1s2zQGCxoHobPhFXytoTuertdhcr0YF3hreV5r3QM0113Ck7VfoKK2ABfU5KKzuh2OqH5M9W54tuFATxZ+X9VEnXtVHcaTla/jM5UN9OJ4xR7sXpGGJ902OvWcuwDPutoJHXQV082S8uE4tLyCXv/nXIIfOOUYLDtMEjaV9cKnyy6SkIsOM452/EF+Gu0jcJv9Prl60T4GH9gekbcltrewq+1fcvivdTCutV4in9nWnii37iKxLkso3rBMIcknLLfI9nZLb1xm2UnmP7QEyP87lndwmOU6+yLb0g3TLYXsl34WL3vnRUsu9rIUs6d6WlKwh6UgKFge4Bktr+HzllN+ueEliwJfscz3yQ1ZlketVM9ixPcsx1rol0WJ5ywFzXKDx1LfRN2s7+KH1keNVNU6HENtNxvkhtdtmbjH9lO93FBh64cD7Oe8csNme1+ssJ+vYxc4BuIXjiu1ckNk2Ws4teyfGvJTNgH7OmuqSZdzCSaWy3Fh+VEPuS1PwzzXgyq54b4rH4e4k/Gm+4dKklAxFq9XhKOp8ngF15UjMbsqDG9WnXbzec5cVNujxLerf3XJDeXVy3BmTT/01zSUs79qT6Gibjp+XvccPusV4VXvfafc8Fb9Bayv/woLG3Zjt8Z1eK1xCY5v+gj9Te/jjuY87N3yFv7RMgKntQ5GsS8HD/qycaA/Cx/4jTg3kIbS4EA88X+zRcJfHCLhv0tDTNgmVPj8uVDhu8PDXsOasCG4LjwXu0SMwysRk/HtyBnoi5yP28UrsFfUJrwVtQ/fjT6J4TE/476Yu/hSrAf/ipXypNPiXkFR/DzcGP8DtkkI4lcJJqr0fOJGvJD4EDOTulHJm0kf41DJTfxH0p5qj5bmY6n0D3xL1pWOlMpW4Ci5Df+WZ9C1wYojWKJIoKcDlHPxtPIJdlANouObVBcxoHqWPExJPixkI1lHTl5Qb8ad6njy06r+FEdrxOTqO81KTNBGk7c87Vr8Xishh9G6HZirSyGfh3RHsVL3PLl9Tn8Vp+tzyfMBvQd/0a8i4Q59ezLfrL/QKsyXUT5h1tT7hLmz0S/MoNSAMI9KAsJsygsKc0okKjIkMbOKDInMrCJDfJu7GNXmw9AiQ1ib+LAiQ0B/FBv0GeFFhgr9E3ys/ySiyPC7XhVZZCjWn8ZD+lfFRYbl+ic4Wj8rqsjQUR8SXWSw6NbgTp00psiQrduBzVpdbJHhsPYzHKRtE8edNXtwlyY5vsjwsmYz3lfHJhQZ5qoXY6Lai19w2ioyvMRpq8hwU5WeVGQYozqObqVSUmTIVy7AUOUTXK1Il/ItZlaRYTMzq8igkI+UFRm2yk6inDFbZNgkHY2J0mO4WuLHcEm2osjwSdJWrEt8iO8mtlMWGUoTxuCrCevwbPwZbBt/G1fEubAiVqQqMrwRK8PvYp5CbczzuCjagLaowZgV9SYeE0/EJPF0nB35Ef4bsQj7RSzH/eGrMTx8HU4J24C/hW7EHqGbcXPINmwU7cA3/++FoPCX9kHhvysChejyC999zb8GT/lWosK3FOe1fowPW2ZhWstUPNz8NkY3D8P3m7LwduPL+EJjKu5q0GGwPhrz6ut5xhve/7C79wZurjuFzbVbcVztHLxWk4M9apJxT/V96hZfvRmXekzYXNVIbWcxrYoMVZWDcFplI11wVezFqRUGdLsd9Oh990qscT2F+a6f6KPINQrXlNfQZVX5Cjzk1GBv59dk4FpZX3yz7CrZqHUMwrWOv0lOZ8dbeN3+H4maYn8HY+1WknbKNh5H2x6SQLFtGBZbr5HMj629MNO6h8TqrWHos7xLhp9YfifVN5hWRYZvmVZFhoMWP8nfzLSi5pZr7IiPLV1xlmU9O+V9Sy27ZrJlOE6wnGM3vW3R4zjLkqBwbQsUMemycJLlmJ86WJJwhmW2jx5Z/m1l71j64y7LoZYiw/eW+BZhDfOb6aPV1VRkGGIdg1utfzaSSWsWdrL91MCv2/riz7Yz9UUGib075tmPeYsMP9i7ocxxvK7IMN3xLN50nK2lU2UDcXPZjZoiQ0vZCJzgtFUXGW45Z2O/cjEeK9/rKTK0cT2Pm11/VBUZYtzv4zJ3PAbcRZXslIrh2FLhq6AOlYfRXzkIF1X53CTZcwxXe8aipFqKu6qvu4oMHWoW4Ymavti31lteZLhaW4RD6j7EJ3Uv42xvEsbU1zipef0DHNBwA+81nMfZjScwqekgHmvagVnN69HWvAIXtyxEXWs+ft86C4f5ZmC17wNc55+GXQJT8GpgIo4P5qE/KFzvEk3GF0Km4p8h7+EHoe9jbJhwhy/DZqMhfB4+Dl+MH0esQlXkRjwTuRsHiQ+jW3wKV0ZdwA7RN/FC9CMcHSM8UX1MFE+3IfZp7Bw3GC/GrcA34q/if/HRVOb9hMHYlLATlyXaMC7pWWq4JWkRaiW3cb+kI9XuKJ2HX0pvYxfmVJHhKHOqyPC03IqH5Qb6laL4AncqYulmknIWLlc+wkZlNr2erPoB76pSScIryfvxSLKShCSo1+NMdRTJuaMuwF6aUBJVqFmK5ZpwkvaKdhVu0caTQLt2C/bmbFVkWMLZqsjwi+45EpvI2Yr3kn4YSV6qd+PX+uVk+4Y+hbQ/1J9vFWbKSJ8wX+p8wqzZ4BfmTreAMINKAsI8ygsKs0kkyjHe1e/BO/o+ITnG2/o7eFM/IzTHWKKPC8sxXtYfwfN6Q3iO8ZT+MR7Sz4/IMW7RKyJzjEv1J3GqPkucY8zWP8IU/YyoHGO5zo9f6lZG5xjHcrbKMSZxtsoxXtSqYnOM0zhb5RiVnK1yjD9qduB4jTw+xximWY8H1JEJOcYB6o/xn2QPTudslWMMT76N2zlb5Rg7q77Cs0qZJMdoVM7DW4qHOELRX5pjLJXvwbflTWiRDZHlGCfIvkaLNETO36Uj8KHkCI6SNOFfSZmKHGNO0ka8nHgP+ybqlTnGYwmjUJewBlcxp3KMtXF3cFRcJV6MDVPlGJ+KVeHqmM7oie6Dw6Iz8fuoIaiPGotLxFPQEfkhZkfOwxMRi1EasQI/Cl+DD8LW48CwQjwYugnFoVtxWsh2/J0JlWPs9X+3M6dyjK0B4TPjAhvwMnMqx/i0fzWu8Qn39LQK9x/aKvzW2Rbhd3Utk3Fx81toa3oDzU1GPN74orCSxqeFlTQosbQ+FNPqq3jGL7z/Ypz3J5xZ9wX+W7sKB9ZOwC9rnkdpTSsVW1L9PdZ7PsBpnhS0Vf1ObcdVfYyllR1xdOWvdOF+xYf4ZoUCS93fC51yj0S7y0sH33etx8byTri0vJguJ5W/gfucVrrf0zkLr5SJcHTZarJR55DhBscukvOMoy3etB8gUdPtHVBuP0jSim0pONm2kwQm24Q0/mldQDJ3WJ2kdKr1Dcy0niW9Xax6TLIuI9WtFic5d1pew38sp0l+iUWJxZb57IgzlsfskWMWA35h+ZJdc8ASi59ZprOb9lj+Cgq+iHstuwM5xv2WoJ+9Y5mARy3XfTnGIks3PGcpbBXu3NCSY3xkGYNBS0lzjjHV+gJOsB5p4s5WLZZZNzbmGHvYonC+bXFDjvGaraU+x6iwz8ZJ9hpvjvEH+3SUOKrr6IJjJl53NNaSjbKF+GmZGKvKNtWwU5xt8aLzRHWOsVv5K7iz/I4nxxjjmoYLXOFY69pfRX3cA9Hm/q+STlUU4MOKLvhW5e0KrivnVwhd7oSWqjtu6uxZjpWePjinutKVY/RXH8SVNW+htFaJe2v/LM8xdq3bhN/XjcZsb3d87E3A/PpGJ59ssOPxhruY1ViCtsZiXNRUhNrmL/C75j04pGUrVrWsx9Wtq7CTbzn+7FuKY/yLsdn/CW4NzMNng/l48/++K5qPESEL8POQRdg/dAneC12Gc8JWoCR8rbCS8E1ojtiF9ogDuDjyGOrEZ/F78WUcGvUHeqIeCSuJ9uBTMSE80U8xyTg6tjd6Y9/ENXHrsU38b3g8PpGavJQwAq8m7MNBiS78N/FFajguSainI+kuvifpQp2rJQtxlvQueqXd6cVs2WqslTlxujyLfpXLv8Z3FBL6+K9iHr6mtOJF5SB63YOTFPlU9SQD4uRDOCNZQzb+Tt6EfTlJ5Rh3cZKibmoxiRrGSYp1aqJJWjgnqRzjSK2UBB7R7sRGbTsyadB9jWt0L5LV27qrmMRJKseYoa/C6fqVZHsdJynyrP8Ri/SjfMJk8fqEKVPoFyZOakCYPiUBYRLlBYWpJBI5jWuYUE7jan3fEKdxpf4uLtN/GOo0LtTHhzmN8zhJOY0fcpJyGidzknIaR3OSchpf5STlNPbhJOU0tuMk5TSGcJJyGu/qZkU5jZ/pRNFO45u61SjRSWKcxsva7ThTq411GttyknIab2jaxnFnzV5UaNTxTuN36i04XB2X4DTWJC/FNcmN2CH53USn8ZzqPuaospKcxofKM/ieUidxGpsUy3CpwoExCpPUadwg/wJl8lCZ07hVNgaVsu+Ea2mcnL9Lx2Oh5BuMlYQrnMblSUPQn7gXZyfa0ZXQRek0jkmYiDfjd2Lf+Et4MM6CMXGtOD02ScXzxnTAlzhD8dTRRgyLfgMnR43BX5lNTmMP8UzcHPkxNkYswzcjVuPF8A3YIXwzrgzbiu7Q7fh66C48HbIXlSH7cL5I8GHwM0wL7sbDAeGT0QHhW+/5hTv84RPu1tv3Ke5oFX7F1yL84tstwq9faZ6MnZlQTuPapsFY3ZiOwxp747kG4Sn0DcITLa0Xnq7M68DXvLfwdN03mFy3HRfWzkJHTQa+UROHP1XfoGK9qhfiUU9PbO95RG33Vq1GdVVv3F55n/qrKhfjjooOqK64Ro/2uidie3coHnXtoYPPuXrjhfJf6O+r5WPxvtND399zLkSRMxa3lW0jFT3K2uAvjsNkZoqjC0Y5jpGlr+3P4GD7MTLWaOuCB2wHyd5QWzLG2VaSydvWWlJ6wDoaF1p/IrfjrZ0wy7qGPPeyVpPwFOtwTLKeI/MhVj3WW5awF9wWO7vDZjHjY8tx9st9iwT/scxmH921/Bt0Gu9Y+gWF6/0Bp/FfSxg+tEz2O40Wy68+J1OvB9ZYtrQ6mUfNLeTf+jb2tv7STL+sfXC79WiT0/i3VYda28ZGp3ECs8lpPM5schpbbM31rNY+C3faPV6nscL+PhoclXVU1TEdmx11tU5jbtk8PF8Wim2da2ucxhVONXqcX1aTw/K+eKP8pocMuybgcZeviky6t+Mu9/Mor/i7kv1SMQ8TKtviusprFU5jfNV03FClRZnnhpvOeuZj2+pU/KL6Pxc9qtmO52oGobE2Bv+ovV7Ozqr7FCvrRuBib09Mrpfjqfqgkz3eUIXOhse4rPE2tm26iuebzuGI5pNYy4RyGte3fIZdW3fg9dbNOMFXiEHfetztX4MvBlbhncBynBEswDiRcH1EJPw9I0T4zJOQdbggVPiWOmwjfhe2DYeE78aq8AO4OuJr7BT5LV6KvIhjxb9ii/hf3BblwGejG/BmdBTPMiVGj2GxL+Le2FH4fNwq/CXuEr4ZH041yuNfxdkJWzGQIFRsZaJQvcSkj3F70q+ol+ip8OeSWdhR+gt+Ie1AFzrJFuEh2SNsJx9Ap/bIDwj9UkTRx9WKDzGoeIAfKrPo8hPlWRyk6kz3f1DtqRHeqzJS8WnyGqxIjiQzr6mX4dfqELIk5txEGjk3UQ3NKozRJpC90dqteFTbhjR6tUewv643KV2mu4yXdMNJb7POjR05NzmN6fq25Hwk5yancRLnJmGa1PmEybLBL0yZbgFh4lwPCNMnLyhMIpGoIMPEVBLsE1KQYeTcVJDxCuemgoyXOTcVZLzAuakgozvnpoKMjpybCjJUnJsKMqI4NxVkNOhO4iNdlrgg44LuEW7WTY8qyHhT58Nk3Yrogoxb2viYgowl2s3Yk3NTQcZDzU5cpdHEFWT04NxUkHFHLY8vyJijXo9ytTihIONU8gJ8NbkWbaqJiQUZH6v+xkSVMakgY7+yCHsokyUFGecVizBTYcGbcoO0IGOo/AD+IwvgaNkoWUHGA+lpHC2Nlhdk3JOMxRGSIvwzSaQoyMhJeh2vJO7CfokWPJ3wtLIg4ymmUkHGNqZSQUZ4/GV8P86Kd2N9+HKsRMVKYjpiBFOpIGNqtAF/jxqMvaLewh3iyejjxFSQ8XbkfLwSsQS7RKzCdeHrsCZsIw4P24znOCsVZOhDd+CSkN1oF+1B8/89HtyFkuB2nBPYgvf8wnf7+zfg5741wkp8y/Hd1gV4s2UOPtsyDbc1j8eWpuE4tsmMlxtfxqcbu+HaBo2wkvpIHFFfw9MVex9gO+8lXFn3JVbVrsThtePwQk037FZTQa32Vh9CafVIXOOJxAjPGWq7pEqoc6AyEhdUHqP+gYrBuLiijr6EVmzBle7nMN59i95tdU3BFFeAzh4v34z9yp/Cm85v6fvbTgM2lP1OHtaXjcLOZf+RlquOSZjnKCdFkY5p+JXdTbresL+LLTY7qTtiewvfsv1OGrW2fuiwHiafP1rj8TPrLHK7zHqPJL9nHYC51oMk3GSNwj7W98h8V+sf7IIU6/OYbN3J7pBa/eyUeOt4jLJeZQdFWLtguHVdULAmUJAhtg7HGOs5P7m16lFuXeIryNBZ7a1U3prdKtz/VEtBxhCrGvOty5sLMo5a65vIvHUydrKVNhZkTLMNwW9sNxoKMoK2NMyxn68vyNhtfwEr7Ke9BRlpjmdxh+N0XUFGneN5fKPsh1r2UVk6yp2/1hRkzHOOwP+c1uqCjOzy2Xi2PBI7uXZ7+K6rF8a6b1bRO/e72OKOxtkVX1eSjYpBOL2yvoIkVO7F6VUmrK2qdxdkzPUcwlbPcFxaHY0xNRdcvA1q5qC+tgceqXWXF2Q8X/c1Xq6bjcO9Wej2dsGCeim2aRDhuYZqZ0HGsMYn6Gm8g2uaSrBT8494qfkbHNtyDFtaDuPW1v34rG8P3vTtwnf92zEisAU/D2zE/sFCvPd/54g2oSRkKx4P2YHm0J1oDxXusCRMuJs+XLjzuXDhV4ZHCL9YE3EB10UKK+ksFlZ1RSyscFyUsNrWKGHl26Il+GxMJ/wt5hWcGDseA7HrcXPcdXwqPopqnI4fhP0TduD1BCsOTuxJ3f5NXIjjkm6hPSmFCr8rmYsVkpv4vrQTXaiULsVpsidYJkunR+Plh/G+PJYODlLMxsuKx/i88lX6e1h5HqWqVLq/QLUfHSolqchJ3oAnk6NJS6J6Bb6vjiBFJerl2E4jJl0fadbiDY2E1Gk4JRVkTOGUVJBxRvs1+rQvktI03TVcrMslvWd1VfhEt5I8i/TtSLiCU1JBRgd9rk+YI16fMFMK/cJ8SQ0Is6YkIMydvKAwg0SilMw45lFKZizzKCUzWv8XRuinh6ZkivSxYSmZLbovsE6XHp6SWa57iKW6/IiUzJs6WWRK5nndcTykyxCnZC7TPcCRuveiUjLb6pqwVLs0OiVzszY6JiUzQ7se6zXS2JTMA5qt+JpGEZeS6VVvxp3qxPiUzJfVn+L95NCElMz85HkoS67CY6rxiSmZBtVt/Ec5MCkl813lV9ikkElSMgsU8zBR8RC3ywdIUzL18j34uawZO8qGyVIyD0uP4VPSMDmrleRiO8lXuDepBVVJWYqUzMLEzRiVWIoLE9opUzJr49/GvPit+GfcBXw57iEejG3A6NhYVUrm9Bg93onujn2j++FnUVkYFjUMJ4vH4W+R72LPyJm4NWIeNocvwrHhBXgpbCV2CvsUV4euRU/IBhwashHPijah9v8uDgp/twWEz2QFhM8f8wvfTfIL95njE+55rzUf+7d+iAdapmBky1ic1jwUf28yYe+ml3BnYyoGGnQ4oSEaS+rrea7u9Y9xs7cEm+tO4Nt1G/F67QfYozYNd9WIhQrUXKZWC6rzsd7TBT/w/EM9XVXLcHJVKtor/6LyEyvnYVmFDqdWXKAvVe4xOMvdStdaXVuFPrq6Y5LrMp3dVz4Ce5SX0fFLzrk40hmGVWXrycPKMiV2KNtLWn52tMd3HIdIUaTjKTxmP0S6htnboci+m9SdsiXhNNsi0viszUUyw21D8T/rORJ7xZqCX1uXk+RtVjfZXmYdjLOs35L2iVY1jrIuZBcMtlrYF9nWTDRav2anDLQmYj/rLHbQS9Z/gmTA2i8oXO8P0AVrOKZbp/hTMk3Wmz4yb30WR1i3tVJzq6+FnFsn4A7rzWae1PoyNlmPNaVkvmBLwXm2rY0pmT/Z4jDGXtDAd+3+ehJo/wjr7HXelMxMx4e4x1FTx25yzMLBZY21KZknyxZgkjMCZzk31JANpw7Tyr+uTsk8Xt4PNa7bnpTMNa7J6HcFq1IyZ7p3Y7m7L75Tcb8yJfNhxQIcXdke71XeqKAaVTPxflUbHOO56U7JtHgW4pTqnuiptrlSMj+q2YUhtUNxTW0Cqup+K2f31W3E3t63scTbD8fVt8fm+njc3OB3ksDGKrzR+B/mNd1BUXMJ7m6+iC+2fId/tpzED1qPYrTvMB72HcA0/3586N+L+YFdKA/uwKL/myPaiWWiPbgsZB+2Df0cz4cexBFhX2Jt2DFcH34Gu0b8gFcjruD4yFvoi7yP28Vl2CuqHm9FRbDyd6OVGB7TDT+LycA+sZPxj9gtODFOePaGOKEOy+KHYULCHtyRUIbtEntTtyOJS7FH0p/4bdJT1LavZD6el9zGftJu1L9YuhJfktnxO1kGPeopP4pH5Il0UK/4CDcqLBimHER/Zyov4GNlT/puVh3C0yoNeVAlb8L5yfF1wvv2U+yjjiJFm9Wr0K2OIV1pmvW4WSMndVbNbnxW25EcfqI9jle0fclntK4Es3Sjye1CXTUe0X1Knq/qOpDw+7oL6NSN9gkTpN4nTJONfmGyPBMQpkxJQJg4eUFh+ohExcyUPf+3T0hx5i+6O3hNNyO0OPNnXVxYMbPmCH6jM4QXZ36le4yf6eZHFGdu0CkiizM/4WRUnDmRk1FxplH3EFWcjIozH2t9uEe7Iro4cygno+LMCE5G3Eejii3OHM/JqDgzVqOOK848o96BIzkZFWc2J2/AnclRCcWZLyYvxj9V9ThNNTmxODNE9Q9uVWYkFWd24mRUnPmtQiMpzkxTLMZf5VYcKjdKizPvyQ7iGJlIVpz5n/RNHC89I1xLYuTFmeM4GRVnPkgqwhFJQfwj8TVFcaY5cQf+lPAEX0jopOR54/NQG78dVzKJijOrYx/gyNha/DEmUlWc2T4mGVdGd8aKqOdxcFQafit+DdXikbgwcjxaIqZiZsSH+FX4XEwIn48zwxbg36GL8KXQJfhZSAGGhqzASSLBX4LLsXtwKW4KLMQG/yc42j8PL/jmCCvxzcAVrVPQ1fI2vt4yAs80v4qq5oH4SVMv/K/xKcxoVOLRhnBhJQ3VPNHs+vt4z3sZB3q/wsN16zC2bhrOqh2ID5lBxZk5NVeo0sXq+UKtqlPxpOc+lezqWYFfVvXAp6r+puaHKz/GTpVt8EjFT/QltWIcnnb76Fdf93a85OqBr7uu0NPS8pH4frmTXgeZQcWZW5hBxZndnOtJwhVmUHHm22V7yEnA0Q73OQ6Sn3RHRyy3HyBXG+1tsb99B3nz2OLwqO0TcjjD5iCTBtvr2Nb2LVkNs2nRbV1Mhv+22kn1ZWs2nrGeIOeHrTLcZf2I/G+0PmBHrLYOxOXWg+yRxVYxfmKdxt6Zb/09KNgLP7ZuD9Bxa6u/mIk2DldZL/uKM9dbO+N269rW4sxD1pqW4szvrbn4j/VSM9m29cQXbPubqLNNhmdtqxp5RluwoTjTZP8IN9s99cWZT+xT8TmH3VucWeCYgPcd1rrizF5lE7GwrLy2mHk9HQc5G2t4FucSVJfH49LyPdXFmZXl3fEt1yUPu941Cl9x11SxN93rqoTudMPDFb9VFme2q5yOn1XKUV91vqI4c2/VRGzrkeBBz0/u4szO1R/iyeoO+ELNPy7SWLMes2pN+FdtKI6r+7mc361bhQu9b6Ksvi8eq2+HmQ3x+IQZRD0bPahqeoJnmv7G15t/RVfzz7ii5Ry2bz2DP7aewFG+r7DedwQ3+g/jM4EDeCOwDycGP8MQkXC9VyT8vW+I8Jm7IV/ih6FHMYG5w34MK8KM8O/wSfgFXBBxHdWRt/HbyFIcLC7HCnEDroyKZM0dolV4Ibob5sYYsC4mD9fEbsB2nIN4ijgxFUiLz8Gb8VtxZMJj/C+hGxWbkjgfPYm/4JwkHVVtTpqJn0huoF/SgcovkC7CVulD/EjWn+7UyvbjNHkkvXsin47DFffxmsJEZ19QfocHlZ3peLxqL85RycjDA9UaHJgcSU72JS9Ff3II+clVL8FT6nByJdaswlGaBPJ2VLMNGzRtyGG69giu0fYmmb9rr2C8biSJTddV4lTdCpK8UteObO/W/dgqTIpcnzA1vD5hghT6hWmSGhAmS0lAmDJ5QWHiiES5pqVMn1zTEqZPrmmh7i7O130Ymmuao4sPyzVN1x3FKbqM8FzTWN1/OET3SUSuyaBTReaantWdQrUuW5xratb+h7e0M6NyTdu1ouhc03DtaozTSmNyTRc1O/ADjS4216TVfIZX1W3jck3vqT9DiVobn2s6k7wNhyYnJuSaalQrca3Kh0+pPkjMNf2gfISvKV9NyjU9UpzF9xXtJLmmFvlKLJC7MU6eI801bZR9jQpZlCzXtEM6AZOl54VriUSea1JKJuLGpO8wLilCkWtanjgUAwn7cE5CGbrjuyl53vjJeCtuO/aN+wE/j72L4lg3vh8TxD+jk1S5phej2+LuqFQMivtgntiIJZGvY2rkSCyMGIfe8EmYGz4Ni8M+wJSwGVgQOhPLQubgqyH5eFI0D2Ui4fqj4Fy8HxA+MyAwHQ/438dI/1Sc6puIt1rH4nOtI3Bby2vY0pyOY5tfwEtNXbFTkx7XNCagp8HH+oc1lOO5+jvYpv5HLPAewvK6lTi4biKerX0J29WG4Yaan6lPaE0+5ld3xWrPPSo5zbMcy6q648Squ1TbXjkfJ1Xq0cnZh15XjMUazj58170NQ9zdcR1nH1LhGo7Hyh10eUD5bPzLKcKpzjVkIMwpw31lO0lI/7I2+Mixn+QscaTg0w4hUX/YtfiJfTNJ626PQqftIxJ40vaETC6xmXGs7SQpTbcpsKttPulV2B6T51CbEWutR0i4zRqH96wzSP4f1jvshV+sffCKdQ+746JVhMXWPHbNOWtJULAbnrduCOSaLljr/Lmmy9aRWGI978s1/W5ti/9Yl7UKd3a25JqarINQaTvXnGsaaOuEc2zbmnJNp23R2GBb2Mgz2usbck0r7O/hX3Z7PfV3jMOZjgde9o5jFGrL7tXx3bI38XbZo9pcUw9nHm50VtSQNOdcfLM8DK+Ub6rONfV0dcB9ru89uaYk9+u4zF1WxXrcy3BGRTt0VVyqFLo2Ea2VMfhO1ekKrqvewkmeaHR5zrp5M1RPwYZqDS6o+d1FGmtX4sbaV1BX5yvPNR2pK8YXvcvxhnc0jqt/GZvqO+LmBil2bwwV/tvodZKcpjIMaX6Ae5pvY5+WErzT8jPOaD2Pcb6zeNT3DWb4T+MT/wlcEPga1cGj+O3/HSIS/lIlEv67OuQUdgo9g5dCv8VxYeewNewibg+/hr0ibuHvEf/itEgrisUePCD244CoONZ5L0qHc6J7YFJMJn4VMwGNsWvwQexP+EFcEP1xRurwafxalCX8jXsT2lOrpxJn4PHEn7FXkox6nk2agi9JfsLzEg01f1k6F89J7+ALsufpyynZduwq9+N++UR6J1f8gSsUA+hpg+IETlCm0Oubyq34vCqWJOxWFWBQFcC3kz8mJxeSm1Gtnk9+Zqp9WKJeQq40GjFJm6rZgGc1ySQwTHsAX9X2IJPrtRfxF+1QsurTurG9bjkZ7q9LIdWDdedbhekw0idMijqfMDU2+IUJ0i0gTJOSgDBZ8oLClBGJvKZnmDheUyoTx2vqovsLn9JND/WaUnSxYV6TRvcFynTp4V5TjO4hBrT5EV6TRyuL9Joeao/jNW2m2Gs6on2Ii7XTo7ymHG0AE7SfRntN1zVJMV7TfM027KpRx3pNf6t34xK1Ls5r6qzejbeSk+O9pg+TN6M0OT7BaypSFWCOqgltyqmJ3EF5D+OVpiSv6TPFGeyu0Em8pvPyZZgpL8Nbsiyp1zRc9iXek4bLvKa3pGPxoeQsjpHEy72mB0njcCTnHa/pz8Qgvsp5x2u6mrAT+ydY8Ez8U0qvqVP8WNwatwZFccdwSuw1vBVTir1jPLgrWqTymoJRCZgXpcMScWd8RtwLN0UOwIYIE74Z8TpeDB+OHcJH4aqwt7AidCwODh2P34TkoTpkMi4QCT4JTsKM4AQ8GngbEwJjcKb/TfzbNxJf8r2B+1pfxbDWdJzc0gd/a34Gn21uh1ub5NjSGInjGhtZ+ZUGO3ZpuI0b6s+j13sQR3tX4c91U7Bz3Su4qTYBAzV/UpnpNWvRVv0KvlldQ/XuevbhG55svFVVS51fq9qBtyr74+DKx/TiTsUiHFXRBh+7f6BTU9zDsNblpo+LXAsx0ZWEB8r30eUXyp/B35zf0/2JzjQUOW+Qjb1lg7B/2Z9k5rFjGBY4/iJLqY7B+I/9VzK2wp6O/ezfkD2frR2W2NaQxv22WiGftlE4yXaR3A62dcR+tk/Jc1dbFdnW2oZiou0smY+06TBgXcxeaLba2Bd1VjN6rMfZLxVWCbqtc4LC9f2A11RlHYC11gN+r6nRGol+6zSf1xRu+71VuGdvbGvb3eI19bGF4Rjb9GavaZ3tcZOwwjcw2n6t0Wt63d4Pt9nPNNB9eyp2d3xR7zUtdLTDPxz7vF5Tx7I2+EnZvjoyUNYeezm/rPWaNju7Y73zbA19LDfgpfLb1dTHNR53urwerynKvRrnu9tjlfvHKnJbMRofVrRUsi8q9+CdyldwSFVZBXukaiMO9fTHvz0ut9D3XfhfdQ5OrglBT81Zl9c0r3YGhtV1xQ11znKvSec9jse8H+PA+hH4DxPHa5rR0AljGhV4uFGMrzQ1O72m0qZK/KjZitKW+3ii5U/Mbv0N7a3XcYnvCur9l/B7/0UcFijG6sAPuDZ4DjuLzuNl0Y84LuRnbA25jNtDr+JzYSV4K+wWTg2/i5ERD/HziDLsH1mL/0YGcJY4jrUlRmnxq6huaIwegI+jh+L8mA9QFrtZ+G/sVRwQF8qz34wz4aj49WiN/xffT+hIleoTZuLHiZcwJElBPZcnTUWx5BKukuiouViaj8ulf2OI7EX68rFsF3plQZwqn0zXHsn/xEGKV+jpBcVJ7KpsT6+3KLdhqzKeDIxXLccrqiB2TP6EhCxNbsGHyR+TnBfUflzDrOFuajEZe4ZZI7ylVWTviuYAxmp7Nglv8p+xQDuCrJ7SVuFf2lWk163tQJ592gsYrRvtE2ZEvU+YFxv9wux4JiDMkZKAMFPygsJ8EYkKs+5q9+AdbZ+Qwqzb2jt4UzsjtDCrRBsbVph1SfslntcawguzTmsf4Rfa+RGFWdu1isjCrOXakzhdaxYXZg3jdFOY1UM7O6owK6AJjy7M+lmzAT/RqGL4u2YvPla3iy3MWqs+iC+oO8QVZj1KPojLklPiC7OeTt6D11WKhMKsiaq1KFKJEguzdig/xGeUT/AnxaCkwqw3FOfxifwpSWHWB/I12Czz4BLZYGlhllh2EtdK42SFWQnSSbhBchETJXI5f0+ahFFJZ3FpYqSiMMuXMBznJOzHyngnvhP/tJKaxL2JaXHL8KvYz1ES+z1+FHMTS6P/E/4bXY1fRAUxNipORTXEyXgnsiP2ieyOeyNewJCI/jgx3IA3wkzYPcyMm0JzsCFkEI4OGYIXREOx/f9dERyMrsBr+HogG0/7s1Dpz8D5vjR81PoSGlp74ZctXTC2pS3OaJYJK2kSY9+mZla4t7EcQxv/xckNV/G3+iJ8rn4H7vAuxEDdGJxY9zz+zommMOvl2hJq8nVNAbateQm3VrupXkL1LvzUk4GRnioqvLxqC0ZW9cFVlQ/oQmzlx1hYoUFlxXf06DP3YOzsLqOD37o+RqMrDv8u30N/p5Z3wZDyb+j+Tmd/7O28Sir+LMvGD8tukRZZ2SD83vE7KRrnyMEYx3XSdc4+AKfbi0jdM/Y22GRbRRpv2qpJ5jHbCNxoKyax823tcLJtBUkebnOT6kzbIHzJ9g1p72lLxi62T9gFHW3/sSPa2IyosR1hp6hscai0zQgK13cDhVlqW9+A8Jm9/sKsDrYQ7Gyb6BPu80sr1bP1wBzb1hbhFwPNpNE2DS/bHjQVZgVtr2Oa/VIjvbb3wd/tRQ38lqMzTnYcqC/MOutogzFlu708b5kGz5btriONzjb4gfNgbWHWLWc3fLb8m5rCrG3lr2Cg/FZ1YdYU11i866r18IzuVfi9OwWfqThfVZh1sCIXdZVNlezoyt0or3oFNzFlqLNnE271DMDk6go3+anegx1qBrmFPERg79piF4mtnY1ZdT3wTl1VOTvIewZrvctwRf1YbNNgxO8beuKQxhSsapTip00R2LG5xcnubq7Gt1qc2NjyBDe3PsAevn/wV99dnOz/C8MCf+C+wE18Ofgb/v1/Z4puYULIbfwq5A5mhgrftYTew4Vhj1ATbsfvwitxSEQDVkaIhJVExgkrEWvwJ3EXfDOqLzZEvYobo8dhasxHeC1mO46NvYTe2FZcHtefZ5fFL8PP4n/DzgnJ1KcoYRK+mHgWixOjqWRa0li8nPQdGiVJVPuK5D1Mk/6KF6Td6Egf2Xo8JfPi0/K36Ndu+XWMV/Smm58oDqFToaLLQ5Rr8AdlKN1vq5qPS1X1aFV9SDbSkqtxT/IMMuNNrsVs9VyytFftx0r1cjLWV5NA6pZqduF1TRfSGKEtxr6cZQqzxmsrcJF2Jendqm1Pkg9rf2wVZsEonzAX6n3CjCj0C/MiNSDMjpKAMEfygsJMEYlSzYuYL6nmhcyXVPMnzJdU80fMl1TzTG1cWKr5fe0RnKQ1hqea39I+xsHMl1RzmlYZmWruqS1CrTZbnGoO0VrwseajqFTzKU1UdKp5rmYLPqvRxaSaHeoDuE3dKTbVnK4+ghXJXeJSzVuSj+BLyZ3iU80PVZ/jApUmgXuqNuJ3yojEVPNryrloUThwjmJYUqpZrPgJt8m7SlLNHeSFeELmxRdkI6Sp5mLpt/iKVCJLNV+WvIcGyWW8lJQsTzUPTJqK5xOL8fnEWEWq+WTCKOyccAj3xbtQHt9JmWouiBuOnth8HBm7GX+M+Qo7xFzAVdF/YGXUfzgkyoNnxT7UiqNUqebFkTK0RegxK+IpPBbeDZPCe+KcsF54L/R57B/aF/eH9MPwkAE4RST4W7A/9gy+hFsCL2KTX/j8W37huz/5emBHXxdc1doeK1vU+EZLIn7bHI7q5ibWs7DJhZbGB2hq/AWPNXyPkoaDOLd+LZZ6Z2K6dwgereuCsrpG6rCo9jx6avLxnZqe+G+1hbq9Ub0Rf/X0xyyPg9peq1qLpqpnsaTyDvV/tXI2/lEhwxEVJ+nOI7cZp7j/o3de12wscEWiwrWVzh4tb4+vlB+n7/86X8DZzh/Jg8SZjqfKrpGToWUmbHRcJz/7HEbMdlwkV032F/CE/Sh5m2ZXYW/7EnIYZS8nk3bbYPzF9i1ZPWPT4j7bIjK83mYjz4tsZpxlO07O37VJ8B3bHPI/xnaPvTDS1h+H2j5njwy2ReAg27tB4fpmQPj7swHhM1v99MXW7BO+O8Yn3OdSK122PY2rbOtbUs2HbY3NqebfbRMxwv53E5m0m3GF/cdGKmnvhXLHVw2p5nGODnjcsbc+1ex3qHFw2TYvdyhToL9sWx2/6FTjt87PaqleeSfMLy+qocLlL2Om60Z1qrnINRrbuKs8PKm7AEMq9Di34mwVaakYjpMq6ytTzU8qd+DYqgH4qMpRwRo8G/EJ55dU80QmS6rZVb0XP6wZgs01Ubis9qIr1Rxfl4876nphR29dear5tPcHNNSvwX/rp+CMhsEY0zgADzd2x7SmdljapMD85hiUtYTgyZYWJ8lprcOyVg8u81VgW78Lz/vLcGTAhnUBC24ICnYTWfG6yIETQsoxGCJ8a3doFb4YJtztr7BmnB4u4ldiI6LxiwgZpke2xUeRqThP/DIqmCZUL2oMvhr9ITqiV+LimIOoiS3BU7EtmBH3Ak99N24ejo//GSvi46jMnITR6Ev4Gpcm+jEyaQiV/DTpK4yRhFPnTyVvo1h6EZdJU+hFQLoM58qcQndkg+nUePl5/FPehT6mK3biCUUs/VUrF+NiZSPaldPpfpbKhUdVk0iFONmO7yRPIi3nk50oUb9HivLUtXhG/THpCqojyFumZjOu0nQkhz9rzqFH8wb5lGrdmKpdQW5f0bZrFd75xa3C+z/XJ8wCr0+YC4V+YUakBoR5URIQZkdeUJgjIlGJuRczpcT8HDOlxNyDmVJi7sZMKTF3YqaUmNtxZikxazizlJiTmCkl5nBmSom5XqOILDHbNEX4hyZbXGL+TmPBrcyUEvO7zBTuptmKbrU+psS8X30QB6ufji0x+5OP4pfJXeNKzIOSj6JX1Sm+xLxddQBfZKaUmO8qN+J0ZkqJWaz8CPcqyrCnYnhSifln+c/4BjOlxPxIVohTmCkl5mrpcGmJea70G2yRJMlKzJ9IpqE/6ZJwnaSSl5ibE9/F2Yk/oCchRsFqE0aiJf5zzI234W9xemWJ+aU4Mx6OnYpxsQU4K2YX/ht9AvtHX8QDUb+jOOoRvid24x+RDfh8ZIiqxLwzIgYD4RJ8J1yF18K02DWsDa4PTcHakI44IuRp/EHUGduIhOulwafQEWiP2YG2eMKvR6lfg3N9CrzfmogDW8V4sMUvrKSlFqc1O4SVNN0TVtL0C+5sPIeBhi9xQsNmvFG/ALvX5+EWbwa21rXBvDo3FbhdewLTaqfhtzXtsWvNXSp2sLoA9dXP4i7PA6qa7FmKO6o6obrqBpXfU/kutquMwi8rDtGXHhUD8Af3XbqW6X4X/3a10s3JrtXYWq7CjeUH6HjX8m54zXmaJOQ5X8Rw5w8k5Iuyl/HVsvMkp87RBz9znCFRrzm6YqhjL0n7yR6Lq+zbyPNhW0uwxHzINjYoXOtaS8yPbctaSIKtsrnE3Nn+Jo61/9bEau0D8bH9m8YS81OOrviB4/OGEvM5hwbFZVvqS8wjy5Lwq7J13hJzsCwORzrX1ZWYTzmTMLF8W22JeUZ5G/yr/EhNibmvqzd+7rpUTXLcQ3Geu8xTYna5F+KYCiX+WXGqqsRsrhyElyqrK0vMA6q2YHHVS/iyx1pRYv7Rsx4HVr+Ml6tdbj5fswf/qHkDR9WK0cK7nezxbi8xN9Y9jwXexvISs6z+En5RvxP7NXyMdxsm4YzG4RjblCn8t+klTG/ugQ+bn8J5LXpUtCrwVGsS5vji0OmLwQK/GFMC4VgcCMHcoKD3/xaKhL+nhgifKQkRPp8XGo+iMOE+e8KU2CdcuP+d8E44PaKnsJLIl/HLyCxhJeIRwkrEk4WVROWjPHotnoj+HM0x59Ea8wA/jo3gSaVxffFQ3FzsHf8D/hwfRk2yEwbjnwn7MTexDksTs6jhuKR9+F9Ss3AtGUGdH0q+wVFSBV34SzoPc2SPhI7ITPToBflp/FKeQgeVikJcpgils5WKuThMWYnnlJPou071BBeoxpCH+6pSfD55DDlZn/wYbckTyM+L6nJcoZ5Jrm6rA6jUrCdvQzTtSOByzfd4nLd6iflXjRstmhUtwpu2Xavw1v2xVXgDj/IJb2OvT3gzF/qFt3RqQHhjlwSEt3deUHiTi0R52fWaPejV9AnJy67R/IWVmumhedlOTWxYXrZF8yU+0KSH52X/qXmEVzXzIvKyz2rkkXnZX2hO4EZNljgvO1/zH47QzInKy+6siYjOy65Sb8Sjak1MXvZY9X5MUHeMzcs+n/wFTkruFJeXHZ98GM+o2sfzXdVebFAqE/KyNyvXYnelKDEv+5piJr6lsKBHPjgpL3ux/DwmyTtK8rL3yFZjJ1klnpC+Ls3L7i09jt9LomV52S9LJuD5pB/wpaQEOStPHI+9Ek/jiYQQRV720wmv4f74baiM/wdXxSUoWUlsH3w7NhdLYmZi95iVuCV6FzZHfY1jo87jZfEN7Cz+G9dFPkGO6Tgiog5/CG/B/3Fc3+FNlW0YwNM2bZo2eyeAoBZBqSwBw1JGVCBpVtMloIBhfIASEBWlKghqRYQCBREjQ1ACVKlQlFEBZRVBRYiCsqqQNs0eJzlpm/Hdb//5XbnSk3Pec9/PeZM+wMzAVTnZcuuUtmwm1Gaz4MGsQijO4sJlDOKtDAeOy7DhnnQezE/nwIWpLPhHMoXzDE/S8LOuIEx1tsJZnbfg+Y4rcEDHGVibaIQUvQdW0Rvhqfg7sCj+P7gmZoIhahisoPjkr9E7uPcB0V3QHpkOBREx/CB8HlllQq/Bt0IPwXjwMvJcGlwKqYASvhY4gcwT/mnwbX8numD6t8C1vsFQ7juPvvZ4n4dPeH3o8ZynGlZ52DDUXoeua9p7waL2PZiBn92PwpfcBzAbee5iWN9Wj5mxtD0KM627MUsHW3tAa+snmLGHW5OYOq9rDjzl+g1z+IVrOHzPtQ3zucDFgJWu2Zjb51y/YIZHugbCx12bMNtFLhrT3ss1FSpcpzD/YlcR5Ltq8FxwXL6MdUqhywi5rsY0MnEpocT1dso6Ren6N2md0tv1DOzn2t+Fu3MJushV3ui0Tpnt+rfDOmW9Sw/PuU4lrFOyW4fCZ1r30tYpH7f2gs7WzXGcoY0HX277KGadcrItFwrd71F4RtxZ8Ef3e1GsrT0Pvta+NmKd8le7BI7ybA9jbj2PwXzvsZB1yqteLfzPezdonWL2vQ7P+fhwlH9/wDrlO/9kOCDg8Vun7A2sh32DI+BXwbs+PEGhNXBf6En4eNjtxVMZ3gZHRQzwTCQX6qI/enB1fINg3ii1h8wPA66MXWtHy/FD8GD8cziZroH36WXw3cQCqOp4ER7psEBTpxb6OifCmq6xsCiphqeSw+HU1BOQTg2Gm9KPw0GZAfBSt3MY5J3srCFwe9YwOCp7BPwreyRckvM05DKfhfuYevhMbiVsyZ0Fq/MWkXWy3oaHWJ/Akvzt0J1PVr6KfQH2KrgLfyjogsbC3rg7d+EU+A7nHSjknvCQvYKBNIp5WtjI+5ykxA/Ak/wJSG+84DP4syAKJwiNSPiU8Fs4WsRH/kdEr8LHxTfgbvF4tCOXfAM/lKjQXVyyBr4kTcJfpTY0O1zWBrfJZqDxpOwfOE1egUk4Lv8LShQVmJCXFX/DnxXTMTlS5T1oVS7ERH2r7IQh5ceYtH6qPpg9C747rFNeV5kxk7UqXwfZwz/sJPv5Q11kbz/ZRfb5qiTZ82NJsv9vSJHvgsfT5HuhOU2+I6wZ8n3BYDC0Z/DdwdD+rBqZxdCeVv0JT6gWZzO036u4OQztd6p9cL/qGSZDu1P1L9ykejuXoX1fpchjaF9VHYLTVToWQztOdR+qVMvyGdp2JYvN0B5QboJWZY8Chlah3AWbFX0LGdqlCgd8QNGfw9Cel++F8+VFXIaWI98B62UKHkM7WbYO3pNm8xnat6RLIV96H+6SmAQM7VBJEzwtLhIytFrxR9Ap8sGpIp2IoW0RHoAvCfPEDK1L8CKcLfge/scvkDC0L/KnwX949dDC64SXuc9IGdqJ3LXwKOcX2J+TgpsL+8oY2lTBRGgtmAp/YdvgIPZ7sC5/E0ywdsHprG/hT3nHYd+8s/Cj3F+hn+mEJuY/8EjOHajMaYHV2f/BlqxWqMlyQwejHRYyyOtFGfL+tTQ55sn0XbgtdRumk3/DWclr8HzXZfhY1xm4rvMYjHR8A8s7dsDjiVrYO7ECrqJfge7487AkroGHYgOgIsaD71Bu3Glb9Agsjb4Bz0YGwZGRe0imIVwHHwtPgF+FAsjwwdBWuCP4FHwgeA857wyshg8HiqDD/xNaGOSfBo/6KHQ00bcG/uHtCWd6v0GDlGc0rPE0o9/eHjM81v43ei9rfxFS7nuYh81uKxzlvo85aWmbBde03cb8PNlWDttbf8Fc7W4dBee0fo15G9bKh9zW1zGBftctzOQ113j4o+trzOoBVwH83LUI07vOdQ3zvNr1JKx2fY45f92Vxswvds2CL7vO41n4n+sxOM/1SYYYTjO0C1xlcJHrWAoz7+oJ33StSDK0K1z3u7A21+Qucv6DnQxto0sOb7je62Bo2a3hBBJofQmuar1OM7QXW0ugsO1MnKGd1jYG7m87EmNoO9uGQJ37Gwp5ugdA2n0gislpHwi/bT8cwfx7RsElnrNhnN9jgOO8d0K4O+8iqPLlwDW+rUFMrG8wXOK/FEBW/v/BWYECeCfwrR/XDVrg7WDKx9C+ENoL/w1Z4OwwE3rD33txj5H5sCvSB74fveHB1ak6aKcqYHGsCJ6OpdsZ2or4fzAcvwzX0idgv8QBeCaxHb7QsRF2dtTALZ3vwqFdb8DfuhbD+cmXYV5qPtydmgufTr8Eb6ZnwjcyM6CEQV43MKxQl0WOac8ix7+fvRA+mEPO82MOOWcVk5w/xiTX2pBLrvt4HlnDxTyyntms45CRfwna8+/AJ9kReJXNxr28XPAQZBU+DXcWzoIjOR/D3zmn4EvcFIxwNUjjbd4myOS74Ef8kUiMK1gP1wvaIV/4DLL9RLgbFoiYyPx90TyYEv0Kl4pHoBe3eBd8XsJHXxcl78IR0jDcJZ2NTgtkN6FNZkHX12S/w2FyHWZgo/wX6JdrMRvPKH6FdoUZMxNU3IBPK2dhlmqUIXhRuQozllaqMHX9VIfhc6oSTOOLKjdcqlrVSXbv3l1kJz/RRXb1iiTZ4aNJstuvT5Gdf0CafAtcSJNvBGuGfDswGHYcaYc78F+GXWtXOeFWlS3bjvNwcuzaT1QO+IFKw7Rrq1UtcJFqea5dO0Mly7NrS1QNcJhqMsuuFavuQrdycb5d+50yA23Kj9h2bX+lsMCu/UfxKVyj6FFo145QfAFb5L04du2H8s/hALmca9delm2EC2QFPLs2X7YC7pJGoVpq5du1v0quwRckTwvs2oB4H1wuFgjt2jzxUrhO9BeUiIaL7NrPhJtgD6Ef2gXPiPFa8Dn8jB+AUv44iV27nrcesnk34UpuX6ldS3P+BxdwvoI3C/+Czxam4MEClcyulRUMgcvZz8CW/HL4TP4cuJ+1FPJYK+CreWvg9dw6ODr3c7iD+SXMYe6Fc3P2w0vZ9XBQ9kG4KesQpBmNcGq3JzPknYcy5K8fpMmRntQ+qE99DQ8ld5GVJLfBt7o2wDudNXBC59vw647FsLBjFlyUMEMnPR6OpB+H2+MKspJ4Bnf0v9h/8AqVg3zi/l3Irdo/Bub6/0Sqtb4FsJcvjbS/8a6HT3sfgNc8B9DFfM8ImOM5iaZ2tGvg2PZ16PrN1gTaN7TOgANaL2AquK2Pw5hrI6blXxeNyfnDNRWecZ3CRB1zPQy/c32ISat3eTF1e10G+KXrMJlGlxxudy3PEO+mMQmuifAr19cpZO4qgAddi5J27Q+ua13knGr4l2t7p10bcbGgsvXVDrtW13ovgRlrLYMXW3+h7Vp+2zhY2fZD3K7d3TYYhtv2x+za8e5HYJ17N2XXtrsfguPbd0cxP+2PwK72+ohdO80zDJ72nArbtf28OljrvRmya1PeV+BCXza87fssaNea/EPhef9vAbv2qcDL8GhAAIcHj/jt2sbgdDg8lAd/CB3y2bWjwi/CU2EBfCZyxotpjyyD5dFBsCXa7sH5qX2wk3oVfhKbAh+OF8OmuBRW0NkwQkfa8dfEPfhox3V4tuMynNH5M0x2Hodbuw7DYclv4ZXkAbgwtQ/mp7+Ce9JfwnGZnfBWZhdcxtgNpVlfw++yyJEl2eRT7dkH4fs5jfBB5gn4I/MsrMr9FcZy/4a1eS5YzKJgMysXK3wpXw7T+QPgZ+xx8ImCSvhbwRI4r3A9zOIcIn/l3IGDuFIk8BO3Cup5X8G/eHE4lT8ZWbXwd8BZggT8T1CKPGcKv4N3hEKkXSVaCq+K/oaTxePQyEnxAThYokBTOyUfQq40Ad+ULkSb/0n/g5Nkz6PlepkTcuVGtL9Q/ju8IDdgKvoo/oBvKCyYlkuKm7CH0oopmq2MwK+V72O6bip7Yt6YqiPwYZUBczha5YFG1fuYzJmqPl1kF23qIjtqZZLsrlSS7LS1KbLrFqfJDtycJruxNUN2ZgZDrduEXZqozlLrarFLq3UfY5dW6z7ALq3WrcQurda9iV1arVuEXVqtm4VdWq0zY5dW68aqDsI+qmdZal1C+Q+8oJyfjzMo4/BZ5Qq2WpdUsArUum8Ua+E0Bb9QrWMpamGDXMBR68rl62CHjM1V67bJVkG1rBM6pYt4at1C6X8wW2riq3WbJadgX8ljArWuUbwRjhMn4EXRVKFaZxSdgH8JlSK1rkr4Grwp+B1OFfQVq3V/89+C5fzL8A9eL4lap+XNh2e538PR3DT8jjNOqtY9zHkTbizcC1MFv8DZBS54id0Fh7C5MrVuS/4DsJNVDF9kjYRn8jSwX14JXJtbDkPM6dDCfAkezZkLe+bMhyuyF8L7WYvgc1lL4AEGkd/tqxny/vX0Ajg6/T+4IzUH5qRmwbnJafBSlwUO6tLCTZ3jId0xAk7teBSeTqhgUYINP6LjWHMg/i+0xJvh8dg++GDsPfgR9So62td6F6290ToZ6lq/Q5v9WhWQ3fo2Wo64/kPj/7qeg9dcBzAJzS4+/Mn1KibkhOs6puV712h4yLUDU3TQlQO/dc3NkNeX0uT9QWlyzKYUOZ5Oks9Ohb+4TnWpdf+4+naRq3zSqdZJWhMdat2E1tnwzda/EmrdD61TYFfrKRrvtw2HH7d9E0c+bY/AR9w7Y1i5uxe85P6cUuseau8Bq9u3R9W6G+0PQbVnX0St+9wzFDK8J8Nq3TxvCbyGX8I4p28JPOTLh339u4KYQP9oKAz8HVDr1gTegnnBB+Dq4Dm/WscMvQI/CCkhO3zep9Z9En4NiiL94LbITS/WEN0I66NT4JMUC56lLnuQf+wL2B5bDlfGZ8EedAn8nh4DTYnHoT/RB9Z0SGFRZyE83ZkNp3V1teP56orBumQEDk4F4eWUF85LuyEz0wp3ZlxwDKMN3mB44NIsPxRkh2B9Nvns5BwaunJScCUzF+fvlcuDR3MVZJ15RTCUNxR+zJoA++Vb4M/5c+F0djWk2RvhxoL9sLjwHDxfeA++yGHjfuOc0fBj7ptQxfsZ7uEJkc9j/JfgQf5ROFQgQIaHBfPhE8ILsEH4CHIuFn0IvxZ54QNiE7qoEx+HLMkj6GiZZDNsk+SiwVLpMvij1A+LZFb0+5HsNvTKqtC7Vv4XdMjLMQ/ZiuuwSvE85uRbxV2YUczD/GiVMbhO+SHm6ryyFyYtrDwCRdhXsRLsq2rdeOyruBb2VbLvNXWRPbAySfZDKkn2xtoU2SeL02TPbE6T/dOaIXspg+HUfYl91anbpRqZ5dRtV/0JP1Mtznbq6lTcHKdunWof/FD1DNOpq1b9CxepqnOduhdU8jyn7jn8+nXqHlE9w3LqOpXX4c/K2flO3UplCI5Svsl26vyKDNyuWF3g1GkVrEKnLi6vgV/IWRynboJ8NXTJMnC1bBnXqXtQFoAnpLN4TqTnhG2SCXyn7k3JtzBfohA4dZvFK2Af8X3oED0rdOoGir6Ch4TZIqduuHA6/F5whLwWFIrxPv8FOJB/EDp4GfggTyvBnXI3Qz73JlzN6SF16mKFJvhS4XJ4ueBz+ETBYfgZ+wJM5/9N/prvhhdYcTiAlSVz6tbnFUIqVwIrc3vCE8yHYW/mo3BVTjFsyx4ItdmD4bdZT0BR1nD4OoP4T2YYHJsZAnelH4e56QHwf6n+8HLyITg42QPWdYlhorMATutkwNMdFFZS1NEGaxLXoZ8+B810A/whvgX2ir8GV8dKyF8pFayibuOuL0Y/g2OjBng44kNrvdtegHdbf0WbX7WOgotb96BlTSsH9mldgvZzW69jEiKu0fC+awcm5G9XDvzDNReTc8l1CVN03jUI/uzaiOk65YpnnLqTrucz5PXJNHn/QXjB9X4Kd+dqTzqxb5fAO65DXeTMSihsXdXp1I1pDXWQNbwIv2n9I+HUBVqfgU+0naCduuVtQ+D5tn1xp07sfhjOcm+POXWN7h6woH0bhXew3+Lq7TuiTl1PTxF821Mfcer+9YyAk7xnw5gQrwX29rWGMPO+5ZDhF8PX/N8EnTqvfwq0BtoDSCawFk4LDoE3g3/78Tq0Ct4NDYYvhe/4nDp3eD1cFJkA6UjCiyci2gALqQVwKzUAPhKjPE7d0dgv0BCvh+54HVxFr4QPJBbDY4mXYFlHBQx3lMBPOjXw0a4x8FzXCDgzORSmkoPgZ6liOCLdH15N94WvZIpgAYO83ssg70/MGgDvZg2Ey7MHQ0XOMNiYMxIameOgjzkJ1uSaYVHedHg6bz6cxnoT0qw1cFP+F3Ag+zt4kX0eWgtuw3RBnKykUIR7HMoZBi9xZsCZ3G0wwr0L3+ENQDIsfjVcy/8dCgSPIL1NgnehWPgP3ChUI2G+6DO4RtQFc8Qz0cJb4oswIB6GdmZIdsErEgG6e0r6HtwnjUOh7GU0+4bMBW/KZqDx0fLb8DP5NExCTH4LlihexITsVtyHccUCTM5EJQ0/wk6LbPELFk+0shEqVHrM3jBVO9SqVmMmX1T17iI74YkusitWJMkOGU2S3XJ9iuycA9JkF72QJjuqNUN2VwbDVvIzdlpbyU/4BWsrOam6Bo+rFmXbSo6oCnNsJQdVX8O9qglMW4lddRuuVy3LtZW8oxLl2UrmqPZDjeoplq1Epvod3lROzbeVbFW6oEG5kG0ryVJG4HeK1wtsJS8qEpCtWFaId+RxWCZ/lWMroWV++KlsNtdWMkx2E/4q1fNsJbOlJ2GHpJhvK1kj+RQqJQyBreRr8Vw4RPwLPCYaILSVPC36CJ4RtsJnhONEtpLzgk/hMwIf/Jn/lNhW8hR/HTzGuw2H8vpLbCX7uYthH/yOtZXUcSiYy+kvtZUswX5rK7lVsAhOLPgA7mNvg3z2Abg0/zj8m3UBPsW6Cr/MuwVZeffhglwv/J0ZgcOYNNya0wWT2Uk4MzsNz2VlyWwlj2blwE8YxHAmG5ZnMvjr8TQ5/oF0Ar6XisG2ZAhqk254sKsFSrquw2Wdl+Htjp/g+I7D8OvEbliY2ABt9HL4V/wFODY+kvw1VgiFsau40xXUBhiJToHzogx4N3IEyVRE5sArYRnUhn9GehdCC0mSIQk8FzyGhJ8NToMXA0nkrw9sg3/6h8MX/TvR3SXPo3CO5zt0muMZAXe3H0PXz7WPgn73UczAFvdwOMHdgNkIt/WHe9q2Y2amtwlhj7aVmKWW1gCm60BrFXy79SdM3fOt/eH41k8wh4NaI5jMh1rLoaL1BCZW1NobclpXYYZZrW2YamarDma3NmSIkgx5Z1ma/PV2ylbCbR0Pxa1fJW0lPVsL4cDWJV2469ZbnbaS11onw/2txzpsJa2txbBf284E+m2TwkNta2lbSVdbDnzO/XbcVrLZnYjhSPdrcFR7lLKVbGxfCn3tdNRWMslTDR0eJiz0rovYShZ7VfBv7/4wsvWNgY2+P0K2kr7+eXCrPxtyA9uDtpL3A0/BTKAlYCupDq6GncFi+FboLz/mKvQeXBEeApmR/3y2ko8jm6EoOgV+Hs2Gfakmr62kgXoLjo2Ng7/FhHBW3O/B2eLX4Cb6JByY+AZeTOyA1o6NMNNRAz/vfAeO6HoDXu2ywZeTCyE79T/4VWo2HJ+eCW+lX4DLMtOhhEFeNzBmQG3WS7Ataw5clT0X9s5ZAE/kkLOVM1+HESa5yrrcD+GjeeTqZ/O2wxkssqouFlnhlvwrcAj7P3iJTcM5BVzcC6PwEbitcDx8gjMLXuJ8Amdyz8IoNw85rOAZIZu/A67nR6BY8Bxy2yLYAWXCTrhZWI5sRaLv4SciOZJniavhO+J7MCouQS+zJcfgn5J+aG2idCs8KC1EmwrZSviOLAH/lS1B1xPkQbhT/jImISn3wzLFK5iQA4oITCvexOTolGSK6pQb4VVlX0wXU9UEi1VlmDqtKtBBdtoaTGO16mHM5zrVyS6yGz+fJDtzLEl26Q0psmM/nia7d3Oa7OTWDNnVGQyO3o0dnqNvww7P0d9XOeFdlS2bo/9Hxcnh6J0qB7ys0jA5+p9ULbBRtTyXo/9SJc3j6NeovoFzVRNYHP2TqquwSzk9n6P/XtkKFyhfYXP0PZVReFnxRgFH/6aiAz6keLOQo78op+FC7PAcPVfuhwdkVi5H/5zsH9gi1fE4+telTZAtfZTP0W+T1MF+kiQ8LJ4l4OjHis/Bs6K+Qo5+sug9eFl4G5YInxRx9L8KPoFawb/wAn+omKOfwF8JT/B+h8N4SglHv5/7IuzN3QE3cG7ATGGelKOfX/gYvFrwDFQXPA+3sxfCbHY1nJu/Bl5mbYGDWTthXd4+mMhtgNNyf4CnmT/CIuZPsCbnLPRln4PG7POwMesiVGRdgtUMYkuGvKPJkGP2pk/DwjQ5w6LUMXgteQg+mdwPP+/aBTOd5OrWzo9hc8c7sLhjEdyQeAHG6SlwKj0Y/hTnw/5xF+5uY+wguUdqMbRRA6Ar+i/SmBrdDK9FnoO6SByJnQ/vhhPCJfBUKIZUnw5tg6eDY+GE4B0kfyGwHOoDMviX/yB6meV/BgZ9N9Dau755UOSLoU2HdwUc7y2Atzwb0PWbHhlUerZiBpralXBW+6eYjYJ2CfzevQ4zM8edB1XutzBL19p8mK66tufh1LY5NDnmbpyjZ7ZXQUu7M4bc2s0w1X6V4ujLPKXwO8/1KEcv8L4Al3jbIhz9de8S+LSPAff7NoQ5erm/L6zxnwhhev0WaAsEg3giAuvgzOAgeCd4LYBmQ2/BW6Ei+EL4ip+j/zf8DpwTGQj9kaFeHENLvST/jIejr00EPKSXFnihwwlf6rwI052n4bauo3BE8hC8mvwWvpLaDwvSX8Gv07vgxMwOeLfb5QzyjjxrNzyc9TU0ZO+F3ux98MOcb+DDTHK2U8xjcGruT5DOvQQ35f0FB7HuwV9YETgnPwfrzGKT1drZ/eGTBWO9ZOYtcGHhKzAPOyRHv4NzBI7guuEv3L4+jr6KtxDe5x2FL/PZuPcIfzp8XXAYJgRc5LNMOA/Ghefhq6J+yDAgWgPniEPwlrgKORslZ+HPkiHIf4h0F9wulaCXfNlH0CZjoDWn7C04Qh6Hm+VL0WlYHoVaxWvo+ktFB4wr3sUMPKvMx1RsUG6GV5X9Etg3VD8myL5k6UBfKh98V/VBJ54g1YNdmA1VUxfZ0yqTZH+jkmSvq02Rfa84TfbA5jTZD60ZsjcyGA49q4cd5vVQZzn0zB5OmMEvYYe+A7+EHfqoai/0qiYyHfp/VXfgNdWbuQ6cX5zn0DtUB+D7qqdZDn2Z6jeoUD2f78A6/4MfKOexHfonlX7Yqlhc4NBvVEThGMWSQpxNHoSr5f/jOPRF8v/gT7IqrkM/TfYrpKRP8xz6NdJvYU+piu/Q10tWwZESDzwrNggc+hLxd/CaiC906CtEC+DfwnPweWEvEV4LXoUVgnPwKl8qduh1/FnwHO9bOJYXg4e4IyS4OtcG6zi7IIPzstSBeVsMP8x5FfqyicbspbAx63WoyFoGqxlvwJbMa1CTsUFHegXO8GlsCsyNFcA3qDO4ij/6BrRGH4W3I3+TVUU+gNfCQ6Ap/DfWfCX0LjSFHoLXgmdwX5XBmfBuIIX7nRvYAiP+YrjCfxqZ8P0m+KXvDrJS++bDK94oMlzgXQ7zvQzo8KxCwlM8TBhqX4XkP2tnwGfa30IjlDuMjva7rXCu24nuit1VXiTQMQl+3jEKjuh8HF7tfAi+3KWE7KQQfpUshONSLHgrlQWXpZMeh16S6YANGRrqGAnoZnTB1Vkp2CebeCI7DStyyKeiOXlwPZOcbUCuCF7IVcFZeUUwnTcIbmONhcPzdfBK/nS4gP0KzCt4D+4q+BSOLmyAfxb+Bl/hUDCX+xXt0J9RDktgnpUX4DDV1A60oArD9aqPOh36w/hd4dD/it8VyFlVlSRzHkuSmd+QIvNfnCbPQnOaPBfWDHlGGAyNoTeeF43hATwvGkMPPC8ag6yHLVtjEPbg5GgMBT32wuweE5kaA43nRWNw43nRGP7E86IxnMDzojF8iv8cNYbZql9hP1VlvsZwV9kCNynnsDWGiUoPDCleLtAYPlcE4ETFwkKcR+6GH8lncfAp+d/wjEzP1RimyX6CEelQnsbwgXQHlEvZfI3hK8liOFhyHR4XjxJoDOPF2+B5URxOFpmEGsMvwn1wsjADLwhKRbiWYDc8yQ/DEfwxYo3hG94q+DDvHNzMTUMm9w1ooIrh+ehtHPl09BN4LDIKDo/cx9kOh9fCJ8JDYGPIiSs+GVoKTwRFcELwG6zqUuAZWBG4iTXf978Cl/ozuBeWfy3c7pPDEb6duNOr3n5wkbceCfC9g+Bhz0EkU+V5HOZ49iGxhvaH4Kz2LUiyZ/sJL1LtqIfLO3dAWVcdPNT1ESxJroTtyWr4fup1+GDaBn9Mz4dVmbkw1u0Gxjz4eBZ5/2LWAjg7m7zOylkIv8hZBEcyX4V/MpdBW+67kJP3IXTkbYAalp2shLWPrCT/KFkJuxl+x/4b6gr8sK0gx6cxvFfYG/bgjIeHOQvhZO4ueIt7Fy7g9fVjong2+C7/NMwViAIawxrB7rjGwFM+RmsM05WH4dfK8QlMi/IK7Kua2aExvKii4CbVmk40i5nXGO6ofoRRzDzupQeVJHNbmyIzXJwm89ycJrNtzZA5ZzBaDEMx8y2GIZj5FsNAzHyL4VHMfIvhYcx8i6EnZr7FIMbMtxjye9yBCcx8i+GeSpTXYjiv2gd3qMawWgzzVb/Ax1SW/BbDv8qbcJNyBrvFMF55D/oVswtaDFsU9+EYxczCFsNd+S34jtzCaTH0kP8Cj8jGclsMOtm3sEXai9diWCKtgVnSMPxEUs5vMcglx+B2sUrQYigSL4N7Rddgf9EAYYvBIVwB+wqd8EvBI6IWQy/BUriFfwpy+Sxxi2EVbzKMcVdCK/cSPlsYfgWuC/GgOHQA598WfBY+HLyD6x4MLIVjAyz4q/9TrG2mvwjSvoNYc63vSVjsO4l7+cU7AS7wBn0tho+5/fxIjzcP7uc1wGH8FGzi6wIthgmCHfCCIAqnCLXBFsMl4VdQK8oKtRiaRTPhRPEZ2CR+NNxieEKyAe6VpKBCuiDSYvhQehNGpfpoC3aJM/CMbDTVgt3je/ihfGisxeCSfwfHKYbGWwxbFUegTzGaxr0oz8A1ypJEi+EP5T9QqprX0WIoU3XAWtXazhbDz6qirhZDG/ZP5N+jKtmC+aFgD8wSmY3iNJmT5jSZGWuGzA+DUW0ci1mqNo7BLFUbR2KWqo3DMEvVxoGYpWrjI5ilamMvzFK1UYhZqjYyeizLrTa6VcK8auMF1ddwm+pJVrVxpuosfEBVkl9tvKa8Clcpy9nVxkHKG/BvRVVBtXGF4josUpgLq43n5JfgLPl4TrUxJTsC62T9uNXGR2VbYJM0m1dt1EoXwBuSq3CWZDi/2ugRb4aLxBSMigyCauNror2QEqbgYqFRWG0MCHbB/wlC8D/+GFG18Xn+avg77wKcwHvNX238hdsAp/Io2MYbE6g2LuHXwE7+dbhC8Giw2pgrfBt+JHTCAtGgEF6L1sI8sRe+J9aHcby4EdokvSLVxvuSj2CZlIZnpPOiuHfZTbhVZqbIPV6CM+TPxqqNp+VnYE/FxHi18XXFOXhZMZmuNvZW/g4XKSsT1cbjyv9gtmpRR7XxOVUKfqBa31lt/FHVtwtrRstYCVquNirRcrWxL1quNj6OlkmDzWnSpjVDmmUwFKbhaFlhGoaWFaYhaFlhKkbLClNftKww9ULLCpMELStMeWhZYYqq3shVmG6oeHkK03eqL+G7qiEshWmcqgl2KCfmK0z1ymb4vHIKW2FiKi/BesWUAoXJpDgPo/JxhQrTBvkP8HF5MUdhOifbDqfKuFyFKSB9C74jvQ8LpVqewrRFchA+IBHwFaY94ldgP/FFuE/0kEBhelS0DH4tvAQfEvYUKkxfCBZAmeAHuI7PEGEN/IlwGe8SVs73DIad7ZtxL+52ZRJHej7sUpj0nkSnwrTWk/IrTNm8UQGFaSOvGvbmn4H7+dygwvSEYCo8IaiH44RZIYXpjLAKakSHyWuRIIz3xTZ4QuyET0hGRRQmh2QP7CnlR3F+6TuwUxqCs2VWSmH6VXYTDpWXxRSmTfI/YERujCtMJYor8CtFKY3jFTegTvliQmHapnRDl/LVDjSlysKaX1ZthHtV/XAXf6pOwQS+LxQmHtrHddE+abM4TZptTpOWrRnSOIPRaBKi/UaTAO03mjhov9HEQvuNJgbab8R59kI//qdoNN1R3YbNqtdzG037VJy8RtPbqi+gRvUYq9GUpToMf1COzG80zVX+CMXKp9iNpibFSThLMbqg0ZSr+B5+JR9Y2GgaL98Nb8pknEbTYtmHMFdGwc3SF7iNpoel5+FByQBeo0kt+QSeFHvhBPFz/EbTWdFOqBHF4c/CKYJG01PCz+FRQTscKhghxAr578I+/LOwjpctwvl5w+Fi7lT4D+d1OI7zMfy68AtYWPgNtBU0QSe7GY5kO+EX+bdhVn4rnM3yw1/yInBgHg035nbBODMFn2dm4Mkc4kM5afhBNnnfk0XUZ5F3DjHIaxkjAd/KhOGddDuckP6XrCT1DyxIXYGvJM/Ca13fwye79kJ75xayks5VcE7HIngpUQWHJMbBT+kimIqXoZFtnhPo6G3Pg3Cu5wO0ZvF40aPGY4BPehrR7yCPAj7qqUbjD3taMAMPeDSwp8eRIXJgb48t3Wgq8jhTuF/PSPi0Z1ey0TTDw4UbPNVdjabLHn8n0vPOgCVeZwcy8U6B/3h/SjSa+vpGwiW+RrrRdMY3BCr8g8ONJmn0Rghrjq6GKmoI3E79F8S1YpthfWwKHB7PgqfiJwKNpin0MnidXgEH847Dn3gd0Mgfg2Nu8d+HcwTXYEDQF2dbIlwOY8Jr8DXRQFyREq2Fi8V+6BWbIo2mlyRH4Q3JQ1GcX7oOHpemYT/ZYgp3J2uDtOzFWKNpqvwfeEJeEcf6FX/BJYpK3MtFxS3YSzkL9/iy0gOPKZd2kGchC2lMxFNJnpF+SKkeT2Wj6QqeykaTG//pY2bwnz55yorT5IlrTpOnz5ohTyKDYTTfUNnhdZU6y2h2qpzwN5Ut22i+oOLkGM0nVQ54CE+l0bwTT6XR/IHqtVyjeaaKnWc0D1ZthRHlwyyjuV55AL6gHJxvNHOVh+FRxRNso/lFxSHIVAwsMJq/ku+FE+QPFBrNt2Ub4WsyJsdoLpAtgZ9Lb8PHpM9yjebvJQfg0xIez2g+L34FasW/wF9FRXyjuUS0HF4W/g4nCR8UGM1nBDY4RtAEG/l5QqN5AF8Hd/A+gULeWfgu1w/bOQUio9nA6QOPFA6FysIJ8J0CI7zHng6fY8+DB/KXQH7+W3ApayW8kfchHJO3Fu7MrYU5uRvhXOYmeCmnDg7KIe9syt4A6Szyemq3pxjknYcYn8APMu9DT/ptqE+/Bg+nXoHylBUuT1bAu11ToKZrFHR0Pgq5nTK4pCMLXk94cC9jE1fgbvogLKDHoYuMZy/auevhwvOeJejrsOc6GtztGQ23eHag2XWeHPihZy66Xum5hPbf9gyCyz2bMkQ6jaw8U9PkmNMpo7nO0xce8KxLGs1XPV1dRjPLuwBqvLc7jebVXiO84D3XYTTzfKNhpe9wwmje4yuGUZ+DNpqf9feDX/gdcaM54R8AywOHYpiQwGj4QPAChWsFK2A06IkazbNCK+CfISWcEj4SQb/hMjg2QoeN5uMROxwZ1ZDX0WAI71NfwJ+pEjgpxoBXYo1BrCS+EN6L94Wv0PcCRnMXfQGe48bh87zH8L6fNxu+w98LOYIw3CwYhzP0FNbBHUIPfFA0Edf6UrQD9hFn4OfimViPVHIefiwZiHUypJ/BJVIW7qJF+ibUyfywUWbFPSrlt+FyeRXu/R/5DTgCzzW6UNyE9xQzkNVwfNsazauUS5DhJWUGclUbkO2zqkeQ9lL81jKaP8VzbTR/i+faaP4RzzV5TovT5JltTpPn15ohzzKD4TN/gefaZ7bjufaZt6r+hBtVi7N95jV4rn3mFXiufebFeK595qmqW3C0akmuz8xXMfN85hvKDXCLsgfLZ9Ypd8GU4pF8n3m/wgFLFf3ZPnOn/Cv4hbxPgc88Rv4ZvCHjFfrMS2QrYb4sDLdJp3N8eKIvwB8kA7k+83jJRnhRHIEGsZHnM/8h2g/Nomy+z3xFWAFLhPvgRUEHnCB4VuAzH+dXCH3mGu4HkOI44FTOafhT4TX4SOE9uKYgDIPsNCxls0W4Yr4Y9sjvAd9lPQTv5fWHz+U9Dg/kDoH83CfgEuYw+FfOcDgqh7yzPXsozOp2dhZ55yKDvH6cQT67IfMIjKV7waq0FP6Y4sE+qRz4fpLGGtq72mFJ19/wUGczlHcegcs7dsB/Ex/CZxPz4Df0eCijByHzud5P0cJ4bwqNPOKdBYXeC2gqyzsAxjzr0aDfE0WbrZ4K2OI5gZZvenrDvz3vZcjr1jR5Xwt9nqudPjPT9yyc5DvR4TPX+obCm779CZ+5v78IvunfRfvMv/kfhP0Cu+M+8+pAf+gKfBfzmScHx8Dvgr9QPnPP0FS4JhSK+szJUA1cHC6C7vCZiM/8UsQK70bY8IVoQ9hnvhOdCmdS+bCVOhrymRfG5kMq1htWx/8K+sx59I6AzyztqoUNXe9BXfJ16E6+DFenZsM+6Wmwqdv9eS/BZ1kL4X8scuQ7+Suhir0Ofs/+ApoKDkJfwU+wpvA6fIgTgj9yeLhiOfcJGOBOh6t566CCfxHu4/OwquGCqfBHQT2cIMzCys8Lq+BzosPwgkiIu9OIl8CT4j/hk5IxSKBe8hXsIxUhn1rpezAljcG5sgVI7zfZPThE/gJS3Si/CYPyqUh7suI23KmYiRaiCjecgGffZ/4Yzz4+paxFayw8+z7zCDz7PnOlqjJJnlkKrlStT+FI1QC0vAnPvs/8GZ598rwzGDWlc/Hs15TOxrNfUzoD3+k1pVX4Tq8p1asKc2pKx6u+hgNVMnZN6Xr5RjhEzimoKf1dtgrOl9EwSzavsKZ0i/Qv2E86nlNTekTigOMlXG5N6UXxImgQnxLWlEbzzsGKvF/gidxfYe/c3+Eq5hXYlvMH1OaQ1wezf4Pibt/IIsfcZJDXTzHIZ7/M/AxZmanMmtK3vaexwpe9feEM70dYeaXXj7sweU1wivcI7u5ZrxJqvG9nyOtv4zWlDwSHwxXBU7Ga0tagDhpDt6ia0h9DNvh4mAV3hr+M1pTKI+PghkgqUFP6Z1cQLk7eg5zUP9CRugY16YuwJf0TrM40QQXjOGzs1ph1AvqyjsGa7B9gUc5ReDqH/HUakxyfYJ6Cdbln4eC8X+DlvD/gPBa5CjP/PtyZH4Kj2Wl4nc0N1pQuKegNuYX9wjWlU4VvwzvCP+ELoiGRmtLbovWwShyGV8XluIvJkpPwpKQ/7m6wdAvcIc3HvRfIquESWRRely1EMiPlbrhVPpdGa3I31CoWJHC84tGumtKg8jSUqZ5P1pQ+oYrBZ/H9UlNqxvcLVoIZqymdhRmrKZ2DGSuyDMGMFVkGYsaKLP1U12AP1bRkkcWvjEOWakOqyCLHZ4ssD+OzRZYB+GyRZTA+e9oSVNqhR6nOOm25o5yePG3Zgk+dthxV1qZOW35XFqfJ+82wXWnNnLYElNzItLJRfDM8z7dDg8AL/xKMjU4rmyrcBO8IffAF0cSuaWV7FFdgq2JmclpZb2UCTlFuSE0rm6MUcxJlHwtegkzBt7CaT8MIbww3UTaH9w78m3sMTuY2RBJlP/OC0MgfHk2U3eS/B62Cq7Bd8AiVKHtZ+DYMCK+T16IRMbwv+gzOEjPiibLr4vlwsuQ6PCZ5lk6UPSI9DtdJn0gkysLS72CJbGhHomyP7GhuXfll6di8uvJq6Y+wSKpm1ZWfk3wHZ0n65deVp8Sfwy3iAnZd+aPipfB70Q34tEhdUFd+VrgJPiv0wHOCpwrryicI1sMf+bfhCH4/Tl35t7yX4cO8g3AzNx2tK9/OL6FwLcFO6BDE4GNCQ6yufJ/wW9hXJIrXldtFyyFfvMxbX2KLL/NSJRx6mbdY76Alvr0l6pjEp9Q74Rt6W1ziu6Dn4P1CA/nrMwZNQuJ71dACNxmqO3C8QdEp8R0yNMLvDcYuie+owQePGWqSxKIU8XS309LERLd1GeJgBvFyt/OyiMxsie+4YWe3Y3KIN7pdyiQKcon13U7KI97vdgWL2DOfeLRbC5ucLQR/MKwtICvsXyjxfW04C+fqh/EafL+W2KkGn06vjjX4juJ+G3xygy3e4HvFwKEbfCdxvw0+plGTaPA9ZWyBc43VHQ2+lUZFZ4NvnbERbjYauxp8nxp9cKuxJkksShFPdzstTUx0W5chDmYQL3c7L4vIzCbu7HZMDvFGt0uZREEusb7bSXnE+92uYBF75hOPdmthE0Nssp61BQ2+OmP/wgbfWuNZ+KZxBqfBZzYm4d/6Kzyd/2oJg9L5p+vt8A8koPOrDU64DQno/AkkoPOXGh3waySg83uQgM7fw1TdofOPMik6dX6dqRFaTMYunb/C5IOVppqkzl9lKkoRT3c7LU1MdFuXIQ5mEC93Oy+LyMwm7ux2TA7xRrdLmURBLrG+20l5xPvdrmARe+YTj3ZrYRNDbLKStQU6f7mpf6HObzKdhRNNMzg6f19TEnqNW7lu/9kSa9Ttr9QzKLf/T+Tg9k8wqGNu/z7k4PYLjLa42/+GkUO7/beRg9s/0qRJuP0fmFrgSeTg9t9DDm5/B3Jw+3PMxi63P9/sgwXmmqTbX2guShFPdzstTUx0W5chDmYQL3c7L4vIzCbu7HZMDvFGt0uZREEusb7bSXnE+92uYBF75hOPdmthE0Pdri1w+9nm/oVuf675LOxCDm7/feTg9h8xbeWuDnxT0hxZHZist0ZXB35FGqsD4w12WI80VgfkRid8H2msDsSQxurABeSwOqAyt8Aqc3XH6sBqs6JzdWC7uRHWI4fVgcPIYXXgB+SwOnAUOawOHEMOxGlpYqLbugxxMIN4udt5WURmNnFnt2NyiDe6XcokCnKJ9d1OyiPe73YFi9gzn3i0WwubGOp2bQFZSf/C1YEjyAF3bZ7BWR343Jzk9AluKSmO9AkO1zfD08ihT3CkgUH1Ce5HDn2CCqM61if4EXLoE3TgrvvgV2V1R59gr1JFZ5/g2NLGzqbgByW14aZgkb440hRswHmagoMM1mhTcA/O0xSUGe1wDc7TFLxm1iSago+XtsDXS6s7moLf4DxNQWf3efDIdTUFU6U+mGepSTYFCy1FqaYg13Ia8izT0k1BviUBBZa6TFNQaBnMIF7udl4WkZlN3NntmBzijW6XMomCXGJ9t5PyiPe7XcEi9swnHu3WwiaGul1bQOxfSK5+tpCsaganKciwJGFb6VZuU/D70mG8ytC7JVSoMqTU14YrQ3uQRmWor6EZbkcalSGpkUFVhj5GGpWhNrODrgzpSzWJypADaVSGokijMjTYouisDL1oaYQrLMauytAWiw/uRhqVoQNIozJ0EGlUhg4jjcrQEaRRGfoBaVSGjiKNytAxpFEZOo40iMzsytAJpEEck0O80e1SJlGQS6zvdlIe8X63K1jEnvnEo/nkPBY2MdTt2gJi/0JyxbOFZA0zOGRtSQ5Z7VZuZWiBhaTxoOUKPFy6kE8hmcoQFZLqKfgF8qFCvQzFESr0GfKhQhKjNUqF1iEfKhQxc2gq9EKpA55GPlRIYWmBcyzVHVRoH/KhQneQDxVilRm7qFBRmQ+OKKtJUqGJZUUpKqQtOw1NZdPSVKiiLAGnltVlqNCLZYMZVGhm2WX4Utm8LCpkLWNmE3d2OyaHeKPbpUyiIJdY3+2kPOL9blewiD3ziUe7tbCJITY589oCKjSrrH8hudZZOL1sBocKWcqScFzZVi7uqGwYjwo5kQ8VetlC8rlXmi+oDX9Q0hSsDSv1laHa8BfIqjbcw1Abrg1/iqxqw1JjM6xDVrXhtNkWrw3PL+XQteHfkFVteIBFk6gNr0RWteEryKo2LC9TdNaGS8sa4SpkVRvei6xqw6eRVW34D2RVG76LrGrDXmRVG44hK5wZWdWGc8sHM2rDBeWXIbd8XlZtmF/OzK4NC8p3djsmh3ij26VMoiCXWN/tpDzi/W5XsIg984lH88l5LOzaMK88xCZnXltQGy4s719YG2aXny0k153BqQ0nkVVt2I2sasM/I6va8IqyK7B32UI+krGQrBiWPdCk10mKI1tK+gSLI0X6JrgH6RVHehko+CnSK45IjcWR4shWpFcc2WZWx4ojvFInfLPUFi+O3EaGxZGRFgfcgAyLI/eRYXFkWFl1R3HkHWRYHDmFDDGtyBBnLvfBMeU1yeKIpbwoVRz5X/lpuLx8Wro4srY8AT8vr8sUR/Yiw+JIAzIsjnyPDIsjx5BhceQEMiSOycF+iQyJS5lEQS6xvttJecT73a5gkeN75hOPwuPIsDhyFBkWR44gw+LId8iwOFKPDMl1Z3CKI1+UJ+Ga8q3c4sjs8mE8fBaJFUcklnHC4shrerekOfJNyepAc2S4vk+wOdKA9JojfQ2VoebIZ0ivGbnVhpuRW3GkOVJvtlP4fihVx5oja5Bec8SP9JojkywcujmyHek1R8JIrzkyoawFbkB6zZFbSK850ru8EVaUG7vwTYv0miMOpNccuYD0miP3kF5zJIX0cMWKBHysoi7THBlTMZjRHJlScRlaKuZlNUeqKpjZzZFpFTvhCxVjcog3ul3KJApyifXdTsoj3u92BYvYM785Mr3iKJxaYWFjPRUhaKpYW0Cu0r8QK684C0dWzOA0RwZWJGGPiq3c5kgH0muO/I7cmiP9Lbfg66XLRHgW9aul1ujZErffGp2sXx2wRk8jSWt0kKEJbkeS1qjEiH0hWockrdGjZgaFv5ba4TYkaY0mkaQ1Wm6xxa3R/UjSGu1CktbolDJNwhrdiiSt0VYkiU+VKzqt0SVIEkciSWv0HyRpjWZX1CSt0X4VRSmsoeI0nF8xLW2N1iBJa/QrJGmN/ogkrdErSNIavY0krVEXkrRG25GkNepFktaoD0kSlzKJglxifbeT8oj3u13BIsf3zLdGPUjSGm1Dktbov0jSGr2BJK3RX5EkckCS1uhhJGmN7kGS2LGQJNZfMYxnjY6ruAJbkKQ1OtayTGSNbiyViJGJvo+MQV0r0fkZVJXeDX9FqgxqlKFPkEHtQaoMSmqsDDGodUiVQR01W6MMangpg8JfkSqDYlnUMQY10+KER5Aqg8op49AMyljmgHakyqDakCqDGlpe3cGgliFVnAepMqggUmVQvSt8UItUGdSrSJVBbUOqDOo0UmVQLqSKq1TWZRhUUeVgBoMaXXkZaivnZTGoskpmNoN6vnInnFY5JodBTa+80e1SJlGQS6zvdlIe8X63K1jk+J75DGpq5VFYUWlhMyiMD5xYubaAQQ2r7F/IoB6qPAv5lTM4DCqJVHEvSJVBXUKqDGoXUmVQL1Us5DMoP1LFGSwSMYPaX9oAa/VNMjuybfDZqRf1Or+d+gsJ26nxhtUBO7UfCdspmbEJfoyE7VS9uTlipwaVWqN2ZIvsqEKLHc5FwnbqBBK2U+wyW9xOWZCwndqOhO3IVpPAp8pb4OtI2I5sFZ12KoqE7dSjFcYuO1WFhO3UB0jYTn2HhO3ULSRsp/Iqp6Xx2coEtCBhO7UUCdupT5Awzo+E7dQ+JGynvkXC+M8VCeMMSJi4lEkU5BLru52UR7zf7QoWsWe+nTqIhO3UASRsp3YjYTu1BQnj9z4StlOvIGE7VY6E7dTYyiQsqtzKtVP5lcN4dqoVCdupI0jYTi2qyBfgvpAw7sjSAI+U6iR26jV9pVwdO1si8aljVfoG+BfSVsc0Bjf8BmmrYwpjn6A6tgZpq2PbzMUR/L4ubYbbkLY6xrIwKHVsLtJWx35E2uoYp8wJy5G2OrYDaatjrUgb32PlmoQ6thhpq2OHkLY6FkLa6lj/ikY4DWmrY2uRtjp2HGnjfzukrY7JKk/DiUhbHXsFaatjm5G2OnYEaatjvyJtdew20lbH2pC2OuZF2uqYH2kTb3S7lEkU5KpjPqRNXk/KI96HAaRN7JlP3jkKPUhbHfsPaSMNpK2OnUHa6tgBpK2OrUfa6pgNaatjZqStjg1H2uqYtPIKDCBtdewo0lbHFlXsgWGkrY49b9FJ1LHDpW5o0lNyZ+ybkmVeZ2yyXuJzxn5F8s7YeIPOj/eRvDOmNK4OOJF5n6AzxistjuA1MnfGksjcGZuJzJ2xE8jcibTVMWesApk7YzuRuRNpc2hnbEC5A76MzJ2xemTujLUjc2fs4QpFpzNWhcydsY+RuTPWhMydMR8yd8Z6VRalnDE9MnfG3kHmTtx1Av6BzJ1IaTDDGcupugyFVfOynDFFFTPbGetRtRP2rBqTQ7wBVVVLmbiLKkEusb7bSXnkyPuwV9UKljP2QFXPfGesd9XRfPKOhe2MyatCkFO1tsAZ60TmTrRwFp5B5rg7ZO6MvY3MnbGpyNwZG4XM8anKhXyy/nyBM3YImTtjL1WMEzpjHmTujJktbrindLXUFt9Scstjiw/XL/Pa4qeRvC0+ytAA9yN5W1xhdMM1SN4WT5trw7b4m0jeFvcjeVu83GKN2uJHkLwtzi6zw3Ikb4vvRPK2eCuSt8UfK+fQtvh8JG+LO5C8LX4PydviPSuqO2zxUiRvi3+I5G3x40geZ0bytnifypqkLW5B8rb4R0jeFj+B5G3xNiRvixdU1WVs8YerBjNs8WFI3hZ/Csnb4hORvC3+DJInjskh79yA45G8Lf40krfFxyJ5cvykPPL+/Txy5AqWLT4ZydviOiRPtLBt8UlInhy5tsAWH1jVv9AWl1WdhTSSt8WvInlbfB+St8VXInlbfBqSt8VHInlbXFSZL7DF/0PytvguJG+Laytuwf/Kl4ls8X+RP9ZmIfl/XNpHxqE/KBnn4dBF+luwAV1w6EEGiY9D70EXHFpm1Pk59Bp0waFjZirEoReU1oY59G10waEnWZrhAXTBoXPKGBSHtqALDr0DXXDoVnTBoR8rt8U59Hx0waG/Rhcc+i66wJkrWqAOXXDoleiCQ/+ALji0F11w6AcrfbASXeB/FHTBoc+jCw6dQBf4a1UCjkMXHLoMXXDomeiCQ89DF1ghuiDuhPPRBXn/BrSiCw49A11w6BfQBYd+EV1w6JfQBTlyBYtDL0EXHHoZuuDQy9EFh34DXXDoV9AFOb5/IYeejC449ICqGRwOnVuVhP+gCw79DbrAvaALDl2FLjj0EHTBoZmVe+BldMGhV6MLZFKxTMShz5VLxLjH8gb4Jxrh0AMtpJFXSptkDvrdkj3tDlqpH+dx0HvQjoPua1jmddDb0Y6Dlhob4Mdox0GHzZUh/O4rpeBVtOOgR1uKIw56B9px0F1ox0Eb0Q4+i3Yc6EUdc9ADyp1wPtpxoBcO7aBvox0HLarQJBz0s2jHQVejHQd9CO046Ha040Avxi4H/TzacdB1aMdB/4Z2HDSz6jR8ompa2kFXoB08c2jHQa9AOw66Bu046E/QjoNeh3aIO7PJO2NyHPRHaMdBv492cNdoB9dFO8RJeQ56JdrBnaIdB/0p2nHQu9COg/4K7Tjo3WjHQW9DOw56LdpxoK+zcBracdBPoh1MXNVWroO+iXYc9H6046CXox0HrUc7Dro32nHQHrSDv6IdB/0C2nHQBRUSsYNuQDs4slwncdDn0I6DVliaZJrEOyX57ZqEVL8HfoGONIlehlvwM3SkSUiMEp8msQ4daRIxc1MQv8dLK0OaxG/oSJN4wlIb1iQ2oyNNIoqONAltmTWK3z7oSJNoQ0f4P7Ic3/qJl9ER2kBHmsRddKRJiCocUIOONIll6EiT+BYdaRKt6EiT6FPZCKeiI03iU3SkSVxDR5pEYVVRSpN4Ch1pEnPQkSaxGh3hGHSkSXyJjjSJvehIk9iPjjSJenRE3AkPoCPy1xs55MilTE3ic3SkSWxBR7gLdIS7RkeaxB50pEkcQkeaxCl0pEmcR0eaxDl0pEn8iI40iQZ0pElsR0eaxAfoiKwnCcegI7LOYTxN4i90pEnsREeaxEJ0hN8p6EiTyKocJ9QkzqIjTWIlOtIkRqMjTYJCR5rE1+hIkzjc3Q7TUilvSbxfstDdklDo89tb0NEe2MMwztOS+BRNtSSkxmXelkQdmmpJpM19gi2JBaVN8CqaakFHFNyAploSfjTVkni2rBluQ1MtCTea+j9H9x/fVlX/cTw/btKbJm1u1rTLtrB1bbp2Y2rUqt0WtejACoWla/pjs2qRqRGLDI1+C1aoWKFCgQIBKg6MUmBAwYIRCxasUKBAwAIVIlatELZ2y9Zsa9c0P7+vc/95P2qWnHPu55nmnpPiOXPJT7QeIq9Cai45gtRc8kOk5pJlbZYVno/UHEa7k3PJx5GaS36E1Fxyc7sjNZf8BlLMc5GaS0aRmkva9vVn8ERqLnklUnPJ25CaSz6I1BxVDebnks8gNUclI+TfkJpLvojUHBUOqenRzyVfQGou+Rek5pJ/RIqxITWXfASpOTRjZBgp8UynPJf8O1KMAam55D+Rmku+g9Rc8lWkRDuT5GGk5pK3IjWX9CPFnBGpuaR23zT5MlJzyZuRmkt6kZpL2pGaS76L1FxyCKm55NeRmktWtY2Sx5CaS/6+dZ58QJVaaV5a27N6+8XTR3tWN1/SNd+z+nvUelade4bJu1HrWS31zpJDqPWs3rt3/kTPanFz38me1aubyxd7Vv+NXc/qLl97omf1Lux6Vk9g17N6fsv20z2rv8auZ/UYdj2rn27VLPWs/gS7ntWnsOtZXcCOvtoOnu1ZbcSuZ7UHu57VJ7DrWf0IO0bVzqOrl2LXs/o77HpW/4tdz6pjX5y8ELue1QB2PatB7HpWH8OuZ/VZ7HpWX8SuZ3UKu57VCHY9q29h17P6LnY9q//CjvFjJ36OkjPY9ay+hl3P6gR2PavPYNezOoZdz+pz2PWsvoJdz+rb2PWsvo+daCFhEj8PFIoWasyir0mzaKHT0rM6gl3P6gB2PavfxK5ntRo7aoJdz+qj2PWs+rHrWd2CXc9qDLue1Yew61m9Crue1Quw61nd0NZopybYodDaV9qz+tnW8jKq2tKO4G98wnGxedDhSP364tqjjtTWS6bJw5g6Upv2yAuO1F2YOlJrvPXHHKl7MHWkRvY2nnCkypvnyZswdaROYOpINfjGyd9i6kidwdSRuqBl8BQtY+pIHcPUkfps64EzjtRPMXWknsHUkUpg6khVtjEbTjVj6kj9HFNH6ilMHakjmDpSm9v5XEhdiqkjNYypI/URpoxwnzftSDVh6khdjakjNYSpI/UHTB2p5zB1pF7B1JGKYOpIvY2pIxXFlN9pTBkVpowWU0cqiakjdRZTR+okpo7UB5gy38fUkXoVU0fqBUwdqb9h6ki9hKloeUwWLftMjtQ/MHWk3sVU/FxjFq+dJP+OqXhVhnwIU96VmDpS52PqSBXs67I6Ui9i6kj9DFNH6jOYMgZMHalRTB2pazF1pPZh6kjtxNSRsrfNk7OYOlIDmDpS1a3j5FPIOlIfb1ki7/EJWeZ+68Kpyktqj4ZTD+IbTjn3dM2HU7fhG06ZvMPkAL7h1Nje0Xg49YnmxhPh1L34hlMZfMOpVl/5Yjj1GL7hVBrfcOqiliXyXnzDyG4/HUZ2ivwZvuHUc/iGU8v4hlNb2+qWw4x8hrwR33Dqz/iGUwv4hlPl7buT4dQ38A2nfodvGFlHitHuC5Nt+IZT1+EbTt2Hbzj1FL7h1F/xDaem8A2n3sQ3nHoH33DqfXzDqRi+4dRpfMMp3X5JF04p+0Pkuv0ePe+a/VGyeH9ACqdy+IZTx/ENp/6Fr2gtRr6Mbzj1Ir4ix2TxiM8kekyQr+MbxrTGHFZ9RXZawrwTMuSf8A2nbsWXq8Y3nNqAbzj1Lr7h1C34hlP1+IZTZ/Hl+fiGU334hlOX4RtOXYxvOPUpfNFp6ysNp97AV9R2nNzY2r42nBrFN5za3jLo4LU+4fu75ql13vTKxUNHvOmbsPamC/ZMkz1Ye9NLWHvTP8bam9Y21R/zpv+01x73pj/dPEo+gDjP982Tl/r6TvKviHvT+pZx0tvSnvCmDyHuTc8jzqtat5/2pn+KuDf9HOLedBJxb3p72yHy64h70wOIe9N/QdybjiPuTW9uZ16b7kCc1hD3pv+LuDe9aZ8j5U23Ie5NX4+4Nx1CHHnEvem/Ie5Nv4q4N/0m4t70O4h70/9E3JuOIe5Nn0Hcm5b3+7W0hrg3XYu4N12PuMioXjwSkLzp8v2KgSvdP0ImEPem/424N/13xL1p8RvtTYu5kDc9jrjIBDmBuDf9MuLe9BuIe9NvIy5+zpDPIO5N34W4N30Z4t50NeLe9AeIe9P3IO5NNyDuTacR5/mIe9M3Iu5Nfw9xb7oVceaAiPNaxL3pFOKMBHFv+ieIe9PntC6R9pbtKH/BN7Uunj7vkqEj8fTbWMfTe7COp1/FOp6+0CsvxNP/wDqevm9v9/F4urrZHo+nf4d1PF3oazwRT38X63j6L1jH06aW8sV42od1PH0/1vH0Uazj6U+0Dp6K0/v20/H0M1jH08tYx1HWLMXT38A6nr4V63j6Oazj6ZNYx9MV7ZaVeHo/1nGufXcyno5izSf0vp7VeLoJ63j6OqzjKPPOSD+NdTz9Atbx9GtYx1GeIN/GmtdiHU//D+t4+hTWcewiZCXWVABr+sI6nr4c63j6+1jH01/HOp6+AOt4eivW8bR5f4Mxnj6NdRzx3oJ4OoJ1HNkx8hms4+k/YR1P/xnrOO415nh6EmuqinUc/YxFPGeoKJ4OYh1PfwfrePpcrKkY1nHe1cNkI9bxdA7rePpZrOPpX2HN2LCOp7+GdTx9MdbxdB3WVKatvCyePoF1PD2GdTz9I6zjaXvroCOefh7r/syTF2c+6s9cgXh/Jo94f+bniPdnJG/XfH/mNsT7M9VNw6Suuft4f+ZmxPszGt8oeQDx/sw44v0Zc0vfyf5MK+L9md8i3p85gnh/ZnvrEnkV4v2ZpxDvzyQQ789sbTtwpj/zdcT7M7ci3p95HvH+zCLi/ZmK9oNn+zP7Ee/P3IV4f2YG8f6Mbd8ceSHi/ZmrEe/P3Ic4n9+I92deQLw/8xri/Zk3Ee/PvI14f+ZdxPsz/0Gc9wLi/RntfremP7MR8f7MeYhzLYj3Z3oR78/cjnh/5k7E+zM3IE59EO/PXIx4f+ZcxLne/TEygXh/5n3E+zNTiFMNxMV4EuRTiIufa8z9mWcQ5xoR78/8BfH+zAjiXDvi/Rnx203LiPdnFhDvz9yPeH/mEsRxQZxXId6fEeL9mS7ERfUa7f2ZvYhzFYiLqpaXMba2cfII4v2ZPyJO+4i7sq9g7cr2Ye3Krt9Te9SV/T3WruzHsHZlX8Talf0O1q7ss3tnj7my7Yi7sv9D3JX1Ie7K/glxV9bUMk+2Iu7K/hZxV/YjxF3Zba3tCVf2CsRd2RHEXdkFxF3ZyrYpch/iruzNiLuyzyHuyp5E3JWtaJ8h9yPuyt6FuCv7NuKubPG+3UlX9nzEXdkA4q7srxF3ZZ9C3JX9G+Ku7GuIu7JvIu7KvoW4K/sPxF3ZWcRd2aOIu7IpxF3ZUsRd2TrEXdlvIE4dEHdlf4c4bSLO1SHuyj6KuCt7B+Ku7A8Rd2UvQdyV3Yq4Kyvv7y3gswRxV/ZdxF3ZlxB3ZZ9BXIxtoNCVFWtbV/ZJxMUjnRZX9g+I0xfiruwNiDMGxGkTcaqEuCsrxOkLcVdWiLuyQtyVvQlxV1aI8yrEsUDclb0AcVf2U4i7sk7EXVldW/taV/bfiLuy96riW1q3r5vITuM+kR3EfSK7FfeJ7NO4T2QbcJ/IHsF9IptCfCJ7H+IT2W0+e5yfEZ/IZhHnDon4RPY3iE9kP0R8IlvTOk5+D/GJ7MOI8zjiE9kNbdtPT2T3Ij6RvRHxieyziE9kTyA+kd3cXrc8kd2H+EQ2iPhE9i3EJ7JF+w6TX0Z8IvtDxCeydyM+Qd0cqYnsXxGfyE4hPpF9A3FehfhEdgbxiez7iE9kY4hPZM8gPpEt3B/McxWIM3LEJ7LdiHNFiE9kn0F8Ivsq4rSG+ER2EvGJ7JOIT2TvRHwieyXi1AfxiWwl4hNZ7X6nTK0Qp56IT/AOTJDiU31CFZ/IPo74RPZRxCeyw4hPZO9BfCJ7LeIT2XbEJ7JbEJ/Iik/1CVV8QhWfyGraZ0khPqGKT6jiE6r4hCrOeBCfyH4O8YlsFeIT2TWIT2SXEZ/IPof4RHYP4h25GcQ7cnch3pH7JOIdub8h3pFrQ7wjl0a8I/cO1h25b2PdkfsX1h05T0vjiY7cINY8gnVHrqK1fJHnYN2RewDrjhzvLtLeNniqI3cR1h25XqyZL2PdkVvAuiO3sf0Q2YZ1R+4OrDty01h35Mz7LCsduS9h3ZE7iHVHLoh1R+5xrDtyz2HdkXsF645cBGtehTXjxLojF8W6IzeHdUfuBNYdOc3+JLkB647c57HuyB3AuiN3M9YduSewpjWsO3LvYt2Rex9rKoN1R+4lrDtyI1iL5zcYxWtj5C6sO3JlWHfkzmLN9WLdkXsNazHCgUKuFGsx5knyIaw7cvdj3ZG7DeuO3P9h3ZFrxrojV4l1R+4I1h25+7DuyAnrjpz47e7ICeuOnLDuyAnrjpyw7si1YN2R+yrWHbkdWHfktmLdkVuPdUdO17ZE/h3rjtx3VesnWqbWJXP/QDyZuwfxZK4W8WTuZcSTuW8gnswZm+SFZC6NeDJ3J+LJXHHLKPlDxJO5VxBP5uytfSeTuf2IJ3P3Ip7MvYt4MlfUtkR+GfFkrhvxZO5xxJO5DxBP5ta1a5aSub2IJ3O3Ip7MvY54MifvO3g2mfsi4sncDxBP5m5HPJl7DPFk7i+IJ3MvIZ6ktmHyDcSTqngyN4N4MvcvxJO5I4gnsejIJXMWxJO5GsSTuQsRT+auRDyZCyKezP0RcVpDPJl7D3FaQDyZiyKezEUQT+bGEE/mfoN4MvcTxJO5ixFP5qoQT+Z0+8dk0aPPlMy9jXgy9yLivArxZO4PiCdVceqDeDJ3E+LUEPFkbg/iyVw54slcDPGkKp5UxZOqeFIVT6riSVU8qYonVfGkKp5UxZO5cxFP5s5BPJkrQFxYDDqSuasQT+aeRTyYfxfxYH4I8WD+M4gH81OIB/OXIh7MWxAP5st83cdZvyLOcxAP5u9DPJhfQjyYPw/xYP5GxIP5VxAP5rmDJIL5HYgH81ciHswPIx7Mv494MG9rP3AmmP8q4sF8H+LB/AuIB/N5xIP5zyEezH8X8WB+APFg/iHEg/mnEefzGPFgXogzTsSD+dcQD+bF53kw/zbiwbwQD+bnEQ/mU4gH8wriwfy5iAfzFyEezF+BeDB/K+LB/GOIB/N/RZzWEA/m30ScNhGnL8SD+T8hHswL8WD+asSD+SbEg/mtiAfzBsSD+QXEg/kZxIP5lxEP5v+CeDAv7uDiKjotwfyvEadWiAfzP0A8mG9EPJjfiHgw/yHiwbyYpQfzFyNOTRCnHcSDeSEezAvxYF6IB/NCnEoiLqpdXhbMb0M8mHciHswbEQ/m/4F4MH8Q8WD+GcTdGiHu1ghxt0aIuzVC3K25DHG3phhxt6YacbfmdcTdmibE3ZpxxN2a0tZ58jLE3ZpHEXdrjiPO8xF3azoRp2XE3Zq/I+7WGNunyC8g7tb8H+JuzVOIuzUnEedV+2bIfYi7Nb2IuzW/QdyteRxxt+bPiNMv4m7NXxF3a/6GuFvzIuJuzcuIuzURxLkixN2aDxF3a5YRd2tMiLs1mxF3a8SnulvzNcTdmqsRd2vuQNytGUbcrXkCcUaFuFvzJOJuzWOIuzX3I87sHnG35nLE3ZrzEXdrNiHu1mT5VHdrPkCcK0XcrXkBcbdG/I67NeJ33K15EHG35h7E3ZpfIu7WdCHu1lyIuFvjRJwWEOeqEXdrhLhbI8TdGiHu1ghxXoW4WyPE3Roh7taIO7hbU4e4W1ODuFuzFnG3Jscd3K15FXG35luIcy2IR1TxiCoeUcUjqnhEFY9orIhHNJ9EPKL5J+IRzbcQj2imEY9ozkU8orkG8YjmBcQjGkPbOHk+4hHNzxGPMNrBUxHNEuIRzccQj2i+jXhEcz/iEc17iEc0xfvqliOaesQjmssRj2h+hXhEcx/iEc0jiEeo2xz5FOIRTRjxiOZPiEd4J3jTEc2ziDMLQzyiEStxrgvxiOYjxCOas8zZIhoxZ4vgzjtDswvxiMaHOD0izlUgHtH8AvGI5kbEIxqxLuMqEI9ofoI4NUE8ohFztohmK+IRjYx4RHMM8YjmHcQjvAMT5DOIRzRPIh7RPIp4RBNCnM8VxCOa6xGPaL6HOK0hHtGI79kimv8hHlHFI6p4RBWPqOIRVTyiikdUccaPeETzFcQjms8iHtFUIB7RWBCPaOKIMwbEEUE8orkFcb9WiPu1QtyvFeJ+rRD3a4W4XyvE/drPIu7X/g9xv7YLcb/2X4jzOOJ+7Q2I+7XTiPu1ZYj7tfsR92vvRdyvfQ9xv9bWvv20X3sR4n7t9Yj7tc8g7teeRNyv3YS4X3sh4rSPuF/7S8T92rsQ92vvR9yvfQBxv/YhxP3ahxH3aw8j7tc+irhf+wTifq34ns2vHUfcr30Zcb9WfPfi1/4XcfpiXebXahD3a0sR92u3Ie7Xfh5xekfcr21C3K9tRtyv3Yu4X3sx4n7tlxH3a2sR92s3Iu7XGhD3a4+zLvNrZxD3a19A3K99GnG/9nHExThrzH7t7xH3a3+DuF87iLhfex3i9Iy4X/sVxP3a9YhTYcR5JuL0i7hfK8T9WiHu1wpx6oO4XyvEGSfifu35iPNZhbhfuxZx5iasxP3aNxHnVYjzOOJ+bSfikk6ISzohLumEuKQT4pJOiEs6BXFJtwNxSRdDXNIdRFzS/RdxSbcLcUk3gLikew9xSbcJcUn3bcQl3cOIS7ojiEu6zYhLuq8hLuluR1zSvYS4pDuLuKSrQFzSfQVxXou4pPsp4pLuV4hLujsRl3S/RlzSHUJc0t2PuKQLIS7pfo84fSEu6R5HXNKFEZd0zyEu6V5GXNL9HXFJ9z7iku7oPrdG0q3si5Dim1VJtxZxRoi4pKtCXNJtQZxRIS7pnIhLuhLEJV0B4uK1MfLIvt4CSTeDuKSbRFzSjSEu6Z5AXIxnoFCMrcYsRjtpFuPvtEg6IS7pfo64pBO/45JO/I5LOvE7LumEuKQT4pJOiEs6IS7phDjVQFzSCXFJJ757kXTiuxdJV484Y0ac60Bc0v0TcUn3O8R5DuJce8t2rLcgHlLFQ6p4SBUPqeIhVTykiodU8ZAqHlLFQ6p4SBUP6W5GnHYQD6niIVU8pDuMeEh3FPGQrhLxkCoe0g0iHtK9gHhIl0A8pFuHeEjnQTyka0c8pPsB4iHddYjTPuLMqhAPUbee1ZDuPsRDqnhIN4x4SPcI4iHdk4iHdM8gHtL9DfGQ7lXEQ7q3EA/pxHfpId0HiId0JxEP6dL7/NqQzoh4SGdBPKQrQjykK0Qcf8RDusw+xRDSndk3Qh7b12AM6eYQ53oRD+neQDykE389CemeRTykewrxkO4xxEM68Tse0j2AeEj3W8RDOnEfD+n6EaeSiId0YuYW0p2DOGNDPKSK8zjiIVU8pIqHVPGQTny/SiURD+kuQTykE9+vhnSliFPt1nHyccRDuu8gznUhHtLdgXhI95Fvap1HL8Q9eiHu0Qtxj16Ie/RC3KMXn+oe/ecQ9+g/QNyjF5/qHv37iPN8xD36PsQ9+jcR9+hLEffov4a4R38f4h79vxDnccQ9+kbEPfqfI+7RP4m4R/9fxD36AsQ9+m2Ie/QNiHv030Lco/8/xD36GxH36O9E3KMXv+Me/e8R9+gfRtyjfxxxjz6MuEf/POIe/auIe/TvIO7Ri2/bPPoPEffojyHu0Z9G3KNPI85vM7/jHr0ZcY++GHHxs0cvHo+Sq/sCkkd/EnGP/iPEGS3iXBHiHv0/Ead6iHv0byHu0b+GuEcvvnvx6MV93KP/I+Ie/SjiHv0TiHv0DyHu0d+NuEd/DeIevViPe/RidUaFEffo70Xco78IcY9efKPu0Ytv1D36fsQ9+ssR9+jbEffov4I4dUPco8+2lpd59OKvJx79jxGnTcSpScugw6O/AHGP/neIR/XiG5ioXqzHo6p4VBWPquJRVTyq/zTiUf2/EI/qDyAe1f8d8ai+GvGoPoB4VD+OeFSvRTyqFzO3qP4GxKP6FxGP6jPM3KL6TyEe1YuZW1R/N+L8K+JR/Qnm6lH9GsSj+lrEo/q9iEf1XYhH9T9HPKq/A/Go/reIR/XiPh6lhmHyacSj+gnEmW0hHtW/j3hUfxTxqP4M4lF8WV3r9czcovpC7uNRvY37eFTvQDyqdyIe1W9APKovRTyqNyEe1acQZ2yIR/UxxKP6/yEe1X+AeJT3QG9BVH8E8SjvqDFyFvEo+glyCvEo+jXmqP6viEf1zyEuRpshhxGP6n+JeFQvvm2L6jcjHuX9LyuiMsOk+HsZI0c8qh9DXNTTXhLVfxdx6oN4VL8T8ajejjhXjXhUfwvi1BBxZFuWyCsR51p827H+OuIB6S3EA5L4zi0gfRrxgPQK4gHpW4gHJLE6C0hbEQ9IbyIekJoRD0hidRaQbIgHpK8hzucf4gHpQ1ZnAcmFeEA6gDiPIx6Q/ol4QLIiHpC+hHhA+iHi/CvizIgRD0hLrMcD0nrE+d1CnJYRD0g/Rjwg3YR4QLoX8YD0EOIBSYgHJDFXD0jibygBaRrxgDSHeEBKIB6QcogHJLE6C0hrEA9I6xAPSOWIB6QqxAPSFsQDUgXiAcmBuHg+72MpiXhAOoZ4QPoAcZENxoA0j3hAOol4QDqFeEA6gXhAiiHOewTxgPQG4gFJ/IU0IL2EeECaRDwgPYd4QHoU8YDUj3hAakM8IIn7eEB6D/GAJP4mHpDOQzwgib+JB6Qw4gHpesQD0jcRD0jnI874EQ9IZ1r7SgPSY4gHJC/iASne0r42IN2IOFeKOLVCPCCtRVwxTCGuGG5FXDF8AnHFMIm4Yvgm4oqhEHHFIL6BUQxPI64Y6hBXDOIbGMWw2DJPfhZxxXA14orhGcQVw2pre4JnIq4Yfoy4YvgD4orhSNsUuQ5xxXAh4rwKccXwIOKKYRpxxZBsP3hWMWxEXDGchzgjQVwxdCOuGG5GXDEMIa4Yfoe4YhBzdcXwJ8QVg/g7qWJ4B3HFEENcMSwhrhi0iCsGM+KKYQ3iisGBuGLYgLhiWI+4YrAjrhhkxBXDyr4oeQRxxfA+4orhH4grhn8irhjEfVwxHEVcMRxDXDF8hLhi+BfiiuFNxBWD+M5NMYi/kyoG8V+diey0iHFmyN8jrhh+hjh1QFwxWBDHAnHFcB3iVBVxxSD+KxfF8Dji1ApxxdCEuGL4GOKKQYc4fSGuGH6AODMOrBXDDqwVw9u+QQfVw1oxvNI8tW7E8DTWI4brsB4xuLAeMYxjPWJox3rEoMN6xLDS3H18xHA71iMG8f3qiOEqrEcML2A9YijAesTQgPWI4UasRwwvYz1iMGA9YhDfr9I+1iOGZ7AeYfwHzowYNmE9YrgE6xHDT7EeMTyM9YjhbaxHDKl2ywrPwXrEUI/1iOFrWI8YDmI9YrgW6xFDP9YjhkGsRwy/xnrEMIz1iOGPWI8YJrEeMcxgPWL4H5/nI4bj3MFHDOJv4iOGZe7gXBdzNvGzpGNU+0I68UyPnjFgPYJXQBoxPIv1iGEM6xHD81hzdViPGN7AegRZpzxiEH8hFf/qM40YxJyNa8F6xCBm6SO8JyfV7LSMGH6DtRj5UNGI4TKsRwxurEcMZ9q7rCOGUaxHDN/HesQg/is1xoM1s0WsWRdiPWL4HNbUHGvG0DpPPtsyXjZi2IPyiOGIb4n8GcrUH2V6QbnB+C18G4xF+DYYH8W3wSj+RtZgPOWVFxqMr+DbYOzAt8H4D98o+Tl8G4z9+DYY32zpO9lgtOLbYLwE3wbjAL4NxkjrEmnGt8Eo/mLSYLwR3wbjX/FtMJ5u0yw1GCvwbTDuwbfB+FN8G4wP4dtgnMa3wZhsP0yux7fB+Fl8G4yN+DYYv4Zvg/Hb+DYYu/BtMP4I3wZjD76MCt8G4134NhgfwLfB+AS+DcY/49tgHMeXMeAr0q9tMD6Hb4PxaXwbjOK/9W0w3o9vg/FOfBuMt+LbYLwNX9EmdTEewrfB+Dt8RTrlBuNv8G0w3oGv6D1B9uLLFeHbYLwG3wbj1fg2GH+Ib4PxG/g2GHfi22A04Suut8tKC/g2GPfiy2cGvg3GN/BtMN6Eb4PxQnwxwrfB+PfWRnuD8fWW8rIG46X4NhjP+trXNhhvxpeK4cv4m7evixndyMaMH1xSezRmvAHZmHErsjHjW8jGjL1Nw+Sn99Yf4zl7Z8lfYh0zlmAdM96Edcx4wtd4ImY8D2sewTqGePlizFiMdcx4MdYx461YxxjV4KmY0YZ1zNiEdcx4C9Yx4wtYx4xn2g6R5VjHjI1Yx4zdWMeMD2AdM76Odcy42L47GTNasI4ZK7FmbFjHjJ/HOmbcjXXMeCHWtI91zLgP65jxMqxjxiuwjhl/jHWMd0IwHzNeh3XM+HOsRfq14hFJF8OCFabxKqxjRvH/jIgZL8U6hgv3AGMn1jHjd7COGb+Pdcz4A6xF+05ZPH+M/BbWMeN+rGPGZqxjxj1Yc11Y8+7AOmb8AtZUG+uYUcY6ZvxX+zT5ENa0iTVXh3XMuNRWb4sZ/4B1zPhtrGPG9VjHjNOto+QvsObnlr7SmPF7iMeMed84eTviMeMmxGPG+5sHHbwf8e0tOLWna7634Df49hZ8Bd/egtNN9cd6C+7Bt7fAjW9vwVizPd5b8HF8ewuC+PYWxH3z5C58ewt+gW9vwSst46QJ396Ci/DtLbgV396Ct1u3n+4tKMW3t8CHb2/BLfj2Fkzg21uw2Fa33FvgxJfx4Ntb8CN8GQ++PAff3oL/ts+Ryfae1d6CQnx7C9bi21sg/uvT3oIqfHsLzsWX0eLbW/A5fHsLPo9vb8GX8O0tuABf2se3t+Cr+Ir0a7lefHsLduPbW/BFfHsLduDbW/AZfHsLavHtLfgsvuJxfktpk9+Bgi/gK9Ip9xbsxFc8x2cSvSfIbfj2Frjw7S04B9/eAju+vQVGfHsLEu1DRb0F0+21xb0Fh/HtLbgaX0aIb29BEb69Ba/jSw/49hZ8DN/egndb7SW9Bdfi21vwWsu8vbfAj29vgRbf3oI78aUvfHsL7m1eWuuUf3bhZMwp/wZZp/xVZJ3ykneYvBdZp1yHrFN+bW/3cad8CbJO+cXmUXI7sk75JmSd8pyv76RT/gSyTvlqZJ3yX1vaE05ZQpbPMGSd8q3IOuV3WqfIUmSdchOyTrkfWaf8LLJOeaFthixD1imfh6xT/h6yTvk2ZJ3yKLJO+Q1knfKH7Y6UU15uD5NaZJ2yjKxTLkbWKa9BlnaQdcrrkHXKTmSd8kZknfImZJ1yObIi/VrxiKRzyucg65TXI+uU1yLLOJEVqRhEayOkA1nxnBi5AVnxM63z+BhpR9YpW5EV4xkodMr59hqzUz7TPknG2jstTvmt9gz5DLLUHFmn/BNknfJFyNIOsk55tm2YvBNZp/x5ZJ3yf1q714iqNtqd8qWYOuWcr6+U5/jKy+gfU6ccbG5H074rvHlMrsZ0TP7nHnlhTL4RzTH5Y2iOya82zZLtaI7J7++1x8dkL5pj8l+aG0+MyZvQHJN70ByT3/aVL47JlWiOyVeiOSaPtSyRGjTH5K+gOYbpFPl264EzY7INzTH5IjTH5J+jOSb/Ec0x+YO2g2fH5GI0x+Q6NMfkb6I5Jv8CzTF5GM0xeQLNMfk9NMfk+XZveoyKxclUe39mTM61u7JjKE+QejTHZAnNMdmApki3Zkw2oil+9mtFSjrxnJBOPN+jH5N1aIoWApJIxSCSeRWPNxjFc2Jq8slFOmXxr1wt/fpMY3KyPUEutg8Ujsn/Q3NM/juaY/KzaI7Jv0dzTO5Hc0y+HM0x+QI0x+QNaI7JH7bJyph8H5rcw9Eck8MtoyVjciuOtOybJ+/AcUw+B8cxBMfJsl0OBJ/eGd7sM13dOHTEZ9IgyPzOW3/MZ2pE0Gf6T1P3cZ/pWwj6TP/cO0p+BUGf6YnmedKGoM90JYI+05RvnNyAoM90OYI+09Mtg6doE0HmFAj6TLci6DP9vVWz5DNZEPSZzkfQZ/opgj7T4wj6TLNtlhWfqQBBn8mNoM/UhqDP9DMEfabfIugzjSPoM72DoM/0AYI+0zEEfaZFBH2mU+0T5On2jpzPdKY9qWYw7zMttbs1IiNq+rXicUknMqSmRy9eFVUzIIlUDCJH1GwwiufE1OSewSNO2WdKtI+RcQR9po8Q9JmiCPpMLyPoM/0BQZ/pLgR9pmsQ9Jm+gaDP9EUEfSYHgj7TkbYuq8/0AII+0x4EfabHWuwlPtNFCHJFvka7z3Qbgj7TZgR9pkPN5WU+09pdPeU+08M7Hdh1IpgwLVw0dCRhurex9mjCtA7BhOlF7yz5DQT51yZ7PGE6gGDC9I+9jScSpi8imDA92Nx3MmGSEUyY/AgmTC/42hMJkwPBBI6Dp3hXtmw/nTBJCCZMFyGYwFGzlDC90XqIlBFMmM5DMGH6PwQTpkcQTJjeaztM6hFMmD6OYALHntWE6VoEEziGyWcRTJgiCCZM7yKYMM0imDD9B8GE6b8IikyScwiKdGtERtT0a0VKOvGckJoevciomgFJpGIQOaJmg1FkTE3uefTilEWPY+R7CHJFCCZMzyOYMB1GkCtFMGH6EYIJJhEZcgeCCdNaBKlq23SxuN4uK/+KYML0UEv3moTpywgmTEd9o+TNCCZMLgQTpoeb+0oTpk275jYlTId29pQnTBciSGsIDhRqsRsofKRxmvwEdgOF73m7jw8UXoEdI2oaJb+D3UDh23vnyZ3YDRSGmssXBwol7AYKv43dQOELviVyA3YDhVdiN1D415Yp0oTdQOEl2A0U3ordQOHrrXXLA4VG7AYKv4jdQGEAu4HCh7EbKHy3bXeSlrFjPNgNFLZjN1DYg91A4RB2rP+wGyj8M3YDhc9hN1A4gZ3IjtxA4d+wExnMi3RrREbU9GtFSjqRITU9epFRNQOSSMUgckRN1mNkzCha7i3girAbKBzHbqDwaewGCh/DbqDwXuwGCsVODgOF38duoNCL3UDhZ7AbKCzDbqDwRFtt8UDhU9gNFH4LO663ZdY2UHgedgOFH/rsJQOF/dgNFG7BbqDwyeZ5cj12A4Wf3LV700Dhb3bOkbsQHCjUIDhQ+P6O8OYacyF2NeYnG7vmWTNhV2OOe+3xGvNPsasxrzQ1nqgxfxe7GvNbYi9icx12NebfNo+TEnY1Zj92NeYp3+CpGnMldjXmq7HjkZYDZ2rMVuxqzE3Y1Zhvw67G/HrrDGnArsb8BexqzD/Crsb8EHY15nfb5kg9djXm7djVmPdgV2P+PnY15muxqzHfhB2tYVdjvgO7GvOd2IlMqhnMi3RrREbU9GtFSjqRITU9epFRNQOSSMUgckTNBqPImFG031tQY74duxrzrdjVmG/Ersbcg12NuQu7GnM7djXm87CrMW/DjqvGjkq2DRXVmJ/FrsZ8FXY15ida6m015i9jV2P+0Ne9htawqzFXY1dj/nNzo73GfC52NeYLdh3eWGN+YOfuTTXmz2JXYz61o6e8xvzSDgdqj2A3aVZQmzQ/0ygvTJovQ23SnPeOkjegNmnONM2TftQmzdN7yxcnsRsnQ83tiUmzjNqk+UrUJs3v+LafnjR/ArVJcx9qk+a/t2iWJs0lqE2a96I2id0M+XrrwbOT2FlWJs0e1Ca5rt3JSfMDqPGqtp7VSfNKmyM1aXagNmn+JGqT5i+jNmm+GDVaQ407DGqT5hbURCbVDOZFujUiI2r6tSIlnciQmh69yKiaAUmkYhA5omaDUWRMzd6CSXMzapNmL2qT5gtRmzTXozZp/jRqk+YK1KghapPmVFunZdL8n7YM+TRqk+Zu1CbNm1GbND/fMqxMmhuxmzQf8c2S/dhNomYvmTQ/2zxKfgY7+t1l2ThpfmLnYXIHdpPm4zvmyD9jN2m+C7tJ87XYdVrWotZpeaVxmLwGtU6LBbVOy82odVqyTX0nOy1+1Dotb+0dJ3ei1ml5sHmJtKHWaelBrdMy55siPah1Wm5BrdMy03KILEWt09KMWqflNtQ6La+2WlY6LTrUOi2fQ432Ueu0BFFjvoZap+XdtjApdkLotKTa4qQOtU5LAWqdFhm1TosJNZFJNYN5kW6NyIiafq1ISScypKZHLzKqZkASqRhEjqjZYBQZU7O3QPTllDstBtQ6LRrUOi2rbQnyZNtAYaflg7Yac6fl7bZJ8jnUOi33o9ZpuQK1TosLtU5LB17c/Xz1NuqJF7+ReHVanm22l3RaduDVafnmroPndFr+vNOysdPyRby46h27N3VansSr0/IrvGgTr07LPrwylkqkMpZ/N9Yfy1hu8DaeyFhsSGXw6juZsWSayhczlu8ilbG8vbc9kbF8EamM5Q/Ng6cylk1I8UykMpaTvgNnMpbzkcpY7kAqY3m3pW45g9cM2YQUz0QqY3mx9TC50ro7mbFsQSpj2YNUxnIlUhlLP1IZy6+RylgeRCpjeaytP5OxPNHmytJv2wQ52taRE5lUM5gX6daIjKjp14qUdCJDanr0IqNqBiSRikHkiJoNRpExNXsLRC9OOWN5vG2MfLTNZxIjSZD3IZWx3IlUxvJLpDKWHyCVsXwVqYzFilTGckWLrPC/fMPk7UjxeYkUK4bm7jUZy2eRylgO7JpxZizP7zx4TsbyFaSYy+w4TD6JVMbSh1TGchlSGctFSGUsO5EaKvo0RkNFy42z5A3e+RNDRRaM+BmjoaKVpnHyOxgNFf1j7xL5FYyGisabt58eKvo4RkNFQxgNFZ31aZaGir6K0VDR7RgNFb3TMkMqGA0VXYjRUFEvRkNFT2I0VDTbOkfmW3tWh4rWY0RrGA0V7cJoqOjLGA0VNWDEazEaKroII5EdOZFJNYN5kW6NyIiafq1ISScypKZHLzKqZkASqRhEjqjZYBQZU7O3QPTllLkKjLhSjIaKdmM0VPRFjIaKPoPRUNEWjIaKzBgNFc21ZsiftHRZh4qMGA0V3YMR9zGMhoqeap4lz8WIGu6qcw4VvbBzhrwYI2q7w7JxqOhpjIaKfonRUNE3MaJHjIaK3BgNFVVgVFt8Hjq1xfLF3cdri6/x9p2sLc57yxdri3+KTm3xqab2RG3xt9GpLX5/7+Cp2uK96NQWTzVPkXXo1Bbfh05t8VnfIXI3OrXFN6FTW/xay8GztcV6dGqLP4tObfFl6NQW96NTW/wgOrXFz7Y6UrXFr7aGybdbvena4vda4+T7rf2Z2uJ/tbqytcWzrRNqduREJtUM5kW6NSIjavq1IiWdyJCaHr3IqJoBSaRiEDmiZoNRZEzN3gLRl1MWOSaL3n0mMZIE+U7rQKEYYY2ZdXPrJPnr1k4Lj7fUFtcWX9UyTRZgVFs85JOV2uIqjGqLH2mut9UWb8CotvjArkMbaotf2FnnrC3eg1FtcXrHwXNqi8cxolYY1RZ/C6Pa4i9jVFu8HaPaYidGtcVrMJoubmjsPj5dXHyxPT5dfBk608Vx7zh5BTrTxcealshvozNdPLd3++np4v3oTBe/2XzgzDRGmqXp4nvQ4VW+umUeQWe6+Bp0povDLZaV6eJYy2HSjM508TZ0povr0Zku3oPOdPE+dKaLv4nOdPG30JkuPoAOPaIjckLNjpzIpJrBvEi3RmRETb9WpKQTGVLToxcZVTMgiVQMIkfUbDCKjKnZWyDSKYt+x9T0maaLL0Vnuvjr6EwX70VnuviL6EwXb0JnunixJUM+0TJUNF3cgdR0cdY3TQZ9XVaeg9R08X3Nw+Q3d2k2TBc/v/MQeTFG0+jMkM9jNF18K0b0jtF08fkYTaMzR27AaLrYitF0sQmjLmtDoz3eZZUvHiUb0OmyRr3tiS7rpeh0WT9qGjzVZf0OOl3WD/dOkfvR6bJONWuWuqwfQ6fL2o9Ol/WfvhmyHB2egw6Po9Nlfaxld7LL+mLLHDnT0rPaZf1PiyPVZY21hMmjLd50l3WhJU4ea+nPiHRlRU6o2ZETmVQzmBfp1oiMqOnXipR0IkNqevQio2oGJJGKQeSImg1GkTE1ewtEOmWRY7IYg88kxpMgP2gZKKQOLczOrS+1TJIPtXRauqz/h06XdQc6vMpXW9xlvQmdLus6dLqsdzbLSpe1bdeB9V3WP+/UbOiyXoBOl/Xsjjpnl3UcnS7rLeh0Wb+LDtVGp8v6cXS6rBvQ6bIWo9NlLUCny6pHR1bOaxyNy8pyY+MJWfkkLrLyqneJ3I+LrHzYtP20rHwHF1mZ23vgjKw04SIrzzQfItfhIitX4iIrz/oOnpWVsz7LiqxU4iIrX8ZFVtpwkZXLcJGV7+EiK1fgwqtwERknD+Ii0pUVOaFmR05kUs1gXqRbIzKipl8rUtKJDKnp0YuMqhmQRCoGkSNqNhhFxtTsLRDplEWOyWIMPpMYVcIkRjhQKCvfxEVWLsGFmuAiK0ZcZOU131CRrFyDi6yswUVWbmvmna1cuGtqnaw8vvPAeln5Ai6ysrjjEPknXGTlV7jIyrdxkZWv4CIrblxk5RxcZMWKC+3jIitaXIaVT2MxrPy7cZ50YcG83jt4ahiR7aeHlY+apsgDWAwr0b2apWHlS1gMK8PNdcvMU5pnyK9iMazciMWwEvYdJt/27U4OKx/65sgTvp7VYeWUz5EaVs74wuSSz5seVpZ9cTX7MyJdWZETanbkRCbVDOZFujUiI2r6tSIlnciQmh69yKiaAUmkYhA5omaDUWRMzd4CkU5Z5JgsRuIziVElyEXfQOGwctRXY+ZKfZPk875Oy7Byty9D7sNiWNFjMawMNE+Tn9+1fd2w8vudU+RnsOC1OzQbhpUnsBhWfoEFM24shpXdWAwrH8diGIXDpILFMApzZL6up7zeVkn9622vNPadrLe5qH+97VXv9tPM1ql/vW2+6cAZfqb+9bbX9x4iz6X+9bbrqX+97Y3mg2frbYXUv972Wepfb2um/vW2A9S/3tZF/ettB6l/ve0q6l9v+yH1FxlXsz8j0pUVOaFmR05kUs1gXqRbIzKipl8rUtKJDKnp0YuMqhmQRCoGkSNqNhhFxtTsLRDplEWOyWI8PpMYW4K8gvrX275L/ett+6l/ve3L1L/etoH619tmm4eK6m0/ba4trrd9btego952787t6+ptH6f+9bb/7Tiwvt72CPWvt/2M+tfbvkb9621fpP71tm3Uv962nvrX26zUv95mpP71tnzd3KZZ21pqPmt7trF8cdb2SWo+a3vXO0V+j5rP2o42aZZmbXup+aztib11y7O2/N4Zcjc1n7U92Hx4Zdb2t+bdyVnbdPMcGW3uWZ1ltI7UrO3fzWE1vWmRcTX7MyJdWZETanbkRCbVDOZFujUiI2r6tSIlnciQmh69yKiaAUmkYhA5omaDUWRMzd4CkU5Z5JiaPpMYW4J8v3mgcNb2j+Ya86ztteZJMtzcaZm13dycIT+/a2ntLBUedMzatlFnXrtjinyQOs/arqHOs7Y26jxr81DnWVs1dZ61OajzrK2IOs/aDNR51par272pe42N2navebpxnDyf2naviXkPnOle8z1q273mH02HyI9R2+41AWrbveYPew+e7V5z4a72td1rfr9zifw4I+le8+8d29d1rxlmJN1ruhlJ95pWRtK9Zicj6V5TxUi615Qxku41ZkbSvUZiJN1rcnWHN9pLbPRuL3m2sT1hL2mhd3vJB17Nkr3ES+/2kgea6pbtJXNNM6RC7/aSF5qGiuwl1U21xfaStl3jZfaSJ3a2r7WXfIbx2Ev+t2PQYS95kPHYS7oZD20yHnvJTsZjL6liPPaSUsZjLzEzHnuJxHjsJfk6y8bRkjLGMFryUuMSeRFjGC0Z9x4iLYxhtOTLjGG0xN908OxoyfVNlpXRkmDTYfK3TbuToyUPNc2Rjzb1rI6WjDQ5UiLDanrToyWPN8XV7M+IdGVFTqjZkROZVDOYF+nWiIyo6deKlHQiQ+QTTR69yKiaAUmkYhA5omaDUWRMzd4CkU5Z5JiaPpPIhEmMaqBwtOThphrzaMlvmibJ65o6LaMl5zexWi551ztUNFryrV3lZaMlz+wcJ+up8GjJ/I4l8hEqPFpyDRUeLWmlwqPU9sD6UWqr2TBKbQ+RZio8Sm1nyHzdwXNGS9JUuNG+gdo22t9qHDzVaFeobaO901u33Gi/0ztDPuU9eLbR/pLXstJonxbnwtjfE+fC2P8lzoWx/9vbs9po/4/XkRIZJv/r9aZFxtXsz4h0ZUVOqNmRE5lUM5gX6dY02ue8EfJ/Xr+20f6BV9I12j/0hsiY16NvtH/kjZJHvAFJpGIQOaJmg1FkTM3eApFOWeSYmj6TeG3CJFobKBSjrTE32iPeSfIhb6el0b7PmyF/sKuvtNH+8s7yskZ7I7VttJ/Z0b620f4ktW20X0dtG+3t1LbRvovaNtqrqG2jvZTaNtrN1LbRLlHbRnu+bobMUNt5u5V6zttfatx+et7eL86Xsf9FnC9jj+45eHbefnSPZWXevrjnMHlmz+7kvH15zxx5dk/P6rx9ZY8jJTKspjctMq5mf0akKytyQs2OnMgkmdwTzM/bV/e4NfP2zJ4IqaGe83aJes7bC6nnvL2Yes7bbdRznl/mgCRSMczb7dRTZINRZEzN3gKRTlnkmJo+k3h+grRSz3m7kXrO20/umSSf2dNpmbdfv2vePm9/b2df6by9g3rO23XUc97+PPWkDtRz3v5N6jlv/wL1nLdXU895exn1nKeSmg2MlnrOU8k657w9TT37Sl+9aPvpvtKDjVPkS5ccXukrnbpkd5LHL5kjX7ukZ1WkIyUyrKY3LTKuZn9GpCsrckLNjlxf6euXJMk3Lgnm+0rfvsSt6St9/5IIefQSv7av9Owlkq6v1LgnRNr3ePR9pefsiZKVewJSX2nVHsXQV7plz4iaDca+0uo9MTV7C0Q6ZZFjsvhXn0k8P0GW7xko7Ctds6fG3Ff64K5Ge1/p6Z3z5A+pVV9pGbXqK53eMU4OUau+0supVV/pBdSqr/RcatVX6qBWfaUWatVXaqBWfaUaatVXmqFW5WU3X3TgTHmZsVGzVF52dNdoSXnZJnopL7uTXsrLPkUv5WULO8rLysueoJfysp/RS3lZM72Ul32aXsrLzqGX8jIrvdAOvZSXaemlvCxbd2jDeNnltDle9vLORvt4WRttjpeZaHO87HXaHC+7mzbHy/y0OV72JdocL6uizfGyEtocL5Npc7xMT5vjZfk6zYahIy9uPbwydOSerbuTQ0d+tnWOPLi1Z3XoyOVbHamhI9/dGia/s9WbHjry7a1xNfszQ0cObHVlh45ctnWC/PrWjtzQkaatSXLnVlbuR/9axQr96NerWAPOD1WzDp0vqGYdOn/bFtah85/cwjp0Pl7FOnT++SrWofMPVLEOnb+rinXo/K1VrEPnB6pYh87fXMU6lGQdOn9TFevQ+f4q1qHzfVWsQ+evqWIdOv+dKtah8xdUsQ6dL6tiHTofdbEOnb/VxTp03uMSY/ioknXo/EAl652F5S2swhZ2bGEVtjBYxSpsIeNiFbbQ62IVtrDJxSpsYbaSVdjCHytZhS3cX8kqbOGuSlZhC7dXsgpbGKxkFUayClu4rZJV2MKtlazCFgYqWYUt3FDJKmzh6kpWYQuXVbIKW/hSJauwBXslq7CF9ytYhS3cXcEqbOGPFaynFkyVrKcWLq5kPbVwfSXrqYVHK1lPLUxVsp5a+Hcl66mFeCXrqYVUJeupBcXFemphh4v11MIvXLIiLwSq7SXyQrp6lPxRTaNdXvioZp785ta+Unlhfmt52fDCpmrWPgv2Lax9FjZWsfZZ+JKLtc9CTyVrn4VXKlj7LGytYO2zcHgza5+FSzaz9llYu5m1z8JqBauJhXJGMrywi5EMLzQxkuGF71eymli4p7LLOrzwQaWsDC/4XKyvFu5kJMML5zCS4YX7GAk9MpLhhYfVkXx+23hZ/bHWLawIjp11sSI49nAlK4Jj11bMiNzMiuDYoXJWBMfe2MSK4Nj/VQ4r9cfsrnpb/bHfVTfa6499hjbrj71Q01daf6yJNuuPfbRVtHnttva1s8fWVjMHPtZdxRz42Hglc+Bj2grmwMcuL2cOfMy2iTnwsQer5+2zxy6ghdljczXlZbPHfkILs8csagv3b2PmdvzqLdtPdx8fcDHrO351BbO+4x3lzPqOH6qYtXUf/0UlM7njD1f3lXYfb6aF7uNnasbJm7Yy9zu+Tm0htI253/GN5zLXiq/fMnjKHn+zcvtpe7xp8xT51kbmcvE9Fd1r7PGLKu0l9vhj1eVl9ngH7djj2RrmbPFbtzJni5fSjj1+5zbRjuVcZhTx3VuYg8UfqRw8NRr/Y/n206Px5jXipLzCNeKkvLds4qS8R2zipLw7xF6N8Rtt4qS8623ipLxeW1xNcVJer02clNdrm1BTnJTXa0uqKU7K67WJk/J6bRE1xUl519nESXnX2cRJedfaxEl519qiaoqT8npt4qS8AZs4Ke+wTZyU95FNnJTnXSNOyttcYS8ZjddUjpLhamZN8e9yjaNxPdc4Gr9lK7OmeBHXOBrv3yauUXsud/YTC1vaE40nLnIxLzpRtJl50YkpuzhXzlHJ/ODEK9XMDU78pIa5wYlCWmg8cctW5gYnZFpoPPGLbaKF/DbuZSe+WdWemD/xpYol0mcXZ7F9pVScxeao5C55Yj3tzJ/4oJp74okba7gnniihnfkTt23lnkhr3BNPXK+2k9/G5/zJ724ZX+w7+Xxle6Lv5OfLl8hhqzivLWsVp5457OJ0s6xdnG72fmmGrK7kznLyC7TfdzJdzX3k5N013EdOrqP9vpO3b+U+clKm/b6T16vt57dxH1ncVl2+WL5oqBon5Yr2RPliv1WciZaw+kzli2/ZxblpD5YOFZUvHmYlX764voI7y+L5ldxZFjvopXyxiF7KF++r4T6yuIFeyhdv38p9ZFGml/LFX6i96M6dcY4vLlWVL3JNleNkfXl7YnxxxSpOT1u0itPHnrGL88UGSmuLxxffdAwr44sPsHYdX/xcBXecxSsqueMsdlVzf1lcQ1/j9Mj9ZXEdfY0v3raVexY91tFL/zbRV9G5B89pT9yzpe9ke+IBV/lie+LY5nHypFWc6jVqF+d23Vgqzu3S01d74i3WzO2J37OKa0+0VYyXtSe6qqfWtSeK6KU9cXeNZkN7ooRe2hO3bK1z8ji9tCfu2iZ6qTzXsnEpoaueP7GUOFjVd3Ip8bnK8sWlhKeca07EreKErCfs4gysgVJxBpaRvpYSb7J6XErcy2ptKXFVRfvapURH9YH1S4l0tWbDUuLGmkNkIX0tJW7dOkOupa+lxMPbLBsHT325uvHE4KlM1Tz5KVffycFTf95cvjh4KmYVZ0s9YRenR91eKk6PyrBSHTz1POvDwVP9rMQGT11TsbR28NQX6GXw1AfVh8if1NQ5B09J9DJ46o6tB88ZPFWp9vKnbYc3bj/9/erR+PbT+7Y0nmBu65onP6zoO7n99LZycRbVLVZx2tS7VnES0x/ssrL99O2l4vSlo6xLt59+kHXg9tM/YH2y/fRVFYOO7afX0+P2069U1zm3n/bXzJBaetx++u6tFvqqUXv807bdm6ZO/6LaHp86fdeWUfLyKn4nT0cq58mbN4uznF60inOLRu3DCo+UihOLfGXixKLXWX9One5ndTR1ei9z96nTH18vToBqq9i+bur0FZVT5NPVM86p05fWHDxn6rSGfqfo/TBZqfb78LY5cvO5PeUHzgSru48fOPP8Fnv8wJmXqkbJa12NJw6c+UOFOAuprlychTRmFSf+jNrrbQfOXFcqzvqpLxNn/TzJOu3AmStZSxw442HWe+DMOevFOUqfq5had+DM+ZUH1vOq6oPnHDhzaY2Fz2ktYzhw5vatuzcdOFPGGA6cuWObGIN0rmOzZumB6tlj3Ge2dB/XLBkYj2Yp7xol76oUpwjdvVmcIjRpFefjPG6ftWmWflQqTsb5RJk4GedS5t+apU8zm9QsnbNenD20vuLAes1SdaVmg2bp6WrLRs2Sv+Ywqad3zdItW+dIE71rlnq2id4/2BbefGjpyWrumkvLW2bJTzOSQ0vtVfb4oaXPu8RpOyMV4rSd68rFaTvHreIEmUfs3WsOLV1eKs6OqSoTZ8dcyuz20JKHGeehpY+vFyf1OCoPbTi09Er14Y2Hln5Ss3vToSUTvR9a6t/aU35oKbXVQb9fV3t/dJu3om75uerhhbrlQkZSt9zGSOqW76nqPl63POoSJ9H8uFKcRDO2WZxEc+kmcRLNoFWcrlKhiNNVHrLbS+qWv1MqzlXZXCbOVbmSeXDd8l5mq3XLjso6Z93yekZSt/y/6t2b6pZvqJkjixlJ3XIvI6lb/u/WMFmjjsS7Lc5s4qVqeWFmeR2jmlm+akv9sZnlyapZUlMlTmnRu8QpLb+tEKe0PFkuTmk5VtKemFmOWMXJI62KOHnkQftoyQyjEmeOVJWJM0eeZI4+s/wr5tMzyz9Y1752Zrm6csY5s/xFRjWznK6eI++o6SmfWS5kVDPLlzOqmeU/bPUynpmt8YqDZ1+t7po/eHYzYzt49udbhskPq+qPHTy7o0qcY/I9lzjHpLFSnGMytlmcY3Ibozp4NmgVp3LoFHEqx7WKOJXjIXuj/eDZy0vFSRyfKBMncbzOXP/g2Qcd7WsPnu1ft0RuqJhxHjx7QeXBcw6e/QZjO3jWwtgOnr2zxsE8K1UTFrMtxnbwLHP7CsvK69XTRy0rLkZoWfnVFnnBsnK2apjsrBKne/zRJU73mK4Up3vcXCFO93ipXJzucREjtKy8ZhWnVGxVxCkVdyvilIrHWH9aVgKl4kyK88rEmRRH17avtaw871gi71036LCs7Kw4eI5l5apKy0bLyo+qe5j3rWFslpV+xmZZea/Gy6jyNXHmp9WM7fDKwJau+cMruSp54fDKj6vE2RYxlzjb4pMucbbFZyvF2RavbhZnW9xgH188vLKuRJxqcdgqzmg4ZRVnNHxJEWc0PKCIMxqeZNV3eOX6UnEiQ3bt0trDK284Bh2HV0Lrtq87vPLtCsvGwys/r3ZsPrxSzHhYuzCewyv3Mp7dydrq2qO7k4Nbpsl8Vdf87mRPlTjNIeMSpzlc4RKnOTxZKU5zuL9CnOZQtFmc5nCeXZzjkFwjznEIWsWpBG9axakEJkWcSrBHEacSPKKIUwnGWCvSfqk4icDAqHYn33BsX7c7ee+6KfK+isMbdyf7q8Obaa3ay3jcjGou2Vk9dGQu+cCW2qNzSQNjm0v+rEqcX6CrEucX3OgS5xesVIrzC9yV4vyCggpxfsHXysX5BSV2cXLBh2vEyQU3W8U+/H+xin34j1rFPvxlitiH36eIffgfVcQ+/M+x8mS9WCr23s+u3b5uLvlXxxTZv+7A+rnkXZsPb5xLnqzYvWku+VNGOJccr45X9Kx+sGXoSM9qBSPsWf1lldirX18l9uq/xSX26i9xib36f1Yp9up/uELs1X/5ZrFXf12p2J9/pUTsz//eGrE//w1Wsdv8k1ax2/w7VrHb/Bmr2G1+gyJ2m/cpYrf5hxSx2/xf7WJX+V+Xil3l59dOreNxx4H1PasH12k29KzeXX54Y89qIePsWU1t8TLCLzFOR+r/GKcj9Ycqsf+8rUrsP3+bS+w/v94l9p//TaXYf361Quw/b6sQ+88/V9593JFSSsWe87ESsef89Bqx53yfVeyg/rhV7KD+mlXsoD5nFTuoJ61iB/UNithB3auIHdTvU8QO6rJN7KA+YRc7pd9ZKnZKf2PtgfWO1M0OzQZHav+6Q+TnN+/e5EiFK+bIk1VhVmnXM3KeuSVeEU45GXk4dWGV2Fn9YZfYWb3CJXZWP1wpdlbfVCl2Vv9ehdhZ/dubZ8mEXeyj/l6J2Ef99TViH/VfWMWu4I9Zxa7gL1nFruDvWsWu4B9Zxa7gq1axK7hDEbuCf1URu4IHFbEreF4Ru4K/YBe7f99UKnb/vqBsinx6rWZDOHWN4xC5b12dM5y6tXz3pnCqivGHUzcz/nBqM+Nn9c/4velTLrFP+PkusU/4M5Vin/DaSrFP+K8rxD7hr2wW+4RnSsV+4DN2sR94pETsBz61RuwHLkbuTT9qFbtbv2gVu1u/bRW7W89axe7WR6xid+sVq9jdukRRd7dWxO7Wdyhid2ujTexu/aJd7GX981Kxb3ld2YH13vQvHXVOb/qmdTNkftPuTd702OY58iuMnJarvIx5CyOPp0Musev1fKXY9dpbKXa9frZC7HptqBC7XtsYeTz9cqnY3XrcLna3frFE7G790hqxu7UYeVwdeVwdeTw9bRV7Nb9nFXs1/9sq9mo+YhV7NS9bxV7NdkXs1XyRIvZqfkARezVX2MRezS/ZxS7cPys9sD6e/lSZZkM8/apjxhlPl60/eE48/V1GHk9vYuTxdJiRx9OZqnhFf2avS+zefFOl2L15rkLs3vypCrF789c3i92bHysTuzTfWyp2aX7ELnZpHi8RuzS/uEbs0ixG3p8RI+/PvGAVew7/3Sr2HH7XKvYc/qdV7Dn8H6vYc/ioVew5nLKKPYfLFbHn8LcUsefwK4rYc3iPTew5bLeLnaVftR9Y///MnQVYVNnbwO8UDCEMjYqNLuvaHdiFSjNDYwe6KN1gIdJht2KRQ5iLGypIdzN0NyggzcR33musu4uKyn7/fZ6f57kzc+fc9+fcc/t9cWcfkcLGurMVpa+hdhaK3J0tiCJ3ZwegyFFvKHJ5DkkeahHLT4FaxDsmQy3ic5OgFvFJGag2bCwN1YbtpaDa8FVJqDYcLQHVhmPFodowRC7PgcjRO6JQOxcil+fki0LtXJYo1M4tEYXauZWiUDu3TRRq51JpUDt3GQ1q53rSoHZuPw1q57qIQe3ccShy1I8kNlae4yN1DbUkFLk8h4Ail+dcRJHLcypQ5C84zClQTTdqMlTTTZ0E1XRnykC93GXSUC93txTUyz0rCfVyH0tAvdwYcaiXCzG/wGN+gcf8Ao/5BR7zCzzmF5wiUaj+WiYK1V8bRKH6K1sUqr/K06D6614aVH99QYPqr/PEoPrrYzGo/joVxfyCUyl5DbW/Sy2Re8Epn1g5AX1X/tEkFAmK/AWnBEVuyN06BarC/jgZqsK2yUD11w5pqP46Vhqqv2pLQfVXX0mo/vpQAqq/QuSGXIjckAuRG3IhckMuRG7IhcgNuYWiUMsUIjfklopCLdNaUahl2iMKtUxH06CWqToNaplep0EtUzYNapkai0Et0zIxqGVqKJ6E2sUofkOuOIrfkDtHOg+10cjCkNuHLAy5Z5CFIbcYWfRxSyZDpVO/SVDpNFAW6prekYG6psnSUNdUQBrqmqpJQV1TL0moawoufdwX4lDXFFz6cJc+3KUPd+nDXfpwlz7cpQ936ePWiEKVzi5RqNIpSYMqnRtoUKXTgwZVOktoUKVzvhhU6TwtBlU6u8WgLut+8T1j+rgHJJfIoTml8lDrhVzQp8gFzYlc+nCXczz6aKjVqSkLtTotZaBW531pqNXJlYJanVuloFanpyTU6nwgAbU6weIcDyzO8cDiHA8szvHA4hwPLM7xwOIcDyzO8cDiHA8szvHeiELlSTEaVJ5cQ4PKk0dpUHkyiQaVJyXEoPKkoRhUngwWg1qjPLE9Y87xDoljY8/xKiXz5M7xGMjiHK8dWZzj+SELtBRkMQfrHl3aPAfrl4UqlGNkoQolQwaqUN6RhiqU/VJQhXKzFFShBJc5GLjMwcBlDgYuczBwmYOByxwMXOZg4DIHA5c5GLjMwcBlDgYuczBwmYOByxxsFQ1qKjrSoKbiMxrUVMTEoKbicjGoqWgpBlU07yOXORgZuczBRiOLOVgLspiD+SAL1D+ySMN8xqxuTsOuIZc07IUs1Ffsl4H6ihtkoL7iNWmor9gjBfUVlaSgvqKHJNRXBJc03CUNd0nDXdJwlzTcJQ13ScNd0nCXNNwlDXdJw13SMBoNqgWupEG1QHsaVAt8SoNqgT00qBaoIAbVAjXEoD6kE3JJw34Rw8amYZLi11BbNqFyQhomP9lpYhpWj7zSMG/klYaxkJcxYc7Yu03GhJXIzpiwD9kZE27KQi3BRhmoJbhCBmoJXpaGWoLdUlBLEOyMCWBnTAA7YwLYGRPAzpgAdsYEsDMmgJ0xAeyMCWBnTAA7YwLYGRPAzpgAdsYEsEPLokFlPDsaVMb7hQaV8TpoUBlvnBhUxlspBrUQ9ZGdMeEEsjMmJItdQ+1m8SVyxgQqsjMmVCE7Y4InsjMmgB2ZyBkLtfI6xtxFrRhyJBM3I0cy0U8WqudVykD1vKUyUD3vkjRUz+uSgup54EgmgiOZCI5kIjiSieBIJoIjmQiOZCI4kongSCaCI5kIjmQiOJKJ4EgmgiOZCI5kIjiSieBIJj6hQS241zSoBTdaDGrBLRCD6n9KyJFM3I0cUVTIkUykIEfUv3gearsmOU0kE8uRKYoQmZKJYBpAzB0LNeKykGkAcWD06uYAoiIyDSC6y0LVuDIZqBq3RAaqxl2UhqpxYBqAmwbgpgG4aQBuGoCbBuCmAbhpAG4agJsG4KYBuGkAbhqAmwbgpgG4aQBuGoCbBuCmAcRXNKiBJiMGNdBmi0HVu5XINICoiUwDiE7IFJ4oWSIXQLyNTAOIDcgUvYNMA3DTANxUkfRiLNRGi0GmiqQOZKpIWoRMFUmnZKFaWokMVEtbLAPV0sBUkQSmiiQwVSSBqSIJTFE/4lAtDUwVSWCqSAJTRRKYKpLAVJEEpookMFUkgakiCUwVSWCqSAJTRRKYKpJsaVD7C0wVSWCqSJIWg9pfM8Wg2tsyZKpI2oJMFUmHkakiKRGZKpLckKkiqQqZosiRKYoQmSqSwJRFih4LNcF+Q6YsUhsyZZEWIFMWyVUWrxImA1XCwJSFm7JwUxZuysJNWbgpCzdl4aYs3JSFm7JwUxZuysJNWbgpCzdl4aYs3JSFm7JwUxZuysJNWbgpCzdl4aYs0lJkyiJtQqYs0gFkipaOTFmkI8iURapGpizclIWbsnBTK/LjsVAL61dkakVuRaZWZDC1Ip+UhepYYGpFBlMrMphakcHUigymVmQwtSKDqRUZTK3IYGpFBlMrMphakcHUigymVmQwtSKDqRUZTK3IYGpFBlMrMphakcHUigymVmQwtSK30aDWE5hakcHUigymVuSNyNSKDKZoWcgULR2ZWpFbkKkVGcapFdkLmVqRYZ9Oo4ApjfIUmdIoYEqjgCmNAqY0CpjSKGBKo4ApjQKmNAqY0ihgSqOAKY0CpjQKmNIoYEqjgCmNAqY0CpjSKGBKo4ApjQKmNAqY0ihgSqOAKY0CpjQKmNIoYEqjgCmNAqY0CpjSKGBKo8BvSqOYIFMaJRmZ0ihnkSmNwkGmNEodMqVR4OiFRqlEpkzclImbMnFTJm7KxE2ZuCkTN2XipkzclImbMnFTJm7KxE2ZuCkTN2XipkzclImbMnFTJm7KxE2ZuCkTN2XipkzclImbMnFTJm7KxE2ZuCkTN2VSNiNTJsUcmTIpBciUSQlHpsgI7UmZlDFoX8Ok9CBfJuUO8kVLQb5KfOCrxAe+Snzgq8QHvkp84KvEB75KfOCrxAe+Snzgq8QHvkp84KvEB75KfOCrxAe+Snzgq8QHvkp84KvEB75KfOCrxAe+Snzgq8QHvkp84KvEB75KfOCrxAe+Snzgq8QHo1WJD3yV+MBXiQ+2S0p8yshXic8e+SrxNSFfJb4c5KvE14F8lfjk0DmOEl8GMlXim4zOiGtx01rctBY3rcVNa3HTWty0FjetxU1rcdNa3LQWN63FTWtx01rctBY3rcVNa3HTWty0FjetxU1rcdNa3LQWN63FTWtx01rctBY3rcVNa3HTWr5ZyLSWTxGZ1vLBvqaWzx2Z1vLxo71qLd96dLxXy3cQOdbyKUxTR3auyPEYP2x7j/HDtvcYP2x7j/GD4zF+cDzGD47H+MHxGD84HuMHx2P84HiMHxyP8YPjMX5wPMYPjsf4wfEYPzge4wfHY/zgeIwfHI/xg+MxfnA8xg+Ox/jB8Rg/OB7jB8dj/OB4jB8cj/GD4zF+cDzGD/vTY/xrkOMx/m3I8Rj/HeR4jH85ckQuyPEYfydyPMafgBzlqM/HQqWU52OgUsrr0VApZeFoqJQCexY5KtjJUcFOjgp2clSwk6OCnRwV7OSoYCdHBTs5KtjJUcFOjgp2clSwk6OCnRwV7OSoYCdHBTs5KtjJUcFOjgp2clSwk6PC0YIcFezkqGAnR5VFdnJUOC6So6ogOzmqPbKTo7KQnRx1FzoHj6bmjYU6IWljoE5I92ioE7JkNNQJgeOBaNwlGneJxl2icZdo3CUad4nGXaJxl2jcJRp3icZdonGXaNwlGneJxl2icZdo3CUad4nGXaJxl2jcJZoKx7HR1HbkEk2VQy7RVDiOjabuRS7R1DDkEk1dgI7So6makysn0AUoctQmukDLGKiYwTcGKmasHg0VMzxkoWIGHMXRBeAoji4ALnQBcKELgAuaRxIqZoALXQBc6ALgQhcAF7oAuNAFwIUuAC50AXChC4ALXQBc6ALgQhcAF7oAuNAF4IyDLgAudIFo5II+RS50gWnIhS7AQC50gfPIBUWOzp7oAv0T109oF9iHLNoFfkJnFu0CM8ZA1Qj6aKgacUYWqkbAUXe7ABx1t+MW7bhFO27Rjlu04xbtuEU7btGOW7TjFu24RTtu0Y5btOMW7bhFO27Rjlu04xbtuEW7gAOyaBf4HVm0C3CQRbsAnAO2C5xAFu0CzcjCW/A2itlb0AbF7C3oNBqqJdyThWoJcDbkLagoA9US4EzBWxDOhrwFIWZvQYjZWxBi9haEmL0FIWZvQYjZWxBi9haEmL0FIWZvQYjZWxBi9haEmL0FIWZvQYjZWxDOW70FV6OYvQWPoJi9BRNQzN6CcA7uLWiMYkb9oJgVhLpQnApCCShOBaFUWagMAOekCkLrZKAywFVpqAwAcSoIQZwKQhCnghDEqSAEcSoIQZwKQhCnghDEqSAEcSoIQZwKQhCnghDEqSAEcSoIQZwKQhCngpA4ilNBaD2KU0HIHcWpIFSG4lQQWoviVBB6huJUECqZoT45Tmj1mNLmOCHaaLuWOKGxspAFryEDWfAB0pAF3ysFWfAQYRweYRweYRweYRweYRweYRweYRweYRweYRweYRweYRweYRweYZxQN4owTkgaRRgnpIoiRMtCEcYJiYp1ofY6ijBOKHUGZHkfRVHtENZGUe0QPiQDWd5h0pDlPSgFWd5bpCDLG65L7BCGqHYIQ1Q7hCGqHcIQ1Q5hiGqHMES1Qxii2iEMUe0Qhqh2CENUO4TrUFQ7hPtRVDuEJ6KodgjD9bodwtkoqh3CP6Oo2MLRKAa28A0UA1s4Rhryl0nSkL+sLAX5yxADG4+BjcfAxmNg4zGw8RjYeAxsPAY2HgMbj4EtDNcM2cKNKAa2MJF2UootvAjFwBY+i2JgC/8opouWnit3beylUSqjJVsvjXqNYrg0qgHFcGmUuDTk52pIQX6utyTk58IVs0ujIIZLoyCGS6MghkujIIZLoyCGS6Mghkuj4LrlpVHFKIZLo+Ba66VR7SiGS6OkUAyXRu1EMVwa1YhiuDSqRQ4bu0DkgGxU6wIReRnltgUiM9ByF4gYSEHmqZ8kZJ7CcheIwFXHBSKw3AUisNwFIrDcBSKw3AUisNwFIrDcBSKlaLkLROrRcheIYLRG1C5Hy10gEoWWmyXijJaSJcJAS8kS+RktJUvknCRkUMJV2Sx8KVkicJcnSwTumGSJwNX7LBG4ep8lAtfAs0SK0VKyRKrQUrJEOtBSskTGoaVkiTihpWSJzBSbKG0i6ov6NxE9gfo3Eb2G+jcR/UUCcgDhSrWJKNztMhGFu0gmogmofxPRPNS/iWgJ6t9EtAr1byLaivqHLCtlSRNRFdS/iWg56p9Ky0U9U2k3Uc9UWhDqmUr7DfWMxoo4ZLH5om9QaU9Qz8gA9Uylwf0pKq0F9Uyl9aCeqTRBWhRql6KeqbRbqOe7tLEykHX1AvV5l/YI9XmXFov6vEtLQX3epd1DfaL/CdTnXdpr1OddGh+tFLVjaHbid2lzaZISd2naqM+7qDdl1Fu6XJcMOpqTghyiBNTbarF01NtqMbjTh74taoL6KEd9rhYTQz2uFluB/q0W24P6XC3mhfpcLfYr6nO1GBf1uVqscqyuTKmYlDRkx9RJQnYM3I8rFetAvZWKEcS7UOsjin51sRTRLNSOQv+npWJayL9U7Arqv1SsGvVfKjYd/bMTnyQFOSBwb9ROfLKEbrud+DrUg524vZh/B9quoO/aiU9D/1+SEufQnJIShyUhX8NRAvI1ItCckhJEcf8OSQkHsRmdkhKV6DeLkhgjCZkU2yQgkyITfRolsV98RmeUxETxJNR2ie15EyVRLgYZFnlikGGRJQYZFplikGGRIQYZFhlikGGRIRaMt5BhkQFP/aEWMiwy4Kk/1D7CW8iwyICn/lALGRYZ8NQfal/gLWRYZMBTf6iFDIsMeOoPtZBhkQ5P/UmkwVN/Eqnw1J9EEjz1JxEHT/1JPIen/iR+haf+JJ7AU38SD+GpP4n78NSfRJQYZFhEiUGGRZRYNN5ChkWUWDveQobFAzHIsHgiBhkWL8Qgw6JQDDIsSOKQYaGGxmeURDwaP1ESpnKNkuisVBIyI55LzOhUlnSXSELtfok9b9DxiATWpSy5VQIyJpQkIGNikwRkTGyUgIyJjRKQMbFRIhhvIWNio0Ql3kLGxEYJyJjYKPEIbyFjYqNEK95CxsRGCciY2CjxAm8hY2KjRB/eQsbEBgnImFgvARkTayUgY2KVBGRMLJWAjInZEpAxMUUCMibgOoKyJEUCMib6xCFj4rU4ZEw0i0PGRKM4ZEw0iEPGRIN4NN5CxkSDeDveQsZEkzhkTLwSh4wJjjhkTEyQgIyJHWiLqSz5uxxab2Q6pu550yVjOxXr6pKZMPUaapvkl3R3yWTI56E2Vt6sp0vmD3nh3i6Z3+WD8XZ9X5fMb/KVeOvUD63sALSP8FZ9ENpWvHVnQyvP6ZJ5Kv8CtY/lDbldMmHyfag9L3+O1yVzWH4O1iUzRz4NtflTjAldMkZTyER/2Y5pS7r9ZbOn5aE2dppZj7/s79OEe/1lf50WjLfr+6CtxFunfmhlB6B9hLfqg9C2ovbpNHc2tPIcf9kn016gNmqaIddf9s60PtS6TzvH85c1mDYH85eVnpaG2sdTjQn+sounkomHY0imsQTTGOzw8DCNBYY787v5uYdjew7G1EjHnON/eZrw0h97x2kg9hPEfODM0Lyb7ROfxrzv5FP9v106Hgkvzn8gzr817kx2/JWwuF8uxJecjus8/ZJ9OpZ3OhY7EzMs0JzAX94kWGaI2xVQ7YtI9sUE+2JsWBS9Z8g3i7Dh9lPMsy/uty1q/rkwZXPBLXmWz6hid1KJG6HEDftA8bdShPO3l0Xf2tu7eE7xSk8Nlp9qrzpVVO/5sOnGmaYEt9r6UxU9p0o5biU8t2LsyxR9xJDvv3uH4FZEdC/k98yl+aeOvxo7yyxB1CZHyL6Ez7GC5FhJcKzC/t/hOlb22pbXGhfHri2+Mr7MU7DyFLHKFfuvwqt2Zded7G5xqe86mc7zDqHc8SUkuvbUuLS+OVk/eLKG61rFc63CRoxKwqkKsluxkHeu7LnUHwPil4XGboyMUb4fo/IgRnVIzBP4rNLINtkk2zyiXQHBrgCzK/x/p4Bnmz9gndN6ID1za2rw1Cx/kXwPcqE7geWOfQ63r+QbvjXEQnksN26xW3/5qY5615ou10w+r8cSV69JPvLmT3ftrnZtaD9V3u9WxHFn8dwLsRGjgOCRT/bMEfbNHHs+ffbNjDVBmcphmRrhmVqfISJDKzJdKypV60Gi5qOXmnNjdq8s2L+peb8Ke6+GwE66hJG+jM4uCVUT6lrr/rn2zZPsSqSsMkXNEwQPx/KZxpLMXhLN4gnmCQTzRMwCkfQ/gWeeyDGL75ZKPM2f6kNM88Y+Jv0/AS/Di5Pl1Zfn8arcraLNLYPg9YfkhfBx966PeeQvHOfRl+9WV+9R2OmVOeCTyvVN5vkmYSMEwTeJ7Jckcjp1wsWshTcLNgUWaYQU00NLtL9AsXYYokibWajNzNcOz2WE59DDs+nhWX9dhTK0ItI1EZFpWvdTtB4nMrYk6WzK37Ghdv+mngNbqPtVZHepTtmmNkNPbZ622mK62jINjeWq2ku3bpu/4YDCcovRc+0oP9q/nmxbMsYiVexwjMCo2DPkeH9Cgh/2X4KX6MtL8mWn+vRleb0ucq9sdMsa8HohcvbJuOvh8kH3pkReHfPLacFYr+5sj6pK76w2/4Tec/ETLmUsvFm46V6penAFI6RCO6RS53NU/EkoohynTPuz6ISV6oQX6Ubm6z7M0H2aoHM/UeNhnMaSzP1rqg9s6jygjO3TENxJFzPSltbXHaOrN1pHT1ZHV0aPPtpQY6KRqoKBylxdlcV0FUVN5VVqymtVldepKK9XVt6wVXX9Fq21G/VXrNk9f8XPk5ebj1pq1T3fqkzBLGUM4ZPHil/LhwPUz7zzWWJP82JPc+P82Yl+fenenYUeDbVurG73JKrv76MvPZp2O2pmMHN2ePCMqNtTH12W/dWfEuf1OturuNIvue1y/MwbWavvsFSCyrRCyrXh16nQ+XbKcT5MvAf/BeE3YhbpRBToRGXrPEhlPEjUuh+vHhmvGpmoFpWk8XZYRWYyHqXrPk/dkZd8sDnZvD/VkpBuJZBtI1Vk+0ODzbI+803UA8pSe5Qn7lD50Uh1lp76PIbGAi2NhZqaCzU0FyA00Uu1xVqqyzRVVqirrFZTXoP/muuU4QfFUVm/VW3dZvrqTXpLN26bvWn35M3GYpsOcdaY1y80y5l6KFZq4OXprhSftkKPuoZTxYNuaaI+LyZejJ55++HC0PtLIqKWRUUuvc9c/CBo7qObP/xyQeYPX1KiZ1ueV1E1+v+8FjfvVvq6e3kqwYWaoSx6aBEj7G+w/kHRULCGRyGDichnfNguMbO1mDkIOnoZmaIZmap5P43xS7pBfNa+4lzz1wW2nCJ7/jIHyTrHqV32i/ksNkgbq0zarv6jvtosXbX5aNOkpbZUQ32puvoynKXqb6fVEMvV1RTV1FbgrFRTBVQRajjqK1S0lqkwFqvozFXTm65uNFl9l4zKAeoms+7lVlXTLbPGmMWL9Mb7v870ri33KOp0z6J6JY0782LWtV+XBv2yOuLxugeP1z96BDx+uO7x/TWPw1c8CVwYff3H38/KxHmRMt1flbiXN3nkd3lmD3pl8rwysKHJfM/QMxC8MijeGTT/jMmXMhbdytoQlKUcmqnOTNeISNMceVL/8TIVfhH4XVI0/sbjWM2nibox6btyCkzry+16a53Ijc7i7c7yHIclIuYbx+9TUTBUn6WjMZehMV9LfaGW+mJNjcUaf2fJ51EHFqtrLlLXWqBBn6fBmKOpPUNT/weNHRNUDohvNCcstX013bZsrHW2qGUqv0US0SKRYPH2kOZ/gXkizzx+8FBMe3+cf1e6T1uRR3WzWx7XI1nCL/aHS88X3fpjbehvSg+ebn3yVCUa5+lbolWe/qL89NHmp5Ebfg1e+cf1uTFnJqW401gupKbj7J7jfZzjvbzjvdif9OD0Yl94s4dwvId8omuUa/s4n8a5lypWB+QrBaVtYSZsjYpV/j1OLy5jT3apWXWz/Zs3Rwj9R2m8I1MEHJbImG2cskd1hr7GHIbmPC3N+VpoMwUs/Fbefn2+phZiniZ9rqb2bA2Dn1R3ySuZjF5lJTjPgT3FuVPSuVXAuZnk3Exwbsb+NzQhuE4N/fbVzYcK05VTQjuTfVsKPaub3Ip4bpnSPgk/XXqx7M6zjeHPVB4904h+Rv/tD8YfQ/I7/Y9ftZ49UX8WuTXm7rrEi0vzfWY3uP/QdUqefWoyz3US9vUQXCdSXOVETkmM8yTP8u9Ydql8dUDm+pD4Tc+StyUWHMxrsK7pc+ygHOEIHxGkHRkr5TB3nMV6+b2qCoaa03XoPzHoMxD0keEngDGDzpippT1LQ2+2yrY5m/bOWWEya67ljEm208XsFPjtFYj2P2DvUPgydm8n/voVO4VhfffPb/0Frv3UXruJ9aZi8Yzu2wvyz/XFnu5M9W0u9KxodM/nuKdL+Sb+dPHlyjsxmyOeazx5Tv/tufYfz3WePdd9/nn+0HnxVDv2vlbyPdXCK5saz63tPrOKfXoFz1+R578c+yr8lhP8lpJ9Fgp5TpdxHz3FgzzT99XCi6Urb2VuCI3f/DSGnlxryuq1qxdw6pR2GhjvSJzsIDrFfrK89ZIpJpsn7tYcZ6Q9Rl9ntJ7uaN3hIvuev02P/nMaDjjHautPoBtOU0OHHDuWKu5aO3vXlok71cV2avLv1CLu0ML+V+xEaPJ2anJ2qffs2VK/Z1GSPi14Te3FaQkXOmPPdGR4t5e4tzW51vedLBVyy5nomzr/cuL6ewnqUfE6T+MNn8cZxcZtexm3Pe6TbPvLdOy2hD+2pT4yKgjVq7vN6Lyh3n9FmXN5C/eSEu+iEvY1EC5sIp5fz3d6hZDPPAmPyXIeNAUf9sLzTatvFG8KzNjKTFRG2+QnaK+arPc8b08Jxb5J2rFrssPgj3a8mbbkWTaiM20mK1gtmmC6SdxYg7pTm2CkxzXQ5+iPGFw9Q0xnOx99N01138T1++cs2bdaYZfy6O30UYY6FANdooEe9r+GZ6DLMWL07lRt3KuYuW1s5MbuCz8W+Uon+zfFnq3O9SlrdC/B3ErGeJTMP1OkdJOlF1mw+/eCg0kFhzIKTXMLzfILzQoKEOYFheaFb/kwjSbefvRu4t2chflmrCyzkqTD1b8faI7a1R5s0H1beyBAi3NTk3dTE/sqbmgQrqmRrmzlu7Be6PQyKZ+fJvvIzDlNWHHp1cabFVsD81RC01QjktSi4tXux33Ey/d8/PLjT4ec/hzqD+I1HiVrR2dve1FunNZu2Srj2DPZgf2jHXeGLYZWtpm2QtNtR0+xmyFps4Jourlzv0bjdkatvk61rk61zvejW62jV6u9rVFzb+fWQ8Q1FrILzGdMPawoc3CD8P4tlL3KxL0q2Lej+q3fes+ed/D2qHL2qPbtUXm9S6ncaMVL1R/vLhb2ndblPqHCY3S6b3G2f1aDTxLPN172TPycq4kbAlMYD9N3Ps/an5Tzc0buoezcQznA4dxhknc478N0zuG8dJP8+AOsp3sqIrc3But33tMduKvDvauDfS13dLDb2oRbdNINdf7Lm0XOrRjj95OCn9Sis7w1l1uUbpUqB2WrMFNUI9BZbQKse7D6jSTqiAcJmo9StJ9mb4utOJjZaVXO59Ar4cyRdeaNdcLkAKKcE99oJ1FxZzmK08w3NitqTDazdqjn6WrlMOg59O+Hkaulm6++o2TLzw2rrAfmOIhOsp8oaTtDyGo+xXIh0XIRZrl4KBYNg2+b+a9YvINrvnTQdMWbg2ubdimV6G5JUV7/aPX8m0vGnp5P8p7Z4jU131cu9jwr5Vxq+ZkX3WefCl58Mu764xl3niwJ/WVNZLTSo6fKv/yq+vRXtV8/w1O1f8yg/h6Y/u1Xjd+jNZ491oyNoqeFMEruMlpuM/pu0bm36LxbdAxg4NC/ggAtwg0N8hVlgfNrxf3mTfCWm+FLWnK+Zc0N1sZAdD4Sj/Z9Ko9i1B6/1Pot2SA+b39OrWVVr+MrqjOHc5THO4ph7yBgR0nco/wDR0U7ncfV288pMl2TvWtruq56Gl0jVVPze0jT1ErTYGSoG+Qo7y1eZ9E033FgkrOAuLOUgNNYsuN4ouNEguNE7D8Az3ES22FKt41C4+E5rN3LUnRX/aG28sHmhYEb5a+tE7uwin1mad2ZWZnnimIup+Rd+KPx4uOBK1GCN8KlbzPH32PKBzMVQpk/hTFnMJkzh2LGJ6aHImxWRMicqMB5T24tibmyIvfCmoZza3vOruWcXcM7uwY7uxY7h4Mm4OVb1g6DNYTTK0l+S/m9Zou4TZA9JTjFs3PW2bIlN9NXh7zc8HuMdnzizrycwzWVtu1tzn29R3j1TliD88cQGpxIdU78VY7iJXbyueZL0vdtStFXTaGrJ2tqJGt8M5opGlqp6toZqtvzNx+sXGnTPsOJO+aI4KgjNIqzJNFZmuAsjTnL/BfgOctwnGR7HcY0Wk7IM54Wu+2nJzqzIrVmhGpMC1STu6Uqcl2Zd2Vj26XlxRemJ15MS738rPTKo9ZrEQM3w8i3Q4TuBoveCxYPDJYMQgRJfT/BiHvSobdlIq6O/uXs2HhPuWLXsW0nx/afHMM9ORo7Oeav/POdz+IiS3CRIp0Q5T9BGeXSI+VeO/F03ozrSUtexhhmJe2vzDJ/XWTXX+nIqXXCSuyxEoe/QSixJxfZCxfYymVbzk0/sC7FSCWF8V2rSgpaVdQZaWoG2Vv3lq43a1nswJ7qLCjpLE51liY5yxKcZTHn0f8duE6j+xzGNlnJ5R2Y8Hz7pAd6k5k6k0O1JwYz5AIZ0nfpIrc1yTeVe6+ubbgwL/fcpJiLWQmXYwqvPK67HtEREDpwJ5h3N4h0L4gSGMiHwz9SBN3jD77NF3qDEnWB+Ks3J9W1t+rEmzcnOtgn2nkn2rHv5TXhxCuCSwvpZB2/W9kouLeePPVGzPy02F3FySbNWZY9+bbsIntesT1WNDRElj21wE4q13p6xqGVqTu3pOiqp2ihXx/4pjVHK0VdO01le86mg+UrrF/NcsTGOwvTnCX5nGWIsM78t+A5jR50HNNhO7bskFzCrrGPDMYy9caG6I4N1hkTrCMbpCMVqCN+jyF8R4N8c0vvlVV15+dmnU9JufJ78bUHDTeZ7bdDeu8GDdwLYgcGcgIDuSPPPW7QXU7IrQHm1e5HZ1pfelWz3Eta3Qv73Qu47vnYd+LxljyCZw7RK4vikyp8JkHmcswPETFb7seq3I9VRTz4Su7HqiHwabW3PIxVexKjmRizLT/euDbVrCPHeqDAjsvCV78yhyEhlDlQSh1oRXZT8iyWZu5TSjdQS2OgoyONFM1vWy01k9V0UrbuyFhnUrjQpnaq0xvpIxyhoyTKUT7CUT7s7/D/b+EdpbKPCHY5itRYiKftl4jeJhmuLxmiJxkESOCIB+nSAnVG3WXw31Zn39j86srKkouzky4lpF57Wnwjqu4Ws/VOSMe9oK7AoO7AoB4gcOQJQtzrDr77JjTgVeTl+l/PlKb55lT5pL3xSWH7pPB8krERwTcZniXwS6Scjhc5/3L81bi5dxLXhKRsZaaph+MPAIwEWpHp9Idp2r+lGKak7C1NP9yaa93LsuOUOPDerpOtzkNCaHUmtToLNTnJ1drPLzPdULhbNVdPI4uhkYEO5rXUUzTVkzSARPXhoAGoMZKUDZPW7U9dYJ492ZYl4VAh4FRDdqojONVj30vDe/755rd0yHNu4Do39zl1tNoNsEzJsXuoD40Ew/SFghB67wjUE8QRCNTlu6tNuKPVF6DSen1d6ZUFqZfTY288y7z5qPh2RM3d0MZ7wa2BwW1BQa/+fdqCA1tD7jQxb9Q8ulgcdzqryC+lzS+x3y+B65eAjRwEvwSSf7zgmQTZi8kzb2asuZerElKgGVpIDytkfIGh7jsPdT9aO5ylE1Vk8Gvx7rSyw1VVtp31ToPNztwPqyj16DsE3vP+HSL1KJXvqDTReUa/7eo2k61Vu9RYBmrZuqpp2iqJdJU4DdWX6qov1dSGhSpCM3arbuz6nTELD8RONo0TN0+kWiSRLJMJlsmYZcp/Cp5lKscqo9emoMW6hmXaEb+P/Xg7kWlADtYnB+mTA/8OKVCPGKiL3dMZvKPVdUul+fqa0stzMs/LxZ/NS7gUk3n9Met2ROW90LrAkIag4CZE8P8PQU3BgY0hd+vCb1Q8uVCQ5J9R7pfc4Zcw6JfAG+nVmM8/UexsivzlrKW3CjcHlmiGlDFC3j4IVP5Xhnzzc8CTKmEVuswag/tNO//oOJjVb11PcOqmHOHwH+V9WHt/sP8UhB/sKdPsRSfbTxxtt0DAak2PiVLtXqX87ZtSDDbFaR+O4Zi+7DVLbjHLZx2qjdv35smOwXBDLFifEKRPCPwUeligHhf93Hfp3be2tl1dVntWvsxLrMidwnInDP3gpTuP5c4pdO8pdG9geWYVn/69/GpU9e2w+sCQRnyVaA7+/wRfMUJv10Vcq3h6rjDVL6PKN7nTL3FkVwzYuPklCJxOGn0+fdb1vLV3i1SDy+jwRBOg8z28WysqdcPRWtG6M7r/QIKAeZGsbesk+/6p9tyPV4ClFp+CsNSCuMSCutBSfJb1pAm2swVtlnSaLy/7eWXG7nUJBkov6cqxGqqxajiqX0QtVlU9VkUrRunwy1Fm8RR47jQBGxnicYbz5pfhmicOWKS+Ms8tNqmK3/vqyY6+cENOiAEvSB8L/AI8fJ1n31Hrv7666+yPHR4Sr0/yvzpBfHUC+wTcthO9bS6Nra45zd6/N12MbLoV2hQY3ByE8/+7wuMENqF1PvJq+W9n8zP90mt9k7r8Ejl+iTy/ROwdw1y3Ez8FOgol+yWKnEmZdDlzya38zUFFmiEljC8/0TocSrXhicoK/Qf1O37tPJBAMS8YY93wk3XXAkv2Ygvex+v2QsvPQFhoRZpvRZ1tQ5tqP0bScQrP4acW60Ulh9bk7N6aqa+ewdDM0MLR/CJa6QgN7TRVo9T1+5Pnm6aOt8oQscmi2OQQbHKw/x5c29x+m4JWy3KWSWPsnjcPtw2EGXCD9Yez8uPo8e4xeLe3cq4sZvuOH3AVHjhBGjhOGDiOIfr/Dq//OLv/+JveE1VdrimvfX9pvhreeAcOABqC/ycENQQH1ofeqY68Vvrrubx0v4xan9RunxQOnIilYCME0SeF3zdV4my6wtXsFXcKlIOLtEKLGaHFI7D+h5VoM0t1oyq3PW3an9hnzhK2a5xg/+Yn28F51twFVn9ZyeUd3jFlaAhTHIiTHPnknIQknMX5jsj1Oc1osV5Z/fPWsh2axXr0Ih1GkTajiPFlWAxtFkOXpbm9cMvBgqWWrMl2xaIOpRSHMoJDGfbfg+tQ3u9Q1WbTwDr0OmZP7wMjdqjBsFd+WP8xdJR7V4N3Yw337I8cdwm2Cx/7OIF9HPsE3MHjAwPHX/W6FHe6v2w587D+BrP2XkhtMCL4f0BIcE1IUHXYncqoayVoF5Dlk13vldXjlcmBh1ezMCDzK/nbt+Al0StLwCdL9mzu7GuF6++WqAd/OBL+XnTCynXDKw0e1+6KfXW4gGPXKOzUJes0OMGRO9mB92H1frvmCxz9IgR0isd/lEw6SuUeFe91nvLafnGD2aaqverlhvRSXe1SHe1S7eGgU6qtV6q1vUT5QImiVek0+zJxh3I+h3KiYwX234PnWDngWPvKtqXo8JvY3QP3jTj4EOAFDh+0F6Dzbm3mXlrA9pbrPynUe4LUc5zQcxwbCl7PcU7P8d6uE43tJ3ObvZ7VXbxffSusKiikKuR/SFBl2O3yB5eLX/gX5nvmt3jk93nkcz0+XO/9XiDbyyNf2Ltg/LmiRTfLttyr0Aqu1A6p0hkRwqr0oqq3/Vq/P63NsrrXsZN3ZJBylEsdaiWvdXpH3Xtqh4ZQ40SpdhxV6SBXbjun1GxtyT6Vkm1aJbqMEm3t4cLQLaEbFavuY602K/zJpkDKroBqV0CEnMT/GoVcO1a/fVmbTV3R4dexaEewbTDUgBOkzwkcPnqcQB3OHXX2jVV9ZxTeuIu/OsnX6kJoccE+Aa/Fhd3s0tV4srrOPa3y9NOy65Gl98JKQ0JLQ/9XhJSGBZWE3yp+fIGV4MMqc2e1u7EG3Vi8P1OJWZ+l6IsQ3Fh8HkViPsXTLpauuFWhElhFDx6hURBSpcus0n9Qtf1ZlXFulWVjtX1PDdz85Q21wlNiDgvHmY5JNp2ZabI6f69y0TatUj1GmY52mfYw0Slj6Jdq7ixSOpi/2CJ7olWmiHUm2TqTYJ2J/cfgWWeybXI6rViVpjUp+179sr0r3KA3WL8vSL8vcPjo9QXq9N5V776xpv3c9GZPydpT/NWun0nW5lW5cqpceypO1Zd6ZLNOP8u/9iAvMCI3lJnL/B8SkhdxN//RlcIY3+IC97KWUxV9rpVc10pshCC4VpJOVQi6V4zxL593tXzj3QoNSCf8TP7gsNMM8UxDXXS2+7B024vCfblZhxqTTHtems5PNV5XsFutfBujWl+nRvc9Op9HF0evRtuoSmNv2YbDhXOtcsfYZAvaZJNssgk22djIkIUz5Ptf0Q/PJptjk9NjnddgVpxtXPPHjuYog1eh+u3Beu1BX0mg9uu76m031zZdmFHrLV3lRq10JVa4Yp+GW+HaV3aqpdiDlecfn3E1OiXwQVJ4VFIkkBg1LJL+QmRSZCR8PeqfDP3RR11FwjxRzOQHgelPrubF+pbln6prcmnqdWnhuLTwXFqwEYLg0kI52UTzqJM/W7UMHa4ElWjiJ634eetbiv5B8T8oGoIwnAiW7sM8g2dpOzJjdq/M3L2lZKdmjZF2g75uo55uk+7w0WvSNWhk7KhXO1C9xrJiul2ZlEMZv0MZccTOEEvfM8z3PwnPoWzAvqzdurzUpCpuV90jwyamXnOwXgsiaPjo4mg331Nrurm6/vyPNV6S1fh2uNoV+xRVrtwq14FK1/YS96pcn8zkSzExgffinl3KTPEuLXZtaHF51XuinXOig3eiAxs5iCdeU11bpL1rpl8qWnk3Z0topnp4hiYi4i1D3lPO+CufvfsclUp/lMT4PUZnZdKOzXnb1MqN6HUGOo36uk3DXoWa361Cek06hk303Y1bTRuX2TVNcWoWdW6hOLcQnFuw/xhc5+Z+x+ZWm6bCn5uf72yJMmgN1WsL1msL+lp024K02+6ptwSsbbwwo85butqNWuVKrHTFPg2v0pWDNoalp14XeFSnnj6TVuJR1ORa3eXSOOjSzHNpxkYUgksjxbVulEeZ3NmcWQHJK0NfKkXFKD/4dOWTj8GSLIDED5h/NP0OQqIFOdFiVJL5hBTThZnGG/N3qpca0qv1tev1dWArpPe39WSI6X9ui5q1dzSrH2xZa/NqhlO79JEO6pEO4pEO7D8G70gH50h7t2NHrWVHunFn9PY34QZvgvXfBOl9C4HanXfV2m+saT3/U72XVPWpL+5SEbzyU+zSU70sd0i1jj1/5uUrn7Qez+xBjzx00s3Dn7B6z9+evPo8eUNC8Mgjeubwe2fQziSPvxY7uzXmUF+8GSfBnAcrhvmfqwdaZ7Jtvgghx4aSayuabzuJZbWk/NCW2t30RiOdFn3dNj29V9+I/ivd7a+0jF9tsnw136FtnHPLKOcmsnMjwbkB+ySNw+PjmT/VScOwaeQ6N/Y7tbTavio81PliV3eUYU+Ifk8QTuBXoYej3X1HpfPairYz0xo9xOtd+epOEmpPYp+FV3uSW3OSXenaV+zWkeVV//LsZzYFL2L0s17urUk27Uy3Gsyy5g75m2ZZf4TNe/6cJmTbkHJtqQV24qV2U6ttFJsOq7Tv0X5jpNttoNejj9D/FvQMenS39TD2dimbvl5u0/CDfbmUXaGAbS4J7hZ96mD4i/d0Pj7wfo911kfngx+/+YHPnD/CzDybnAHbgnbrsrLD9Yl72x5va2fqdwTrdQT9SWfQX15+9iPdjkBG+52tr64uafWf1OIm0nyS3OxCaHbBvgSv2YXb6MKuO9mHjmdYHrVpftcSFt5OXR+cocL8UD0pa6SgR2YxHmfpx2btKcg+3JRj1Z1jw8624f25hny05sQcfkes6d95aUqIMyPFm1OTLUSzrceU2P5Ub72q/ZBa727tASO9QQN9tv53oGc4qLOzX/NA5ybTusUW+VPNkqRM4qoOZqfvKf1tW22kfn2oXkOw7rei0xCk1XBHqf7qgnq/cQ1uQo0nSU0uhCYX7Is0AryGk+xa+LE6WB6NaX5XY2dezVh+g7XxdoVaYDUjuEYHEfKtBNfoBtf+SQiiBp6KeVi982XFwYISi4Y86850y/4kC068Ge+lGfoh3v0i+C81+qXJ1Byz+dVm69p/Vu/bpT1opMf53tRaA46e0aD2zm6Nfc1KB4uX/5w6fUfaC6OCR3ql4TrloTghn6QC58P0Rx9pl4cwyoM1yu9tKrs2v+z0uHIP4YpTpEpXwmcP2P5+/Fbhyik7NVDk1pPj2Z7sdzqW5B9H8I/DhgGajXw6TuRswsRL6fOvFa69Ua18q0Xz7mvtwA7doA69kSW4Qz+s3ehh2+6Y+p+zi03L00znxe9VLDDeWL9frWOXdq+RXr+BXr++/nehhzDs1dnWydjZpLa3fMPB3IWmqRPNE0XMEynmiVAh7SuAJ1uIZnF8hmlP9fPv6xaH65SGaZeGAmXfRGkIvTRYreTO2uIrM1j+MiwPapE7seijmpPDA0rbFbqz8zz6Mr3QL14bc/5MzCi/JHHvLAmPQhG3Ev5TZaRT5YRT5diXQPOQ3cpFPMsnna1acrV+860WjTuvGfc6dQLf6AV26QV9hjc4/5z+8HII9IPfGDDbtz1q3v2sfH9Sxr4N6UZbi7er121ntBrpthvodejrdegBnd9Bh55+u67BKx2jZvqueuWfqxStK6bZV4g7VvBBMcxK7GsgOFaQHMoF7EokrQommGbKmyRMMUhFK8MDNPB1K8J0q0J0qr+TYEZVkFrl7TVll6YX+0qxPPhZ7sQvFFT8K4V/wiuAtaI3y+tVil9V7IUzMX2nX3L843hDD//4DxD84om+Sfw+6aJe+bIeFePdGsadbJM80SF4opN8opNwohP7EmgeskuniFv7ZP/XS6+2bYHNSBMjsEknqFE3uEk3uPEfDPnmsAlp0Aut14+oNnxYZPQ00+j5S/0tsZrKydqq2boaLH2tCn1GHX661/wneoiWf/Cp9/8yj+4HDJsYuxpVDjWvsGv7wbld/Egn35E3xCNvsK+BcOQN6UinoFOHjN3rqVYtsyzq5liUzTTPnWqWMsb0pahJbL1xUtaunD+Miu/rVzL1atGOPkS3MXgkCGI03FOrD1hdfXF6mY9ksTt/kds3bH/ebYWK3Lgsd3a+e3e2V3OyX1HspTNxLb7JPd5pbK+MT9fIelcpi+CVic7d+DwKRNzLx3g0yHu0K5zqmeIyIHNiUOg4m3ScTTjOxr4Emod8YkDkVM8k39eLLtdvCChXvleoFpKrEZbzrhAZkE0Pz9ZC7YeXb6fRm295+84/p4cgSysCHT1m0O+n0h8laPHizLC3vDQjvjSlxppKxx76Kd54deoOlWw9zTxtegGDwdKGZ2xKdBjlutqVuto1ejr1enA5tFH3q66IfvF6qX6TzrZmrf2tmyzb5zv1yB0ZEDrKJh1lE46ysa8BzU85whZxGpSzG5hu1TffonuRZfsCq4ZZ1mVTbPKlrDMFrNJJVmkEqzRs2PCs0tlWGR3m2eUHCxN3lj82rA3XQ4evaIVsGimCdJoCNRtvb6y7Mr/aT67SXajyq4+j/kIFHFaxy051F7k35njnpVx4GXc7OoZ5PTbjbGKVT1qHV+aAZzbXMwf7PB65RI98iluxkFuVtHvzZM/OGZ79s9zYCie5Y07wRh3nkY/zCMd52JdA85COcwRdemU82n48W7boesaKwNg1HTGHBl6a8hqdsfcQG52pDU4y9Q6z6izX1xmjHStc9arX1X1LAw6seO+3ii1f2vR9Hbr6LTrbWrX2vdps+WahY9+4IxzhozzyUR7hKA/7GtD8pKM8IWeerD1PwYo734KzxHxwmXn3EsvWeTaVU2wKJGyyqdYZROsMbNjwrDM41pldljk1JqzU3eXRhtURaNOqWxeiWx88UujUBzPqA9XqAtbUXZje4CXZ5Mrf7EL89KMCw4HX4sJpcumtP9lc6VZY6Pcy49ovyUEPEiPuJ0RF/ctEJtxnxj++F//sSnzWmcRa35QutG33Tv/Stj0DbdtJnrlU92Ixt7pxaMPu1TfHiz3PgzfTlTfhBCZ2HOM7jhGPY9gwIBznUk4MCJ9sl/GsnHQ2XYH10rgy27y51K6rxpHd4MSjHMXeQ6Qc5ScflSQ6T+fYrek9pNa+i9FmiNbwP48BWkZ8hf/7ym/USt/3eotF1yLHgfFHuMKwGmOEPwteDBfiUYzqjEk6YPLW2FwL3hIz3nJT9grT7hUWzQusSuWtcySs0vgtU4hfk+nDtUzts0hvPpybv6/o+baK+3rVYbro+LNmZAmm19xTqb2pWH92arO72CsXvvYThI4T2PfB6zgx+PpEZ8vJmhr3TNaZZ1k3H6WGRCWHRyZH/stEhSc9CEmMvhUff+ll0ZmXbf5x/f7x3I+OnIcE8kF8k6neWeKeZeM9m6d7dc/1YS/05i3wwGa6YmgI0L5uCPCIx9l8J7qF4NZtsaR/smx1ulljpf2r185dg0cGCEe55KPYeMcPEMY7UsY50sY6TpGwX0Y13zK4X+vNdp12A91X334d+6tAJ187Xmse7Nxg0zvLmS1zlCeAr9JfOwrQwEHDR8AZk7bHpllj8yywpaa8FYc4a37uW3/o1SrzyjlWeXKWacIWSeRhn9pDlXKLpB7z1AaTrJw9hc+MSu/rVYTpVIbqVIaMINqVIfTKINXKW6uqL0yv9ZJqcKU2uRCbv2tH8G530Owy2OTyps61pswjM+/ss4yAR2khUanhkakRiAicyNTIt/xt+sPLz8/2z69EIFIimSn3g5Oib8UlnInh848X9c0a51sxw7dtoW/fEl/OUh/eIk9s9ils8glM/DjGP+zV++1Gnnh8kHyim8+ljepaK+heJOKbJpOXdKCixLr5lVMH50iPwJF+8SODss5cOSfeOCdsnvU75lsR5luR5lkLzrGWnW49c7zlWtGf1ci7tTlGegP41aS+fxs9wz6dXf0aJgNr7djTnbmSR3n8I7a2YytMeOuM2ZuNu5VMmlZalMywzJK1SBE0TyQNO+uKa57Qb5bUYpJWuCcn1qjwIVzFKgnTLgkdWRglIZolgVuKA5YWXZjC8qGxPPjeZggO51zyw99x+NTFLpZ7X4F7a65XUdbp+Iyrv2Tci8oIi8gMD/+XYWZEhKbfv5f69Hpi8vn48tNx7f5xg/7xvKE3+3EfrqWQ/ZKE/dLH+hfNPNOw7OybVacHV/rzlvtiS7ywOaewKS6Y5HGM+jUDBD8L4BLghLefeLyHdKKD4tIs6FYp4Zsz8Urc7N9jdGLTd6WUHy58Y1fH79Qu7dQ70WHwB3vOT7bc2Ta8uda8t4NlrcmfrDMhrDWhrDkkuuLwpIWmi3/8WWnsXk2x7TpChnpUAz0+ff1/Fz0jPu09FFUzsqIDSf4IgYYfwxG+adSQj2DCTthoO+xHK2yBObbsMLbqIG/jXo7Knj7VA683mlYvtMyfZJkmapGEXwEebvJgn1lS88+p+bszYwzyHukURDAKmYzCsJGFXhimVRCimn9vbfaN2ekXRif7Cyb5kpJ8CUm+2HfDS/LlJPn2Jvo1JZ7OT7kQk37jUVZgRE5oeA6T+a8THpoTeS/78dWsl6dzWF55rR75eJ2WAuzTENwLSe4sIc9SOb+aeefb1l7s2XSevf40b6UftswbW+iOTT+JjT2BjTqOkWGXMfyxg70/j347ggZIJ3r4XF6NcqsZ4583/Ubisidx9Og0g9+L9rxsOZRJsC6Ttmv5wbZrvtXAMnPOSlPe6sO8NYewtYf+HDvKewGVdxBU9pKU9wls2S+9wXj68gMrZ+zbOn6XlsQ2nVGGekL6eoL6+giBYSD4tTPoIbYJMPZSlc35ljqQJx0hiH7HOKIcwUSdsHG22AxLbJEZtvwQtsYYU9rNVd85qLm3S8WkaZVFyU9W2TKWaQKWKe+rGXwBrkVyn3lKs0lawe6MWIPsx9o5kYzccHouc8TRymFqZIduyby3IvXGj4kXpBJOUxP8iCP1l0cS/NgJfl0J/rUJZzKTL/2RHvAgOygiNwyePc77dwnLY4bmRdzLe3i14Llfca57RaNrdc/JWs7JWt7JWmxo6hDEk/UCrk0yXm0zz3Wtudy/5TJnyzneutPYCl9sqRc27xQ21QWTOo4JHMdIXz2a/j6mSCd6qSdfSXhWTT6ft+B2yrqw+K1Rcap/lrr9HvDytg+T6I8z9Z8W73re+jM66y0cbVM306pD0bRv/c+czca8rft5yvsw4M9RCdNb9/2V/YSt+ymbjUU2HBivaDJ3psm6sQdUR+1mkLbp8gz0OPrfd7/+EwzCrXwDtu52Dv0AV8mKN98JG3sUE8QP9r7xysARTMIBm2KNzbHAlsAhIrYOme/gaaFF7OpVP/hqvXnVHOvCMTbZQtaZpGFkLvCsMzlWGd0WGQ0mGbm7MmL0M54wMqK0MiK0MsJHHM2McI0Mpkp6yNrUW7NTLo5J9RdM8yalexMyvLAhSfd6//eb/vmR9z8/4qZ796V7t6b5slLPvUy//jgzMDL7/2eXB3u94JyoW7nRF/KTvYvLT1W0u1YPnKzhnazBPjlUawkn68gnG0adahvv07XgwsDGqxyVy7wt57C3Q/XDEaPEVx8xDj1m8TsmvUKubbI+VT9dzl9xL30zM1k1Mkn9PRqfIuqvn0Z9NPGOFK0H6dpPco1+r9wX/8YsR8imcpJN23zLnlWHBzcc5KJxumU/GoMf8dHYXHX4PabYSoCw0pS4wpS63Ex8geWUaVaLJM03Eg6qvdlFbzbSrtODVIi3Bair/so3F7LGv65braNfw9jRgAbROpueWc5sWfzaxUgPVUzLiKe9jc3Y261yuFXRumqaXZG4XQGfbR7BNg/7EpDab53dZppZsi8t2Sj1N+3Uh1qpUZppkZqpEUDae/42nfql6aG+opEaoZbK3JIapJh644f0sxJZ3vw5nsRcD2yE4OZ69Od4tmV5F2WciU+79iQ9EM7sMsIR4f8uEYiwjKjAjCdXM+JPZxV75b5yLxhwL+R+9g/8EdxYJLcSAbcqGa/WmWd71lxlq17jqV7CNp/F1vhjij7YIvwS3/j3l/gIIzBg4doIv0uXuHvTlLOliwNyNoSkqYSnqEcma3w7KZpRqVr3M7Qf5xv9UWWc8saiSMCufpx95wyb/kWWnOXmvBXvhiGw6q/Tb8fpfKt/Apdi5loLzrSRkrebJmm7BLPY0HpAuXS7Wo6eehpU6x1+/Tcg6T1DvsRrxGklq+mmK+/K32Bavci+fcqRAbGjXL7vuPxCdcak3l11xwfsz9h6dDCxHaMb8nSMuDq7BjR+7lxn1TDLrlzWvljAjkUcxt/N5NkVDNrkdphnVh1Iy9ie9odO+iN6eiS+e43QHGHe7V6V04NXp9+ckXFOJttbINeDlO9ByPfA8t2/H16+ByffoyfXszHLJyf9/LPUW3ApPjU84v21x3+V8NTIsNQHd1N+u5KSdjq12jv9jVcmG2oafK5wAcEzm88zX8yrfIp/85JLPZtvcDSu89SHGrOiIzNm3w1b8okBoZMdst61My6zVt7N2hyWphqBhm3K1w7Vt2hGpdHvZ+s+Yhn9Vrs/uduihGrfPNqxe6r94Exb7tsrPEMNyeFAmGdNRsN2hq30ZPupNLuFA5arag5uyN6uFKetG7N2b/pSy7Lpjm1jjvSNOsqlwM3Zrx5cb/eGfEcwMUdsog02yxJbbIYpojPq/diWnZimIaZjwNPdxtHe0696qH2VTYOCfaUEJHyVEh1KsM/Csy/h2hf12xS0meUU78uON8r5RScvkpHHZOQz6f8KYZp5Icp5d1fkXlHI8ZfM9eLP8yDC4BoxuPke/XkebdlerMwzsegINiMoEt8nhv9/8G6feD3j5ZkMlnd2q2duv0cu9xP5F++zMPLJHoWjPMvG+9UvuNix8caARgCXfh1Tv4htOoOt9sOWf+/Vm0+OMuJxNr9Lj7h7i/zZisU38zYEZygz09QjUjXeEjks8D+Kl6YVlcF4kKv3uHTHby0HErnmLDG75on2PdPt2LNtvmJwLTd/j9lfMScsMycvsRCcbyXxo+0EWfsZRNvFTWYrc/etealvkjnDtmqCc7v40X7qUS7pW4fY212YkPPfroVim3ZjatswbQNMFx9ljL39ymYdy+yaJjvWiDpWkYf3VCTXobzXtqTJrCh3b9Ezw+L7uiXMd4/C/gswSkO0SoKUi2+vKLyskOsvke3Fn+1JzPbERg5etudgtmd7lldZtn9C7uXH+XciCoOZhaFhhWFhrPcUDsVnPvrbPJ+eLbSQGVgYdaPg13P56d4FNe6FXe4sNhRk+GQRBoJbEcmtWMC9Qsa7Yea5jrXX+9VucRi3ePRrmOoFbONp7O1l0vlu2A8umMxxTPDbL+wMvTujnOgf5dou51Mz6zJr1d3szaEZan9J/PwC8EeuIzK1IrO0HxQY/FK5+3m7SSrZsmi0TdN0m+4FVuwlFrxlQw6cf4LPtubQZyCsPkRaZcq/zFxkrpX0FLtJog4zem0XVpgqpu5e/YfO+ieqGx9u3vRQadODTd/M5ocb1B6v1f9tmXHiLCvWRMdGySNdQkehPgvxmwbvh70k/xFM3AGbbIPNtoC95Ntzxq3onNEQjV9MDw3h7Ry6cd9mi45F9o0THKtHOVaQHcoJDuXYZ+E5lLHty7psSmoOl6TtLn1qUB6hWxH6LjfhX0C7IoReHqRacnt14ZWfcs5IZfhQ072JI/vnvNO9B9O9OzK9y/J8E4ovPK68yaz5/yy6FRJYG3ar+v6liue+JfkerBb3guHc46C4l4h51sifblt+pVf5Fod+h6d9C6NfxVTOY+vfX56dewqT/97Ls0PfZycdHxRw6ZL0aJp2rnzpTZZSUL56aJ5WWB6dicj9EjAbI6JA536J4S91e2K7D2cJWFeMt22ZZdW91HxwpSl39aHPD8y/o2j2eQjLzYhLzckLLQVm2YhOsZcRd5rEdZjVaLWs4MD6FMMtcXSVt5WZY3HeVmCO/ejlx+8PWaj5pbJ+woZ96Ysti6Y6Nkgd6RQ62k85yiF+6y74w44YHeuKOmLjbbGZ+M0URfxmyuZ3x7poFGN6RjydXYPqJl1rrZtm2JXL2LEEoIZSPsEuHxsS23dwbfP7rPNbzAry9hU9Nyy5r1vG1Cn71oSUYcAoC9EqDdpadGt5/iX5bH9aljcly4uQ5YmNELwsT062Z3eOZ12hV0aF/6+NlyNe34KK/Z2BQZ1B/w8Edgbd7QgJeB15sel336ocj+Im98LeLw1konuhgEeprE/drPPt6270a9zhat/l6bwfyBvQ7vjtfRa377/P8qk9Modyog/2yL4Nc69UrL9TohbM0gotoIflA8zPgf/N7kKdqBKDJzW7YzoOZZNtqmTtX/9g2zvPGu2IuWj3+qWB+Xem2X+ZqfYEeShHSZFzEpB0FqMeGdfnOLPJalWp8dZ8I41cHa1cOv2bgL8Hl6e+s3DTobJFdo2TnDtpR/v5vnsUfziiFnTGZO2xH9DxPTqiNsVWHsQ27oEjagY6otZ/O5a52rv71Uxer7GsnmFTKGOTLfDuzsuXHkiG2y5ZNQdzU3cURusXR/7lyZy3B8PDmS4d7lcYJaHvjqtZl6YV+YgXu/OVuBFKTmGln6DkI4bxEa/0FKf0VHf5qZoa99QW31+6LjEHbgVz7gZx/5W/CPMJgu6wQ6733z/X+dyrqeBUTYtrZZ9rBde1AvsERNcK/lPVEp4NCmfbV13rU73N0b7H072L6QRgWpexreewtf6Yoi+22BOb7fp/xN0FVBvZ3gDwmRjB3d3doVAoUNwdYkipG1RxknAStNR96wYRvEC922233e1bd98adVecZL6ZSYAAgUKX3e+d3+mjyZ27KZn/XL8XMEUnMMvMwFiMlKJZrrxLZ+NTx713Ao/9Ec39Kb7++4TGbxOb3ntgx7dI19Dp3+Zd7lzx/ds8uEn3Sp3Ra0gXmBVDlsVTis0xiKVTIlMKwvClWEwpUVCq2sUwf1rofXdV5K0FSTdo09p1TRLlRmr6zcTFneHIsX1vDJl9CqUC3D+OZckpdprww2hoip3/cB+vKJxpojo2MjoTs+rJnNybVgW/qhX8RMj/EfPeXZfzf+zJ/enRql9+WPTnxfQbrZRbDf9eBXuoms1LulUXfuug+51t+veq5B+UYx+Wgw/LgBkifFTW+6TsycvyX7o3XBLuasUd5hNrubIcGOc/woXVEvmHcK07hZere34re/2M/bKP/ULIfg5IA7KfY8teyCNt1bceH/VFHhWk1EKUOoB6AiAfBhKHOn59NwOeGwCHcsCQDSixAPxMls7D3VMCYlm35oZn1rtuzT78Uwjnq4iGz6NbrsW2Xp1sdkTbtYSOz5LP/Y965buF3/21+taTohc9jF6gVIBH55YSP8hL5lS9QIDPmTj0NB/9+0WunWtDby9JvJNOukMZO946NZQ7pPS7SYsfRKx77lHSZcgcUEDnrP/ziB6ZuYRWtiVnLiGV7QyAjEY0DQ1qKjLk2h2z+oVvwQPz4jsqJbfxJbfA92yie2uw+Nbbgtu3c+5+vuBBR/qjBupjHnV43dmTcaayWm2Sq5C/ImvZkh8fD3+8z+3xFv3HlfKPp7w5w3uhW20InpZ1vyx71F3+I1jzsdzuFpUjfLU6njqX+9/iqPOOqzbtUzqzmfhVBdjJHnzH6h9k9UGsPkAaDKuPWNanXTPgtHsw9IgwSRTUtQDlKJCyH4gZM2WCPVNTJsaX1HBNXiBb1q1R/cRix1/uB7/3r/0ytP5/0c3X41quJ7ROKLHtetLp66RPvsj89tvlN39b/7yzuOcxQ/CcCU09Nse7S58uTGeJbGeJzu0i51vrQm4vTbyTQeqkftisCWonKeNe0pKHyO5GJT2GzMEPXvE0eW+2jbTebFFcI6GdDlGyBMnL+8Jz37mWvNZlvpRjvsQyXwKTEjJf9tBfPcx9/d3yt+fmdTWldfM+bL+jaW2LRO6uTXx3JOj1bvtnNciqkHvlmLvlwCS7/E0ZdLdccK+851H5k9flvwmrr8pvb9c81Khby9fj8vR4/zGuXv1x3eZ9muc2KX1bTrjPArtYkIAlhFhCYBx0qFSoWCE03gJ574dijgOpcFz/R+U1OAQDsLAgC4tlgTLsQZWKN0abHjntvuN/+FZU3a2kUXt63yaP+bn+NqXxNrXtZuYnN5b+dGPtw9uF7+6VDDykCx8xoIcM5DjjMTtyTzFUH0gQ5fBgUvfpmPt04n261t1ix871wZ1LEzozU5HQpkw3rimdyBaymfcSlz0Ky33pSu/RLxXIz3RoDy91gZvVonp46CIgbp64WS0KbRoc5plQ6hJhzLpB75IBY2a/Qmk/trQfLO0HJiYsHehjDD4tEP6cDX08H2xOB99zytWMoIJ1qcDx6IH9s99uNXtcrdJZSbhRiYFbx39W/SN/VcHN6sGble/uVtx/UfGDsOaS4q42nSONBnX1Rjy+Ef8/xjPic4wajui379S6Wq30R5nMCxamjwUIJywrAflywGAT4AEH8jEgpQ4QldrkI0DSPiBqJ9q43ow0rp0qAJNprg6eOKJF4YwDWQSQRcSw5TFsZSxbBc9WkStX0qxWsN6uMOeAYswJ5VSOMoWrQhVTlvhh6Ge+SlqT8rzzCsu/lcm7j6G/EzIHBksFfaXC7lLhG6bwJROCS/CnDOgJA1mJj5xXLj02R8XvU8Z0YZ4wZJ4wNB6V2D7Im3tvRdzdLGRf6H8Q2kvh0H7lSu/VKxXIzVxov3+mB02y4AYoC4BE+N1CyI4JqZdChPftFQCVAgNMzOti/I01stcWybdlKNTTFLjUfx2HIl+XInssCrtvdt9W82dVqncqZf5C9k6Z6BS8KUB3UPmzauBG5Zt7FfdeVnwP1VxS3t2ud6TJhNNgxq83h9X/x/jm9RyzpiMmHbv0rlar/Vkm94KF62NhhCwQkhbdODagDFe24RA+CMTD5fVQwU2SmP7hA8c+Ov1Djw0ofOD0D3FQg0hQ49GIVoDDGVemiS/XJ1SayVTbyWxyI27zUdobrHc8yr45fvbphMDziSHnE0MvDDmfECbpQmLYxcSwS0nh1xJjf4ij3Alb8sp3dbdLXq9lUa8+vU+N0S+PHLcxCLe7+0sFaLDDFXUIbh0/mzRUH04b+JBBeEhXfVBidS9/zt3s2M75KR8c2p2p8+4lLH8cnP/akdGnhRwWAmFmKK7fP7AlDm0QRk0HKfMxSdnY4AKsAwOnWYqTKcVhSnHAxKBSfD+T+KJQ8c8ctU8XaLalaTVQtXijaHKpWihN7sjPKIoWT0TyxVHJxlyC/pUCXwj/qclJVa+NVzoUiNvp1F2j97BS4WYl7s8qUHJp6tSJdkb6q7L/dsXbh+UP3pb/jN3wqcbO06aHW2w4TXb1jfYNjfaNE3JonOzd6RrKrQHFt28+bnNqj/nVGr3fy1WesmV7WHgBCwshxSUoCcMCiWWg1gbQYRcYfARMglvZHLStPW6o+p+tJALRiCZgWLJYthKuTJ1QrkesNJercVTY6q20J0T1aKJ6Q4bauWVqX6zV+DVf51ahXmehwb2iIRI/3y00hA3/9X6R4YNC48cFVk9zXZ5lz302P+FpSsbzsGWvvNe+tS94Z1zSpc7okWX2AXBVsVTwlil8wRTChfhjdCOd8UE6fCD7TQmTvgjeLMbfLFa5WWR+M8/nNnKmcPKdtA/oQKPcQYI66178yieBBW/sGX2a/0JQi5bQ6klOG1uONLQTMuCGNkilYag0LJWGo6YTKFnE5OXy4XmKrnQlXaayLFMZw1QGJiZkqvTT1Z4XaP+xUv/TLKN2mlEjxaieYsCn6PMpejyE7r+FrMNJ1jwerXjAD9hu+3qD5n10C+ubleCNSmCaoJuVgtsVfffK3z4ve9Rf9odc9f/0t1+wPdzuym31aGzxbG6Z1fL/onlWS9OsVp7HqUOul7fb/FhtdL9M4w1bsY8lK2DJQCwCIAHDJsiWE3Q3Elz34sKPYpNrMZQ6UNSBlrwfGecKHj3OpTbtcS5RGY3HsuTwbFWZcj3ZKguFjc7KO+ZoHIzShr+SUwv1P11p+N1aw9/yDG8WGMCxfLdIIpzfB41x484Cs8486zvrnDtzfO4uirhHJd2PWvRg9qonNvkvdEreyDG7BMye18z+RwxBZwl0q0RKeP49beDfxfi/i1X+RsJ59u2cqDsLk26np96ikG5Ob5CLfINEvZWS1Rm38vHcgjd2/044Sx3kCkUGucCUdAw5DUdJI1LSFcnpaqR52omLDcNXm7vnW+sX2sgV2WCLbMAia0A6G6jQpj/f7sUahz+WOF7NcDhFsW2hWDZSTRuohvVUXT5VW1xSU2aYuKQmqdclKh0Jx+/16Ntk+LJS4XE57mEZ+LAcmA7oYbngUVnvs7JXXWX3seV/aG34ynrnJ+5Hz/jUd/i1tPmfbAto+//T3hrQ0Rhwttbv04+8f9jidLva4lmFQVeZ9kCZprBMExgClmnCtV/FKg3Tbaqz4ZbsMWJKLY5Sh6EcB4fr3gFDdW/bD6l7g2hvGJFQpiJfYaBSY6+xw1f7UJR+PcXk7ALzayssvltt+cs6iz/WW/yVa/E3LG8cqa/nSrL8C7be6q91tn+ucfozx/PPpXP/mBf9VxLt5txldxzW39MufoxhvHzN6L5PH7hVIhwfuW+Y0wW+YeLfMFXeMMxfF3m/XBvxZGn8vXlJN9OS/6Ck/EZK/TV1alJIv6VQ/0icfzM6+6F/4WsbRr9GqfDDNn75oKY0mJiJS82UTZ2nmpypn5BhFZvuFpHh55cVYTc/XmtBInFBImZBIrAgYQKJ0ILEgaykV+kJNynRX6UGXyL7nKU5d2RYtmXqNaerN6Qp8WiK/25rOlnmaCTmI8/+zUZvKhRflOGelYHPyoApg56VCZ+V9b5kP+8pu4Wr/EF70+c2ey55HDvrW9/h39Ie8P8XxXPb2wLb24I6WoPPNIZeqgv936GgX3b73dnm/XyzZ/cm98GNbtBGNwC2yR3c5I7d5Ca32UV3h73TPrOgw9qxx5SSTxBJx3GphzEJe8EI0QIKtOvbvhwwmGbXN8jCYFkEmTIlpUp97c32Jh/5WdfF2XWk219Z7PDVCofvcxx+WuXw82qHX1bbSyV6a3wC+JWxVsFZOf6U4/zjSvcflnl9tyDwO2rMt1Fp33st+9l0/U3F4qcQo7uHOfiWCb0dHZIG9BGGKINxRr8OGtLxhnQlgxIjnSJX5dy5mFURb5fF3F+Q8Fd60i/k5J9SU35MmYJk0k9Jab/ELfw7bPUD76I3FswBNaQDCsSUgsBM164V6YB+IWCXC3iuBXxXAXPh2vUiTNx8fOJCxfjFepGL7IKyfH2pMW4JaZYRS7RCVsoFZ2ODkB16gIlBQdmDwSu7wpY+js38OzXph4ygLxa5frrE+MIilfZ5Mo3p2H+x05sKcshAbZLgSEjvbsfXNVpPK4iPyjDTmVgCPSyDS+GeJ2VPX5b/3l99XXbrRZ29py2OtNnXtTjVNzk3Nrk0zQzn6SR2bW50a2n0bG2a3d7kf7oh6GNu+PUT0T8fi7tzNPH5kaTuI0mDR5KgI0nAEMyRRMLhONWD4WYHZrsfsAs8ZBB9RC3hiHziAULsbmzodtB/qBS2KQN0WYD8lJvJIAvEsnDEMnnVKh3DrTZ2B2Z78sJ82xP8LpD9L9P8P033v5rhN3OQDD9NC7hCm3uFEnQ5JfxyXOyVEPLnPvN/cM6+Y5X32qR4wKgEGhOhgTnTBQbmYANzZOfmaPiuMnNd42y6drbi2qC+7OgnixLvZKT8jR5E++dof43++S8S+c9U6l9JcOG78r5//isH+qAuEytfischXUxYsBQDICEsMgNzS5Tgf2oBYL9+OHjB8MXYmMWyMSs0QrItvFd42S+MNKaRNRLny8cswUUuAyOWARHLJ7YMQPcsEcYv7COlv5mX+HhZ4K1Vzr+sNvhihcKFhWArclj5AJfWD+PMOGo/h9xXm9RzJOTNHqenm7TvV8pOetyn1ANABzsr3tytuPOo6qtXW84P7DmJP9SkeKxerZavweFpcrn/NR5Xi8fRqa81aDphcfKE0+la749PBF0/HvXriaT7dZTXvLQ+foagPgOqzwDqMwHkzwyQn4HhpcnUklSOxBgd8Hfc7zTngEnYAY2ovfLhO/GB2zBz0N4t9yrAqgzQmk7vFoaFIbBlVCpVjLcYuex39KvzDm0KiGwLiu4IgcV0hEaf+hfAOZ8KiT0dFH8uKOlyIPWboKxbQUtfBa3sD8oRjonBuEVTFS+yEExYiElYgEtYKBe7SDViqW5AtoXrGneTNSHKKxJwC0hQBnUwDdnoZkBi05uBsXvgpAvI8wVJK8GQfKITXUWHoSnP0CQw1XBMJWypHKaUiCnFg2jwgv8gcqU2fv2yweBl2IjlsuGr1P3WmTiudzJY46uSHUxcHoFdFgkujQIQ0aioCS2LhJaHC7ODB1b7da93e5lvdS9X56cc+cuLwLZMOGD70YDt48w4ah+H3Iuczzv31S7bJzXqDyoI98ox7ztLS5LwXnnvvfIn9yp/frjp0tPdra8PN3Sf4PXXcgfruIL/cmK2WJ2QWwvxj2KbDsh3fKRz4SObq/u9vjkQ8teh2KdHk7uPkwZPkKFauHpBGUJGnCBjjqUQDscr7Q8z2OvtsMdm9i7dgB2K/tvwvlsxs9ERZBd091H1KXdbwSUsjo1TqJAz2Kzp+pFp4HG7aL5LfKNbYpN7UvMwj5mGZtvqkdIxi3zJJ/3bwPl3Iha9iVk8ELcIGhOAISunAgyFrcCErcBELMNGL8XFLsYnLCAmZ8mTMhSpNFUaRT8txYGa4EOKDEoOD00MC0sIC4tHJYwITQgNTYKFhCYHRyQHJCR7pieYL4lSyw6WW+sjl+ciX2QtW2Isw9CBYxbPVMCVymJKCWAp7oMDdvQe14A30rbFBK7Eh2QrBq7V8cg3N813UM1zk8n1wKz3BNfPAqbKEwblegjzXAcLHHsKrZ7mGfy+SuXqYkJ7JtCQJuAhp7oPzjzqIIc8UBvfdyiga4fV62qVl2X4l2zwJRuYGuglW/CC3f2i7MHziu+ebT73/CPxMqi3HO47Ea4UXTNBWs6cd9y6d7wTXQ2Hek/uFl7cKnd9s94PW+z/3ub9eOfcrl3Bg7tDod2hwJ7RdiPA3SHYnYGy2300tzpabDF03qzsuZkwawvGawvotQlwR/ujdNlTrQmjc0gwcuUyehuVXfZqhxwziueapfAtUustSVJY/QPjcmu0opy0SbvosOA7j+X35+S8C8wZDM6GQrJHBaBLvpjzOOjroEsexi0P65GL814nM2eNXFC2YuRSpaQs1TSyxsJYrRVBmmu81PPt1YpM1Up01Oma6nR1EQ26Bkzaz+padHW9EjWrQlX39WohyzUTsrTTSFpLotRX+anmuSgXWcjT9YkMDQJTGVcqhy0loLViEJz+SmTVEsAU/pegXU++qzH+q2QC1qj45BrY51vr5jvJ57li89zAPDfgQ7hC+c4DBfZv8s1vr9X+cpn82SxsUzrAo0FcGsSZcVSojiQ8ESc46DuwzbS/UrGPjetjgX0sYGqgPpagl/Wul323u+LLri2n3+1vfHec11XH7eIM4XK7xTjdnJk1nDOii8tB1XXxjnU17u8+ta3v2gbglwrFOxV6T6vM31XbDFTbCavtgIlhqqyJVaaqldqG1fLWNTjnTaAHXIBuBmZNf+gHHSnGam0gOuxWCjqinlCnSeJqU3iSdGaUOFsqX4fWrJd5wWjJdxZrHtjldTvmC5zzodGhB1gWi1mMZlkMWhZhrItwtoUyzvlyXuuUArPVYhbpkKmG82ONlwearvY0Xedokmdlkm9uXGBiVGBsVGhkWGg4OTgNzLjQyKTAyCLf2C7XxG2Nid9Kk6gFxmSKwcIYnZwA9VxXODwV6DpyTGWZUiIOWTo1jcAcLjTFe8qtBX3XYH3XyXrnqTsWGhsUWisW2OMKHMACB+BD2MOgQrvBIquuQuN769W/WUY8m4VpSoOjEuDSAM6MowB1ydDRMGiPs7BGS1hGFCJTjYApg4SsASHrhYD9+0D15b6drT2H+T213B4OjPP/gAur7eYf7m7Z3XVxY8/35YK7bPwrtkIPW2WQrQax1YGJgWw1LFtFhi2nUo4zqIZsNwrdNkNeWwCv6e/pAScgsEG1KqzNDpm5h2UTauXJHHkqjKvw76HB+IppzSpZ5zWXfWew7qFpYY95sWB00CFsC6UC7Qqx9oUEp3wFz/Uac7P147JM0pLMlwZZ5MyyWOtosd7GItfKItfSItfiw1iirNdb2K2zcFtt4bvSPHq+KS3FZFmw0XoXvWIjdYaqYilRphSLnXI8jqnBeq0FfdZhvPNkXIuUzOlaanR9GbohpsQIoMMMp8NAgr6QrttbovEoT+H75fhz88BGNBhnPhKpANKjmwAcCgC2WwCVSgAbh47nT33wXwCxuiHWA0H5t/0bz3Z/1PTuGO8tWn19yx1lxpfwv5WCg+CdeNtw4G3H1q7rlX232ILXLEw/Cy9kESCWDDApkEVAul7ZoHql0KxG6LQZmrUF8pZYgKA8tVEY0QxJxQrQdCvG5yA27gSOVIejcnC0fxUXT+PLpLfIz/9YY8WPRusfWxb02hQKxweda95YbnmgG1JZlfHIVfZeqxew0jpqnmtqomdGqOdCX48ls9yWu7uucHXJdnHKcXJc5eiwysFhtYP9anv7NQi7NXbjid6C08ApYfBVTjmOzjnOLitdPJa7zl7iHpjlEUvySItwW+HlkGdhBtdtmUQF5DCnKU1IHp68JBpe8YDLxHWgN/xvKMJbMWS1mAqyTCUsUwlkKgHToygJYioMMuXflhBvrcF9tghsywD4/2KBCByFW1GOwAYNoIwwzRiEAFY/hBSIf/RVXXm78+TLw/XP63jPudxn/x/g/+5zXu2L+kOv2ra/u1rV/xfcykViECtkwQ8XGH5iSAKQhcOzMUrloMEGwB6Ovi2At6iOOp1TZkbWIGwGPfeBUcfA1DqQygFp/yoeJq0Bn9musOiqds6fFrkvHfP7XfKg8RE3wTaqOPdcOfdcnVlr7XyW+wRkhgQnR0TERkRFhsdGhMWHI901iaEhySHBKcHBqcFBpKAgclAgOTCQIjaXOneY+EVyIJKMFASnD0kJCUkKgXOA84mIDY+KDo8PCyf5h853n7vKwrNQw5JB1CjFEKc2mWF4iER0cIAnEoCAF9zoLcaaMXFqpXiZUjymFA/8M1ApfpCJe12E/WsVeBlZ0fPv1EjRQvBEPHBwDrDNFKhQBNjYaQagEGD1ClmPB8p+6Ko5/3Jv87Nj/Kcc3lMudxIfHF+TZ/uUB6t7Vn/kZeuurkvVgl/KcM9YxD6WnJAlB0wByJLDsmVly4iaVQTLjVjXLSBcHfVGq6M206mOwhEqUwZobgAdd4OhR8DkOpDyr4YeF4m+9CZ81lmlZV/rrb1rnffOOX/QTdoWqZJ9NU5ioFM+Dq6FOuYbOq53d8gOs58f70BNdkxNdkpJdk5OdklOdk1Ock9K8kB5JiXOSkz0QnkjErwTEmaPEL0oTjArEU6PXOWelOyG5ANnmOKUTLZPSrOKX2QUsVrDp0jWiolVKwUIyJzAKZ2SKcuAtIogZHcaNPS84cdHEdaagdMuxcmV4rDIqMo/jT5hKb6Hjru3DvvFYkx7Blj/b8wroIIcClibBB4JAnZaA1Uq069/wmXfAMR6JWD/1Vf16bsdJ98cqn9dy33N4b7mjphmNXJKFdfXUnBec2vf8A93te4UfFJN/K1M5UWZRn+ZJlSmBYylKRWmTJNQpq5SqWy0QdZhE85jM9J3iq6jgfSnenQsEpt4NqhahbHZiQ08jE2sxVI4WCoHS5sQZlLY9+BiaXx8eqvsgktqK38xzH1mXdDnUCB0GgmukXBzLBgPdCzAOhQo2BcY2uR5mq2KNFiUrJNB1qZRtKkUbQpFh0LRRemh9FEGI8iGZEkUQ4l3RYn1hnLQQVC1KTRNcoZaymLFmDUyvsWgGVOohGw1IwBLBcCk4AR4pkCJLjAsEDrkQkiptx7jWYB3LCEaM+VUmPIEpjxYKg8wJ6cwOaTayVB4VSj3x0qZj+fjm9OwPBqWS8NypMBM39C1VGxdKvZ4FGafG2ajDlgmM824E5V6oqbf1wObzvTta+g7xu2r4/ZxOGP0z6g+qbgn+vmHBa078Zc3qPxWofu8wrC/whiqMAamBqwwwlYYyFboaFSpmNUQHTdhPOC42yB0rBAYswUqLAGBJQBZAmAyQjTusMqVMubb5fwOycXVypE5clSOLIw2FnE6ZKXgytF48rR6xYx2tYXX9HP+tsh7bVcw4FAASQsxKY0+FMY1T9YlT9c+z8VsbZjWsiSlLLJcOlWWRpU8fGoIVY5KlZ8SyaskD65KI1IzCaQluJi10GxkWXevQmkPtrQbLO0GxLqkYHZhmF0yjG614l7T/H6nXIHHetAzj+BSpGgJNxsZWnIMbSxDG2RoAxPSmZSuCMTQ6S/Rfpqr/v0ypbOZcg1pRC4NwRlL5oOg11KJHDKxNlHmSABhhwWuUgnzQeUdwHoFsX+Hqi4Jd7UIj/CE//FOayNbrtUKeYeBll34jzco/Vqu9bxcr69cX1huALyH4RADsFwfV64jV66qWSlrVoNx2ih0qxlwquw1L+vWYHcR2V0YVhcgRbcIyOrFsgZk2FjVSgXzbRqzD2pH1+qkcLXJ4vECLQRXkyqmMZr6aGPe1RwhymdoAILapJ9xxmThlzbZd5zWvXXNG3SV1sSDeeRKBXrkEtzyVJ3yrC3WB2hlx8svJOEzqNg0GpY28zC0NAw1EyQtEUav6/MqeWPEeCHPeIZlPAUZTwHEk3Eei2AYT4j0Z+pFL03zuxzz+l3zQWe4mlqirkfXUyoxxJcYgSXGwLQZjSEsMewp0ru/VuvLRaodGcoNNCUuVURxBnFSFU9EK+x3l92kgysjYpDlStOKOAF6090Fyv8HbOkA9tdDx7lQHQfi/PfqIO4xoHEv5txGme/LFR6zlfvYqkK2KiCdmjSqIFsFx1aQL5PRrgQtNgw41nQ7Vr22KH+mVfZEruwxtuwxWPYYQDwZ7SkMZD/Hsd/Ilwm0qxVsduj7HDaP4Fgl8q2GxuUtUOZDzEh8MzLCdFJoGjix+CqLIeLheHKrDe2C/fxvXFbcdV/7zmP9oEcuJDW4JijmQNc8rEu+PNy4s8z31FkbJb8kBT+PgkmjgqJlyzMM3b2EtGQgZu077+KnRvT78vS72JJOsKQTKLkjDbLTPlhyG1Nyh1hyT63osXHBK5uCHrtiwIIuq8tQU2JoE+h6GLoeQNdH6U2Brpi4dBOVdNoQQ1vA0HpXpHFrlcqnC5Ra0xT5tH9joYdCXZLC0RC53XYy1Wo4Nh6DrC0GpgzCsPoxrOcY9s/ghovA7mbgCA+q4/5/hBsH4p6A+AeBtm2Yzypwt9iEdywZdIml1BEE4gSQkQUcG6tQJtSt6rWofmNT/cy88oF2RadCxR1cxW2w4jZQcUeaTrD8Hr78sXJFl/FGGbc9OoFHzKO4ton1dskN9ikN9qkj7D6U/SiN9qlN9qRWe+o5h6yvnFZ0Oq976zJxAedUIDauwolxLJCxL9C0KnDUzw1RXpFEyKJg06mYfyfcQGoGQFo8ELvmrQ+yN/5dhZLbWPHxFhNu8QeW3ILTEIs7VYseGBQ9NyvuMmUIdZgERaYCAVndrAIyVQApJln1LGUcAW3Kyb8qlP11BeHCPFxj2kTtuH+AiuWQcCfi8Ae9CVsMZcrl4NqQDNpHLhVhLIiANG7eEdi38RWfY7e2gweQ0k1YxxFwJjM4TYIpqRPyjgob90AXNgA/s8HnLMwAC4NuUzA9GGQoXKBc3qNX9cqs6rFJ5T2dyjuKFbfw6K6/0nYDhgMQDsNOfMVD1ao3FluxPvvVI48ZJnDNk/mWqfVw6Wad2gCzkWA7fcPXinKzJjVYkZqtqKets67brLhlv/6tQ/6g47gWnDjKxvWlDBF1XSrbFViY5fnD9UmFBWSZDCqeRoPhZgJeEjUDS1oExa3p8S16bkJ/oEi/i6OLirYJgchxM3fkijvVih/oljzXZ3RrMYWKpVgCMkVNBiyVAaaBMAGku7KPgX2UC3y9RNCRMVBPG+DSBjgziDrAoQzWJkKHg3C7rOWrVVTK8KpsUJUNSKUiBaTC7lNhP1Uu/0m+5mP8rhboMH+wljvw3s6Nf2xcL0rdAPfEQP2BwfYtwv9VQJ0soIsFCEbtjDcVon5+oQy7T7n8jU7lE/3Ke9qVncoVd4gVd7AVd+CAAsYrv4spvy9T/lS9usd2B2HuYbW4Wt0UriGJZ0zim0irE5pJ1CenYrjOKVHtrDchN5rSOsznfW6NBppT/qCTxLQxybEAt7xJIAcdOufp2+XNMl4drbE4VSmDokCjwibpAJmUlE4VBQRNgZouT15ATFwFzC16Z0V/qkJ/gKffA+n3APpdqUD6XUxJJ76kU67knkrJYw3Ga3VmvyKyWzcWi0zYnmwTnmmBSnFwoD3OBb9ZIuzIENTTBFxkcvXMoQqQSZsx2APe8lsNNSvl9MqxBuXAdEAG5f365c91Kn5T23BFdkcbcLB+8DivX6JzsvffISX0uCf66w8MtG8RXK+A7iCBBgqmF2XiWANZEJY1SGR3KZc/V694oF6BBJosUoGEA21svRGtOt7Flj+Uq3ipv1Hgtlc+/JhGEkeHxNUj8/TJPAOKmCGFb0j+h4Zz46MaDdNOmc6HS7Q7TuveueYJRGNw40mtUrrkieZwYpzzZZzyNe3ync3XhustSdbKoGjQqOrUEWofRH00DfhPSpo6OUslMZsYVNhvy3ilxnhKYDwGGY+ACcBvYRmPCYyncoxXiswexVKhXCkOXyqDKZUFS2WBaZOTRh4mZMp3l8jfWS13bQGxJV2GRyNwaQTOTKESOGSZ2gTZw3NUtptpVysaVGCNK0DjCsBkGoQmFT1GFY/1Kn9Q3XhRZncLeJgvPIH0Rgr+W0hXJP+wsGUHcKUS8xcb+4aFHUR2uMIC04ZBV+AKZNjd8mUvFcsfKZTfly2/i6/oxMAxNa4sE0WZQuUrdBtb+egT6ikcLTJ38inQulM2QQ58HWqjbvppw4VfWebctc/tcs4XuORDLmj4jAko6yIphk58AC2LCBbF6mZFjkbrw/SWouNuVPG4m1RaE9OeDFWLQtMiz9NIWqEUWiDjyAA0SwUypYOY0gFgAiDyrhBXiiGUysgwFfBMVSxTHcPQABmawDRoSZAyIgDRdQfpuq/ytX5frnphnmJTmjyPJseFUeX/OQ6MIl+XpHg0WHWPtU6NskEFzrACNKoARIynBDKuGDSqeGtQcUe76gvlradk9zcSjvHwdVwchyOC/3fgxuDW4XhH8U17CBc2EH8qk33GlutnyUEsWeBDEEGWDIaFxbGEBFafDBtuf77GsV9i2C8BxAtJIPslruyNclW/5Q5CwCHl+FoNEleLwtUSd+9Pgqs1qht/hJbYxNdS+Vq0Ju2Ms3qLvzFe88C8oMeySCiKmvHRpE+XQk8M1KUTdOnquiWOurlhOkvhgoysRaNoUScLpQ8iDjGtxBVawfnatnRtVYY2HhkX0wImBjJ0MEjXoiGmxAQsMQWLzYCpMh/NQhpLGFRs0V9k9jxX/8dlaufnyTemyfJoslyaLOefo8pyKHJ1qfLHI1T3uelu0TKukjGtxJhVAlKZVkwEMq3oN614blT5m+7GT9R2nVQ4XC97gkvkwDgTme6BJpNkJSPCrZPhHZNt3KdwZrPKNxUaD8u0esq0hBPPFUFpTAZZX6CKYSthWPIYliwG6YeUOu2ZiGfLqVQrWe9WDzyqncDRJU1WDI1Z5iM1fLTHGVf88XWpTXpofOmvfaBX1KNHF4pCZnwoaTEmAWoxCFoMTe0SZ9314bpLknUzyDpU0UyPaRRhE5VcOiOoOhSaLmm+fly24ZwCE+NiU/kSUywcMiWmgFRDYQIWW4BwIBSJWP0DQ5kUi4ijDCo26y82fp6n8/NylQvz5JvS5GYmvuDgospxUhVOxKgd9DTcpmdVI2u/AeOwARhmP6x6hN1o6IsCu+pu2+oHlhu+Ndx6Tu2jJvmjfJlaLoHDkSQzcwjjcesIvOPEhv2Kp7doflVl+KDSpKfCVFhpBsAqTD+ICQqZOgKOjGiPBb+FqzBSqjG23GPsf8w4nmuUyjMi80XGNaAQ+kP0JqUvYbj9Jc6QUm9EaTJKg+uHXxqsvqtb1KVNF2gxIKkRNH7DpWFGdIxRCdG4RNu0yNVsTYTZwiSTNJIxhWxMJhuhRBOuDMZNuBpD6mQtUQ7GYhQTEs0kZYFp1CqTWUUGBnQdOYYWlqEJTlaFm8rUjqmQzE3yv4VUICGGRj9d43me+s/LVM9lqjTSVHhUFe5YylM2dAlFhUNSrY3VOuRjtNPIdqO8Uw3WZSPginKbBsht46DrxnfONZ02G7802HZGZV+T7FEeoZYrpf72L+HW4XnHZBr3KZ7Zov1ttcmjKsveKithlTUwM6wmga2ykt9obbzbevZxqxiuZTLfYnQfoKj3z2SIMcpoakSJRRcOdUjWw8zJTebUUxZZ1y2yb5vlvzUuFgzvjzRmlyS7QinsRQowDgWyDgW6jrluDtnhdvMTbaipViQSzHKIxRDz9xlOOXyt1RDrVLJ1Cs0qcaF5+Fp9jxJlQyZBvhSDm7lt/z8MVAqiE/vl/s5WvZyl2UrTqqdq8ygzgJuiUxulf9DDdLuedQ1RVGA5bgCcahDOKBdJG6VB3hI61/Q41jy2qfnRaPPHGntaFY7wZWu5xAmKmGk1rMYXT2PKLyK3jsg9IVd/UKl9u9b1DcZ3qizeVVkJqqwh6TFiMx3viTVkkXiNrc5Oe9ejDmE8+wRkoNkuBRkpHh7Dsk6tt5bYOcFi3KwP8wk67S1GbdcgHlCzTW20S222J59ySP/MaekNp7WvHfMH7Qsge2nhM2nnPMYtT9YtV89tnZvLinDHeYn2lBQ7UqpdKsJ2NJv3sR3HbgTJNoVqkzTfPGqVtm+xjAWzT4X5Fs98AzJfA/8/3kDMNwJmVzd98P464heL1U6lazdQdfgj22LrfTiSHidB/1ig4V5Lk41KppU4s0rQvBKwqAQsYVUIKwnWE7CqgqyqBFZV3RZV902rv9HfelZzX5PqcZ5KHVeZy1VCKaIUJMhLwZHjwKS8JbpEcYjSEGUER4VXq9pwSL19h87nGwxvV5q8rTAdrDCFRDXAUcw/yLh8hiqKYKUZodpSY5uNwyH7YI5DfINDcqNDSqOjBIchokkdw3MzJhlKlpi/AV81kgOaYZNjaosj6ZRz2jXXRX+5r3rlvn5gok54aWthUOi0fMcCZNKU0/pZTisiHTKRgLJPhaVKspsOe2nsUkh2KRSbpHlmMdnaAYVEW+aAGrObwOwCme8A5vBM4O4J9EzBRNeKJxgDyH9oFCGzq4c+8GAd4YtFKh3pmg1UbT5FhzfKdLemR68i63KS9I4HG3xka7xJxaQSZ1IBSu1aN30/pO/dpOKBcTXSqtLb36R9nK81tBGfxpDhgxfVhqhOajjZ8IXDWUnsvMfR5B/Xat6ndX6z1vcVmo/K1HvZ6kLRngaT9UhofkhXhuRuCWUa+HId5RpDiz1mfscsY3hWyfXWEpMxxk1qahwzS0oaJHwmmkyFZEtqsiG326ZfsV/8m+Oa5055/U75kNS1LZMcgG5ZhLMsUrQqNLPJ9bFbHm2XkWRHTrGbZuxMkW0K2SY5wyJ+mUFIvooDg6BeChJG6nugBMwMGb/r5qiTm/qZuOcFCj8v1TyXodtM1edT9KUVNFOJIIn0ZH1uikFdtPHhWRY7DWw2yllXY4YKmlEs3w+yrBqwrHppWf2n2aarRrvbdQ83aNXCcTThnpYa0zTJDpYavFqNhkNq7duVrlUSb7Bxr1mYQeTQpQ8YIJ4GkIVFNqusUrbYoTPnsGEMxySFZ0oaauOMm4VrQZps0y2pb42dBow0nRrMqCfNMi5ZLPnFcu0zq8I+q6Ee9XHxMtbwcJVVEd66SNWmwNpunb/dkjib9GQbcqoN6f2Vt8mNudw6FW43kaxSyZap6WaJSwzDcjWcGfKapTIyyISl4RlHk0xSIk5qWhOcROugCYNMubdFardyDD+bZ9ZOtWgkW9STYOYos3qyGR9hOsRkAsMJzPgkmDk/xYIXa3UiwG6/pdM2FZeNeJca0HmooTQRJwkSr8Mtpl6nmsf2G3+03HrRYF+L5jHkfGHV95U4M6FOlX9MuWmv/LmN+O/LhI9Z/b2sPiGrF/gX9WFY/QS2QK0Kb71D2f+wVlydXioys0J/gpkVRtM3eoqFaHJFgyG11SjzY7MlP1qufWJV0DscRGNCRrKON7zweXj5iUeumsc6W9dVc+0Xx1lmpJhRSaZkMsyMTEJI61uYiGRHhBkJzoEsysoEZUymGpIy9ROXa4fkq9oxFFRL5fAfOE3iH4FK5QaZSm+LtG7nmHw+z/o0xbY51a4x1a5BOtuJjU6ZYteQZMePta/1c9xv5bRN1Xkj3hmNoOHuBdcJiHrwRr8odN3Y77LxudPGX623fmK896TO0XpN9ITuMTU3FQnKU6AymmRNT1zH49Vp1B9Rb92tcmmD/C9l+OfIfh3/bjEEskA8G6NShbfcLud3UDm2Vi2Vo04Zs/bq/eNKUo0ZBRZlhWrQTmvVn3fJfMnPDqufuK7vc88VSu4MMBwyc1eNloMY2skcH5ijHJBj7p3j67AsxiQrRS8dHXIaGnXSHb1gWXLZsr7EkmRJuqNWKA9PmaBqUtI0SfM14lep+xWpmjKVFSbc1kbxH5h8SxxliKk6yNB8W2hwO9v8epb1aaptC8lWInbsxVLsG6dInN6uIdmuPs6uLtDugK3dVnXbDQSbaoxNNWCLGj2EJDHYhHIY/Vf7asi+ut9+wwv7mt9tt16x2tdmfrzRhMs34vENeTwDHk+fx9NF6fB42igt3oTVOYlKGpwMoY1eqIPmoIfmZgDnzOcb83km9RzTxiOmHbuMPqvWuVGm/gbZ9k0ZYisD76ciQXnKlDBsJdlyBb3Nch77ZKOOy6bWyVGQhcbyVK6I5BZtitM3boc3nmJao2pmh+7Cz6xX/O2x6pXfqoG5qyBRUCAkIiV05UTA0JXYkJWyQdm6c3JcnFeGmS5O0s4kq6VRValSvHcin+oEVBA0FUqGSupi1eh16p4lGroMDSJDA8PQAIYx1WeSZM5DIIamgK7bU2T6eLXdzwudLqc5dpAcmlMd4Ju/cThkJiyAJiIOtIYkB36kw3Fvx73G9psUratxllWgBdopJ8ny/SDLykHLqjfW1bfsNn/huPec07FWR16TQ0OjfUODXUODbUODdUO9VX29ZX29BXpQrBmfb4oyGWKMMhnNlF9vhp4ta4FeC+dgXd9gg2Zo1yA6obLBsZnj2HbI/tI2yx+qDB6VafeWaQin3WkwjW4EkK2GL1NR26Bgt4sYfASf9P5tMT4UF0vj4dPqiRmtKvM/Nlz2o1POI99VPUHZgpCVkNToCFsxInQMJHDwwdlwiWMxK8fPelmcwfxUzTSKOm3sJFjVKZM6IVaDkqZBztJMzNYKKNS2oGspMbRwUkZgZ9zIbD2IoTVI13tXYH4/x/mnBbOu0bzOpc5qS/ZsSfJoTnJvTnJrTnZrSnZtSnZBOYulODcOG35RnMYVkeTWlOTeFO/ZGOHF9Z59yNx7l6r7ZoJLDQZuvzgOFyWj5y3YSoO+JbRDCprnjht/d91xzf3QaQ9Oq0djs3tTs3tzs1tTE8xVfABNo3Njo1NjoyN6HquD+FTWBjiyJIhPa3VAkzmi6Z0axYfXuKLc0Jzdm5vcmxvdW7luHYecPtlm/WOV8aNy3Z4ybUGZlrTtZWYGpkyLWKGuu1nRfR8B3UJNQOEMUjkDNES/hL4J9KKkvjV0LXeAxh1M40PpzYSsM2pLvrDIue25+k1AzqA4WCRiYThGRh2JlCMmOudibg44dxU2YJXcnNX6Xqs9nFdEWs5PNkkjGVHIhuO2hZGsekk1bs8Z8dQFdMZCmknyApOoNUbuxfq6DG0iQxMz2ezTGQsTFFK+DNJ13haYdGY7fDt/1lXqnIvJ/mcS/Nvj/dri/U7GzzkZ73sywbc1wWfI7ImJEvi2wpfAF8b5nYwOaAkNbPAKqbUIO6ge9pFMyG5M0C4gcCcwdwcQsAPw347wQ83ZNiG/bUK/7b3+25/47/rZf/8V3xOnvOtPzmpq8WxuHuYxxH2IG6JJFEpuI1EwTJRgJP1wDpLZeiLHOXGRA1I/3e742wbrZ5UWfZVmwlFTd8QTeKZM8io0n5EBIwuw0gJXZa64wch0u7rvAULMscGU2m4y5y2V+5rKfYV6iXox5Pn7iJK9HALn8JrGf5vW2DuvA7vkqsaqP2zWPZ+1ts9vtRCud4lu/uFYGI4Ob9HOfMPWA7NQngjQMxfjkSvruV7Hc62r+/Iwl3kJjuQU+6EB0+HesDEzE8YTTzYgwYnF/W/oWE+KQ0qKY0qqUzLVKW6BY/AaG4ciE026HpGhjUGmnk5+w2tPwftDBi5T4GrYuwLjO9k2X853vUT1OpviezrRrz3evy1OJGA0f2kCpIgNOBk1tzU4uNEzgmMWcxSI2S/yOPrgz+FHPw2oOz0bvtsbWzyaRm7R8dynZtIcmtxb6j3aaj0v7Pf6eof3nS1ebzfPGtzkCW3yADa5I0QnDyJcp2YovehyJB9PYDNsFrDZC9jiBW7xImx2V91sa7ldy2cfJurou6Ta5yTuEzLvEQXxEPVAwv2JSSYTXfiIwn9MbXiWfvLtgktg9k8aeY8sC3qc8wXuuZBnLnLriu5h+GYevrHhm9y+cCyJmQOgXSHOvkDBOc/Qc4377MWhPtTY2ckJkrvzoRv0JbkN7dEn4iJh+EU3dCdA99E7AXonJs5OSPSJJ/lEzfP2z3GzK7DRKjaRpRtg6frgVDdt+ACiHSEMILqhsNi0J9/64Urnb+e5f0z2OpUyuz3Jpy0BKQXQgmAI8pB/H4nErXG+LdF+TUGBfI/QEyZRh5SjDxCi4e98Hxj5ESASBdsnFj2xqH3CqH29Ufuehu/7NejgVZ9jp905rc78JqeGpuFqj+Sxfa7TNPr4v+HaV4NjE9+ptdb17EGv63vm3Ng599XOwIGdgdDOQAC2Y+5oAVMgkX7nXECUzyhzMTv8CVu9VTbbmWzR8NwDhB15m4AEyFMKivrBeCj+M1rTy3lnupd9hV9/V6v4nWnxoFURZINu7zx2ptkQo5IhyMROyXmeoCEdZ1wiZ16saZ9nMyvbd868cP/UGP+EOP94WLwfag7KNz7BNyHBZ2K+CXAacWI/sTj/OFi8f1yifwzJPyxrzuzsWda5TpqFtrJF1tgiK1A0t3n0rOYh5u8jZcWBxERra6jQVljgOLje892Kufczw39IiroSG3E+JvxMTOip2OCO2MB20TNfepVJ0nDgwMn8TiLP/8C2qOCTIaHNsyP4dpHH9EL3KQfsJM7einffhHWpAccMkUjtEB6abAa51PS7bHzluumW67avnPZcsDt80qauyYrXYFWPgNvO1g1I81nEdjQ7acakGb7WeqhFb9XAs26qtW2DWxO7PX/e4ftkh3/vjgCh+K4OnAFjYmq7P7DND9zqg9vsIV9jq7tJ12m3XMgRMKlWSOYIqBwB7Z/gCmg8QXozNP8ibuXPCgXPNOh9unShvvRZzSg0FoilUoHEUqxsKVGeqaFGtzDM97JbGeI2L2YWKcErKcE7UbzL6+jb/j2GU4qu9U4QbQ+b5JmY6hGX7h6xxHX2GmfLPEf1AgeZAgfMBx7kMRWOUJ7L4DqvnpWBLyKiz0ZGnYmMPBMVcXqUyNPI69FnImLOWkQeMfTZqWVXo6xXIavCxsmzQVkWQESPRpwUJMsSyLG6ldiPNCt+Ndx0zXzPGasjrVZ1jVb8Bku0U0jUpzSG+RSMv2ooQ75VI8em9bD9hd0u3211v7/Zs2uzp2DzLGio3gJs8ZYw+328R/NCMkGymoXUheAakah+tdEVrHHGbrCX32BhsE3f84Ba1HGlVI4ChTP+vAz5iUk7XIOnkNYsn/Wx/Mpf5AqeExn9xFJogjt2xEvmKK/EwFdM/Gum0jumcX+JBz43RGVFnM78FAO0XWyCDNiJR/0sxlbpRdAxcYl5xZYjw3/iIT90UQDFkEw1IGXoJy/Si4Sb34WGJsXGSiUmuJGVZZOvF5N4hk/47nAOSIZQsZmgyLI33+HlqtmdWeG/eMTwXeccsLfZaqJZpYEvkx1kYXtZYA8LGNYtBdSDHPPUO8B6iin7Q7n6uuGOC9aH2u3rWhz5o/pCbcWPUPT5OXLXjb2TLUfdk+LOT2uJRzecm31jg0NjvVNLncvpA66fbXf5c6PTiw32faOOcLJHbBjm8D5DKUUXjuRjixiZ+msFVlniq8xVNhpZ79YOPKqSWKuInhQjh5rKJqWSaeSQnUiRzUjl0hrlMs/KLP8OzHvcz+jtYgrfMKHXI3egmOTNeatklNti4O0Swu0S1c5iq/v5c56tin67OLl3HmUgnTpIowkkCEeDJIx5S/Kq4fNJkcNJKVnClBWY8DwZV7qCDlOFyFTFMNWAEe/p5Jdu1OiAOCuIqSZkaPSW6D5db/77UufrNJ+PE4PORkcgz9jgmI7g0KbAOXVzXA+4WG83MdqgrF2OVy8Dh7eRUR6iNAT9K6TMHlBlv9Isv2G44UubXR+7HD3tyWvzamz1am6ZhXaDuKMdKWiVePLeSNHP4t7Ioa7IkX5IUSekB5xtS7N3a+Psjjqfj/d7f7PN/XaNw+sq6/4qS2GlJVBpMdMsxaoswSorbLW1Qo2V4Q6zWQf1oo5rpNQpk+FnLHLTwvekDI1DoHHwQ+ehjOmTF72IR9PIiO9hrjyNq0irV8roUFh8Hb/2dl/J2xeMgUcM4T061DlyNyIk79IbxVKBN4rxN4pV/y6y/Dt3zo0VMbfnJ99NJ92jku9TKOM9mNT9CTygUB+S056Qsl4mruxH1tHTVTUZWjIMLYyUTkKNDzKq9xLtPNHpLtK7v87wu6UmFzPMT1Ksmki2jSkOSE97kntzolcLXDeG689wRTompCM67BRcf4ArD/BdLapdwH+FX4TfQmracB0brkh7NSd4NsZ51Ed58kJm180OOG4belg78oBc1D4s3JaM+AgI3wuE7UGE7kaEoNCfobA9gvC9XREf3Y86+H1k7acRjefD286EtZ8K6egIbm8PbG8LaDvpd/LknJOtvq2tPq2ts1tbvFtavFrg+7bFs2V0D2Ez/Ary+iw0gXdLqzd6iW8rfDmcSZt/W9vctvag9vaQU22hZ5rDL3HCvjgQ9AdcVd7s0V3jMljjBG1wHPv4rZY0+kk+bOzz3BFR44RyBmpcRD0w4CYP3BYvhZ2++gfmuBybFchxieHZJvEtU/lmJL4xmWdARpYBogtypWxvK5o7oY0uttVHZyKZkOvNkQ3HmmzJHTaZVyyW/6qZ/wjLePuW2feIMdhZAsH39k1p9/ZdulRgJx3XWaJ0p9j8Vr7Prexo+IbvTCPdHbrh4dv4IeoR6vHERAlEiYfv/3swMvU+Oe0Rad6rpGVA5Fptz1x7g1wPufWzsOtnges9gVwP0YGSiHwXlPMQpwk4S3ARXwtnkusO5HoC62dB670E62Z1rXW7l2339SLjs5k6zTRNPlWDR9XkUbTQFUaiaagGPLIhn2w8NKcOmUpXP4pZvXgaHpzGkA+np+jzyHpckh4n2ag21vJ4iCv8lR47G332TNSZ0xGnT4WfOhV6qiO0owO5kxHIjReICmoX/xzULnoLTgMnPhV2Cr4KvhbOAc7nYPSTPaFdO+YObveDts0BtvkitsJ8pgO9BLl2DsoP2O6HNNy2i/s9wJ2B+D0higci9U7E2PBjPJujAk5GhLaHRXaERrcHx7QHxbbNjWvzjzs5J77VN6HVJ6F1tgQfBPzWSb/4toA4OCWcHjnBPDTmTHjM+bCEK0GUr70X/269rlO1+JmA0QU/jR/Q4aexlNvvIQNFH40BPmTgHtIVH9LNHhf6Plsd+2pR6tsMSlcatZtGg/XQaL2oPgn9EiRfF6XsQSGXU2ld1LRuSkYfeT4maal6eLaj2/Ig/SUxwFjRKNHPwTcWuV/LtGynGTZQ9dAVBNrIjUTV5FI1JKhPaigZRZNL1uKk6NbGmR4LcjrsEnDoo4j+PWHCPeiZvGIh0xQ6ivhI3zAYuDcc/1GE0qEo/U+iEq8F077wWvyd5erflQsfDtDfvWAMPmZAY78FBvBEOvAJA/+MofKSYdVVNFeQk4BbSJZJpxJpMJqI7HQQJVHT5KgZiqT52vFLbOcuCbBNDr6Y4N+ROLsVLpvgEgoZAnZuSnFEyizx1D6bIdYom5GpfXAaOCVStLmh48U+/NnBtfuiBB9FQh9FAmIRI/ZOQDLNyIVD9kXBwH3R2P3RcgejtI9EWtWGe9SH+beEhbRHwMVn5JnoiLNRkWcjYs6HJl4MIH88K/MT28Wf66z6lVD4pIfR85IheMqAxvySXzHHA18zMW+YxC6m9iDDmZgfprYsSTuTpEuj6FJHtkcQbR6iSZ3EqE0SdMQDo1R9Ms04JdMmZqGXz8IIM7jEj4w+M6o/IRw11KsAv45UDKLPHg13qAvyrQ8Ia/GPPukfhz4KYtsDY9uDYtCnQfSpsOjT4VGnI6JOi7KLRPojkL9GRJ0KR96Fk3XATxv4EvgZ4p/Q4Zt8ahapw4V2yibznNHi/6muvYEtftXHHHg7rgEiLB0LQhYu4DGlykSmmUbRbNOcSLt5iQ6UZAd0oZOtxBDYmGW5Y1bdisa/hga/RCNfKc7JqW4JFO+IjCCvE5FOvKCARr/IptlxzV4JzZ6Jw1pmJbZ4JbZ4J7Z6SzwqJZ6c8FtIAjiZp+go+eQW15QWJ1KLHaXFitZuNu8Tg+U/quc9lKV3Y0oFUCkk+Q/UZIyixQC1GVhdhpxhiY5lgaNLztzZmZF+KbF+CeIOXp+hA4zQwRExT2SUBP5T/Ff0YCPxmUc+aJevqJs3IC4+MCYxJIwS6Y2J3g9GI8NhV2Jaz0efOht9hhPjDP8G+N6RPNc4nn0izzoZ3TY8VbyOwJrUMH6T1ZG9UlNHlhsgKwvI9aaUBmNqoxGt1SjzvPHir4xW39YvfKNDH9BiQJL/3tGLC0DrIoxNkYx9gapbrpnPyllBmcGhyRFhsVFh0dGw0OiY0JiYEFSwWGxQrMjwK+IEITFweoTo2vCo6IjI2IiwlCi/zCi7JZEay8NllodjlocDyyOAZZGIpVGo6NFlxHtFI5cg0MuRrCIAONsVsDAYtDx8YEn0O5Wo/eJh+qCdAPLnLiB4LGHI7v7Q3S/DP7oRefiLCO7FsBak8hzWAdclToefhusSpyOR6sSZ6DNnY84i0PrJmUikigInOBV+uiP8dHvEudboy0fDHI/M9j1sF3rEOOaYdlKtOomjSuGqUsXU3kdVggqNp0JrUM1oVZ9/Xmcp/FXeMs9/bVk4YFUESX59ZsWAuRhoUYyxLCLYFCo55xl4r3IKWjgnnBQaGRcRGR0ZGRUlEjFlQ5dEov+D/y86KjwhKogW6bEk1DgnQGnNHPwaX3CNL7BmDsoPsVqS//tIJEYunzPEF1jrA4PW+A6uCni3NOyBYdQhpaBdeP/toMQ8iiHIjAvIf/tgwI53wbsfhO//OerEtciG8+EnT0tUHYdriSJIXVEkbJxQiWpnyOgcQjraQ0+fDDvfFHV1X5j2Hl/LXQ5ue4wDDmhGHVVOqlUY6jKaynE2wz1F8uLZpA3KGW1qCy5pr/jOcO1ds4K3FkUDFsWQ6Ms1Q2kiG/uAOgyMPh1rXEKwKFayK9D3WGsXsMQ7nBoUFQ8HXEQU+lVJmuR/4xNHR0ZER6TH2C8N18kOlF3tj13jB4q/EfGXMtrsiY1P7AuI7xbk3oBWBQizg3qXhT3NjPnDLuaEdthHsoE7sfBXLDmRRuLL7Qre/STqAByAotATfVNjviBxu2C0UV99aIdkG+FMzLn9McL90QAiZgLRYvtEosCPIrF7w4l7glV2+xvs8bI/4Op73DGCa5vIt0rhm6NLxtAtNUb2rpHcoGZ4UxpjdA9etPnZaEtqcSSfckm77Lbge5eVd+zXv7Qo6jMsEejSIW3xoxtUZeLUGTJ6dFmLInmXPJU5q3XDl0TERIhFj4O+Plz3lnxaLo0eRfTUxYsGryP2IsIRUPjewYi93VH74Sce8tCLPoP8xkSixc/D/THQ2N/PGFFDxr01fOHwrxqpJMH1mdDoDrTd1D43FqkI+UsQNZECY+EEcDI48ZmoyC9jyL8ELrrrsealVWGPYQlc2AnUmJAKE2dcIm9RpOGSqz93xQ9h8275ZD9zyX1nXdhnWiw0LpGZs0ZrbrZV+ILPo1J/Csu6E7TsWUBO15zVAt81LTH+bRFhHeGRp5DqFlzzjDwbE3EmOvxsVNQnUQlfR1FvxGTBv2G4gIsNiokPiE30i0nxjySFzK2NdOUFBDXMjm72iocrJ63eiSd9EtvmJHQEJJwKijsVEos0CUPgVmE00soLijsTEnc+Ii40PCEmKDYeDuCQyJjQ6Mjg+MiApBiflHiv5ETPZPEcjJHJFYlJ3vHJAZHJkf4toaGtATFw47HNJ6nDJ+WsX+rFoNRPIhPrYn85nnDncPyz0/GXzlGvn8/87nTmL61pf/HId48lPTuc0H0wfvBgPHQwHphJceDBOHx9gsuFxItX0q9em//FtYVfX57/9bmMb05Sf+ZTOusor2sp/bUUqJYCzCiwlow5nko8mqDVGut3IenCp+lXry/43/8WffH5gv9dTr92jnztZOrX9eQbXOpLDrWfQxVyqEDdDAPrKLhaktKJBNMLifAH+PT6wutfIB/gOvzzxZRLpxM+aUn8gpf6dx35xQly/wmS8DgJOJ46s8DjqdjjqXInknTPJ5xHPsMC5DPAf36a9unF5ItnYs81xl7nJP51LOn54YTeg3GCA7HQgVhgpmEOxBDOxZ+7knZlzAfgJf52PPHh4fg3B2L7z8Wdu0Ibm6Aj5fM26g9N1L951Md1lHcnSP3HU4XHUqBjKcDMAY+mYI8mE48mqp2LlfIZLqZ+cin984uZX5/L+uXUgs6TC543zXvHT+/j0AbrqNBM3jBULIcqx6NqN1EtW0mu8Ie5TLv8+fzPJT/MJdKlTzOuXs387NOsL68s+unS0hvnFt87Of9JQ8ZrXlovusM4NEMn/oIcGo5LVeBT9FvIDmepsy7SfEXf0aiPlIR8pKsZV69lXruW9fnni766vuzHa8t+v7j4z1PzbzXPe9yQAf+uBnhpQi7ywSApgUaZ2AS/pTqKPIek35Dk3JHod5EccCXN/1xcOHKDjfnuki7C5dElsvjjfZb1GfwE+GrZt18t/+HzJd9fXvjDhYW/nV10t2PRy9YFPU1Z/fyMAS5tsJYiQIIxFTqWOuVbKBUhEXfww0f2WJL2x6lBV9ICzieEwdE39uZPugh/v59QPpH4bP/7etk33yz/9qul31xf9NXni7/5fPkv13NuX8t59MnK52eXvmpb+KZx3jteWg/8zDxOEkwnCuDnAHiCDMIPRvQXiKmlEI6nqF1MDkE+Xjz88cLEz6gxnzBu1CeE3/pm2TffLv/266Vff7H4iy8Wf/nNiu9/XP37z+tu/bi+85u1966vundl5YOLyx+fXfq8fdGblgW9TVmDjfOgxnnAe2SBTVnY1gWE9sUyZ5YRzq/AXVyJvbASf2apYmuGiehzXkgKRT5n0oXxzzH4c16mXL6aKf1zfrn4y+9WfPfLml//zP37r7ybf+Te/HX9jZ/W3fxh7e1v13Z+ueb+Z6ueXM55/XF278VswcWV0MVsYGLgx9nYS9kyl3MUPlut/NU65R/zFf6Pt68AayPd/k6Cu7u7u7u7OwECgUBCIMRdJoRiVequtNS7FdpSaAvduuvWvVvZtls3PN87QGV3u3b/937znIcnJDPnnN/xdzKZucZVvMmTv8FTusjSO4h3BXoCbffnxkxoi5mo/F+1Hff7t9oSf6/tFeqVm8ybt1m3bzFvAbVvMG5dZ96+xrxzmQHUvnuW9vAM48UZ5sczzOEzTOkZJuIMC3H2twTegd9nIs8wZc8wlc4wNM8y9C8yDa9z9B/wtZ6JVF5Cii9Eqg94RqeJXhM658V8jYTf6gzy6PeR8Jc6gxdjBF7cukq/eZF64zz19kXGoyucV9d5/Td5Izf50pt8xK3vEXj/Jg95gydznadwhaN+iaV/kWF6hWlxh2P6i0DvjUjtA6T0FlJ7zDM+R/Tblx07rjmoAN/tcX0Ff6J25V+rffMK7dp58uUzddfOUu/9xHp+g/fhNn/orkD65dvO+wLkAwFy/ET7A/j9ia+G7vBRt/iy13lKl9laFxkmF2k2V+l2dzkWzwT67yC1T5Dye0j9Cc/iEj50PLDB3+82xy919Y+aA5ufrTn7VXPWV81vMG5eoV49W3vxBPHiCdKNs/QnlznvrvOGbvFHx7+nusNH3hWg7gtQPwtRD4WIh8LRB4KRO/yRm7zRazzpNS7yGlfmKlf+MkftItPgPNXmAsXpCs3xLtvys/4qH0Q6z9jON3DxJzJyJnIzK+677fv3EKp/D+Ey9fIfINy8wbgBsvVMzbljVaePEC6dpNy/wHp1lTtwgzd6kweHzVjkoG7zZe/y5R4I5B4KUY+EIw8EA7f4n65wB86zh0H8n2fJXmIrXOaoXGLpXqBZniM7X6hzu0Jzusu2goGINPohrY98q1fU4PuViaeLknvSksaxwK0k7W+wgFr9uwrzl1gug6p+DHfiaOXpU3XXf2I9u8n7CAx+72ssIe/BHgFYFB8KFR8LZZ+Khn8Rvn8oeHWL9/oS+9M5GA6M5QZX7QZX+yrL9CLV4TzJ/WKdx1Wa8z2O1XOB4XuR/oDAsp/p/ZYcfp8UcrwieFdqHKhCMKI/GST+As5v8uJ3cCgAzpljuOMA0TnSpRvshw8Fb5+Khn4Vjf4qQnxDqOciuWcixaci5ecihVeQ9B30/r3o2Wvhk6fClw8Ew/cEyj8LtJ4INAE94OnfZFlfprheInn+RPa4Tnd6wLF+wTf/yLMdYnkN0gPesN1us2wP4XxAph+EfQQcdODP5pDPzfT0v0J0HHcc0AXSxbuc+8+Fr95BAx/Fo5/E0n4x4tMYfRQj3kPId5DMW0jhNaT8GlJ6B8kOiAeQ0At54SM50S8I8cdBsdInkfYHkRbIlBcijUc84ztM+xtUj2sUz2tU99t05ydsx7ccl0Gm7wjDf5Bn/0qkfZNtfBgb3Js/NipMJNHR380w3xaxfw2tegxa5fGLdRfvce69FL36BPUPiUdGxNIRMQLQsFg6CCMdfQ/7CPUekn8PKb6HlD9AioNipIz4o7rouZ7gFz3hGw0IpTD2Y/hBscI7SOFXofYTrvUjpusDuvsdGiCPx3SvNwzfQVrQKCNglG8zIFZ6BSkCC5wpjT2Qlt6TntBbAMPcm77nYPGB4zDM48fGF0TfG4f+XUxWnxnvWQDmfc79l6KX/VD/yNhpfin89YV0VCwdFo98Eg++gQZ/FY08E6FeiBTewtUYIFXuFyuMihFK0Cdd4StjwRsj4ZAWJKsA31MGdj1oOq/4lq/YLi/Yrk9Zrk/oXs+pge8ooUOU8FF6kJRvPSqWGxRL3wr1H1L9LpfHH8lL2pueCCYrGC866lhJ72nc4dNVx05UHDlU8uP4xPIXkxUMtva7jenvwSImwI4Oi4eBo1+J3j0Wvr3LH7jDl30gUHsm1ARY3kMqHyHlAfg2OkhlaFBX9NFA1K8jGlaBhmTEgM9AP6T8CRQTjssnjvN7rtMbpvc7Slh/XdRIXbSUFozg20jFsqPi4SFIA3z6lBJ0hRB2qDhqTwboAvF9+TFHstMulOy6UnXgCuHgedzB45i+A3k9Pam7x+a0vr+e0/4K9ViSfkH9SvTqW9TjwMdQf3olev2I/+wm99llzvufOPLXOLr3eEbPBLpvRBofJrArSsUyiuJRdWhQE+pXgz4oQW/koA8yYgX4eb0cl1Gu0xDPYRAUH3L4SG2slBQDn6nk24w922kIfmAh3/oD2+0J0+0CyWN/UQhoH0dyUh5VdT2q3n+nau9PZd2nCncfztyxN233gcLefz84fWkcX5P37yC/esx7fJt97wrz50vsNxfZCj8xja4xre5xzEG/GwOuCoD3Q0ojYnlZEOriQVXovRr8bJ73apC8ssBUjuuI5DlIefajLK9RcoS0Ng5RG/staoRYRSqwGObZvxNYPOAZnqyz686NOJSW+S575XtC12vCnicVnXdKtl7J33I+Y8OhvD2HMT8C1Ee/oK75F6hBeAPg3w3vL6j7oU9vRK9/4T+6y74Nxp7rrPs3uG9u8OSvso2u0G2vM+zvjw1dn7GrgNFrSCyPhJ/1BTz+Tkv0AeS4mtBQgW+DGr9qluWJIEcgvgccfgYz32ZQpP8GUrjDVz2G9xrOax8m7O6v6nxbtvnXog1P8tc+SF91IWPDyaI9R0t/PIo9/BvUE9Pm2X+C+kLdhbFC/R3U4N9+cf9b0Ztngic/c27fZV67y7rxgPvwifDdE6HMA74uaKPXaI43GA4POJbPBfpvx7CPx/wgfJ8shKJ4QAPq14RQaiJtBYE5fGt+AJP9Z8CVx54/bTUKaQ+KR15Dg3c55j8VZEkLVkvxu0Zw2wYxG/qL1n7Ma7+TsfoCuvNkWd+pyqNniafPwahPnYRRj0+qvx+Nbn2LumIMNemvUA/AqN/+Knj2hHf/EfvGY/bVp9zbL4VP30EfQVN+JVJ9zDe+w7K7QXe+zXR4yLV4IdR7J1IHwL9gR8K/VxhRhVCqkIai0FhWYA5fbP13wKWQ1qh4YBB6+06k9bQiDVGwGoHfKa3YOlqyAf41Ru6qG4VbLlXsv0Q8dqn29HniqTP446fxx8/XnPku5JuMG+D9syCpYcjH/g7ywDvo3Qvhr0/5j5/x7r3g3nzDvfFe8KBf9HJI3A+69oBY/p1I8ynf7AHL4R7T+We2/VOe2Wuh7gdI/ROMehw4KPKy8mJ5JUhdQWQgKzRBCazg67r+EjUC0pSK+0eh18OACTH+dTpuHDiiYiuiZL0U3SHNWfmkYN29qp7btUeu1x6/TDz6U/XRK7Unb1Av3mZev8O6dfsr6lsA+FXaZWCTk5XHTuCOXSSd/zPUo+KRQfHAe+jdS+GL54KnvwqevBE8/Mi/O8i/PSJ8KIVeI8SDSHh/1LBY6YNI7yXP6hnb6Snb6VeezRuB8UeR9gCkOgCa1xgNQspSsYospCkn0pMRGcGF/R8Ah2+ECr2SipVGSDED2eWIgjVfgCPQHYicle/y17zAd/1Se+Dn2kP3aw89IB35mXr6IePSA9Z1kIy3xhwNUN8GEU6/ernu7HnCsXNVRy6Tzj7g3HktegEiGcBEiKXIsdtNjsEBw9jAAPTunejFa+Gzt8JnH0XPh0VPkcKfZQX35ISP5aE3CuJBBbFUQYyUE8ujII0RoRmYHvu5Tv08u0GB+bBIfxRSGxErDYkV++EirzYIaY7CF6rCj65BAmhs938IHClWQpGikTnYPwIfym//VLXzbc2+l6QDr8iHXlOPvqaf+pV5/jHzp3vMq3eY12+zbsKuZ14HYXCt9sR14pG75BNP2dc+iJ6Nij+ixMNyYqmcGPGZRmXFQyjxByn0agTsIHouA70EXVhd9FJL8Fib/0BX8FhX9EZPNKQHf9+F1BXJ6ojUtATGGjxbNa6DCs9WSWCuKNKXh9Rk4afKgVFNYRhSHYJvw6Q/KjKSiowQ/ww4UtyPgl7LQ6oqNXHq2d8BPgpKfeWOAWJPf13fAOXQAO1oP/34O4CdceYR4+ID1rUH7Jv3WTfvMq7epZ1/QDn5jHriPfuiVPBAAXoLZipVaFQNQnwmqRr87yDcdkWvtIQv9IWvTQUfrPgfbXlv7ThPHdgPndi/uHDeunCG4Nt7c5AuHPgnuc5sQwemtQ3L1oJjacw30hVqaULKapCcKiSjLAaTqpIMpAH/Vnz8ceZwqP8NcCSkJQOCCnqvJdQxxSVbZJT+ETgir11auX2U2D1S1zdKPTxKOzJCOzpAPfKOduwl4+yv7CvPONefsK89Zl15xrz0hnV+iH1Rnn9LQ/hMR/RRVzSsK5LqiBA60DhJdaBRXdGQvuijsfCdJf+9Pe+TM3fQjTPowXrvxfjVl/YkkPo8hPo+lDocSpWGUZFhFJkwinIIRdePauZBN3dkG1nytY2FKnoieR0IpQ0htSCUBmwBVUWRjiz8a/m/D3VQ81GQjoJ4VBsasWdaexeke6ShvwM8vx1RuV1K7JbWHUBQDyOoR6QAPuXQMPXwIPP0AOenT9yrHzhXPnKvDnCvSrnXFABqwUNd4Us90UdtaEgTGtWApOoQYozACzBnDmtAg9qifgPRoIlw2FwwYiEYtuJ/suO+cmY/92S+8mV+9GeMBDAQgXRkEE02iKbkT9f0YOrbcfRNBFo6IhV1SB74GvQvNQipCiFVwPgKKcpDGjLwPZv0kUKzPwcOTy8ovo28yEATUrLjaoZV+EWlpfnnZP4ZcASxG0k+gKQeRtKOoKiHUZSDMtTDsszT8pxLCtwritwrStxryrwbKrxb6vz7msJftESvwEClIP6EArOxeHR0YmkJhrTRIfHwgHiwH6bhfvHoALzYHBkSD0ih93LQGzCCakKDIDb0RShjoay5QN5CoGgqUNERqcpDKqCafYDkwCr7PSTbL5YZFKMGxYh+MfKTWKEfUh8S6YyI9KV/CRwpsJTjOajzLS25JkFE58TsqJjMRM/S+G/b2ZdQR1ZuRxG7ZcgHZKmH5WhHFahHlKiHValH1ZlnNTlXdDjX9TnXDNnXDTg39Lm3dHn3tQVP1IXPFUUvENCbAXgOGXoDjb6CpK+g0ZfQ8HPRwBPhpweCT7f5gzd5I9d50uu80Ru84Vv8gbv8Tz8LBh4LR56KUK8gBdCmR4GqYsURsew7CPlEJL0rkN6ET3DJ3xcoPhEqPBfJPBdJfxFJHwsVngm13wqNBoXGYBRHsj2Q5AjkH4AjIVVZvo0K292Y4e5d4xVXGJqQFRNcFmZfE/pH4Ki8dpnKHXI1PYrkH1WoR9VoxzRox3Soxwyoxw0Z5wzZ14w5t83YtyxZNyxZ181ZN0w5dwx4D7QFj9RAYxI9BdV7APoAsL+FRt5A8Ij4SvThufDNY8Gbu/wPN3iDV7kjV7ijV+C/4PXAVe7QdR7yNl/xkUDjpVDnvUjzA6TwChp5Ivx4l//xBm/oJk/mDl/5oUD9mVD1BXw97MgvouFHQsVf+EZveNZDfGswr8qxPOXIEbK1sajP6zKkWBbuL5CGCtfJkBLsUhURgY6Oy40OLw11I3na1AWi8lcjfwtcIa9dqbJTrWafFuWwHu2EEfWkCfWUOeWUNeW0LfWcNfOqOfuOBeeuNeuWLfO6LeO6DfOmBfuOMfe+Pu+BDv+huvAXJeiVrPgTUjwMOjhSPIiC3qOglwjR8yHoxXvoPTDFS2jkBTT8En4x8AoafgvJfgK9W2QoIzSSgQdLmY/Qx9ei1y9Eb1/Bl2GCqNaEoxr0brH8iHgQjAofIYVPYM3FdUZxHZW4jupMbzVyuBIpWrYuCkkLBqYAjU9eLFUX6hlT/ZyxiSE5qdHZ8WGYMA+Shz3dyZkQrpC7ClW1E/kNcK281XqVu4xq+szIxy2pZ2woZ+3JZx3J55zrzrnUnXem/GTHvGHJvmvJuWfDumXPuA7IlnnTin3bnHPPlPvAmPfIUPBcX/hOVzSoKxrREw0biD6ZCF6b8Z+Z8Z4aC17qw8V/6PNHw8ZCqblA0YqnY801tuQZgAIOKqSK6JWy6AVYd4PWYCBUMRJoGwp09YUaenCX79eGl2ZyGnwLdbabJttNn+VmTPMxIAerU0LlKeEoehCoZqDlaUEKViwb77LY8LTM8KIoz1pPB4aDM8XNrzhBJ2O5Im47qvyHCdS5q6xz19lV7LGvPuRAOulIPu9EueBCvuBWd96t7oL7GLlQLtsxbwLgVuy7tsxbDozrDvTrdowbNqzblpz7ltxHlrznVvx3VvxBa/6IDX/EjjfkxP3gxnrpxXjuw3jpw/zgwxzyYY76Mkf9GdJAOiqYphRE1fan6XkxNZ25KHveezvuS0fuGzfOkBdLzoup6snSdGVrOnJV7HgoO16/A/eDI1fWjm1iyXC2pLvbUD1tKd5mNG9Nho8CPVCGHiDPc9AS6dhyjEIqAqJy47yJPg50B2eqcwAuOCIjTQ+zWaFsM6p4PRK9FpW3yjt7s29Jj3flIU/iSXfSOVfyRVfyJfe6iwCpBwkm8NqFCkO2+i1ke8ZNW9ZdG84jG+4LO94HB96QA2/UkSd14o64cgY9WR/86W9CKG8jyJ8iycNRdVJAY7fSkYmqUwwnqwXRNHyYSh7sUQ/WBx/G20DaJ7ibU+SCqcoBdBVvprIbWwFMNYCVB3vAhynrxTBwozq4kt1dyB72NFdjtqM6x1me6StPD1RnuVux7EKrvOIyE3wJfo50RyeaU0BVQHRurFN6h07hOgX0Wln0WrmC1apZK0wyV3lkbQzN2hGR1xOC+TGg8rhP9WkP0nk38iW3MeAefw2cccOeedue/dCe+8KB99GBN+zAkwL6AtyL1R9A7w+hDoVRRsMp0nAKYoxQoVS5QLqCD1PRnS3ryhkFoHyZA4H04WAaIogmE8CQ82HKe7DlwBTnzAWz3IgnG0SIgj9N35ds61nnAtxnwbbW4Zup8G0Umb4gu81Iof64kOT02ISMeP8qf0cajBq8iM6L0c9uVyvsUEOv1c3vsC7Y6FO4MyJ3T0x2T3T+/jDMoUAY8hnPfwKZBSDfcGTccmD9DPDa8z7a8Ydt+KPWfKmVACbw2p434swdceOMfvsEeHc20o2DcubKOPBkbOHLS6VgtzH7jLpxEK4cJIhzBziYUTZ8QEh7HnC0LAh1X5qhN8XalWZnxbHQExioC/XVeDY61GALXJI3Gr5GOD4rzh/vD5COuzgmL0YpY5llZrtp4QZr9GaXoh2+mL1hRb0xufvisvdG5/fCeHHHfatPe9aeB+j+Eu89W9Zt4FwH1gNb7jOQwmbCAUN4WTGiDY1qQVJA2pBUF15l/P7hb2PrDqQOhNSGENpjQ6zuN9dNf/4I/EWBwmUiVLDhg0Fdx41p7Mw0t+Ka6At0NUSamkJ9E6aLc0V8UFpObHasH95v3KfjMG3z8/XSl3tnbPQq3OGP7grE9AaXHYoo+jEmdz9AGpO3P7zk4N8gpYwjvTdWsYFz71lzHpnyf9UVvVWFPsiJ+0GHGp/Kxi7k/1P67fX+vyOkVIxCiuUUIGVNkZYxX9+KawTquRnfQE+orSFS1xZqW7BtfHFhsdlxvgTfL6kKALqXx5qXZfgX7o7M3BWe3xOO7g0tPRRSdvh3GINwx/4hRmv2PSvOfVPeQ13BL8qiX1HQ2xFx/6B4eBA+JYIY/HMa+Ib+8ClyWCwrFSsriHQ0BSaGPAsTnqmhQF9bpKkOVp0iLUuOZQAuCKDzqZ5AB1ISoPPGB9nWhpiUZfrn7wrGHIjN6onO2x+JPhBaejik7EhE8WeMuWMYK/4OI2Mc433QhsDsYcK9pwtPGs9VoPdK4iFF8ejf3tjgz+7VoSQGawcFTZGmPt/EmGttzLXSFxgBXOoQjM6CYxFQGRCXBdDBPWWi4ORHg6prT3W3qg0xLc0KKekDXovLgrPv9wCz/jVAkJjWrDvAjxa8X8wEb82Eg6bC0W+fsvjPyUyINBfIWvJVbLm6dmwzazbwnbEOHJYAmqYFxxwUFhga3C4dv0BLTE30w/s70J1saW5WNWGmmOxQzKFQAHCsvEQW/QnAP0Yp6TcAQfcE8WnDvu/AuufMvO/K+sWV/Ra0D1AhXeEK+W8JrrdubHl3tpo7S8+FZWTDNTAWaOmKVPWEGpZcUz+CT3xmPPCa47fQ0hJB6gGwtkx7G5q7RW2YETYTJB1AFJuzD6ADqQeQ/hHdRJ35toN8RudRd9GVcsWJcceR9dCF9ciL/tif9jyI9i6YNhhMGwXN7t8TMpgGZiT5QJqqH1jqsrQcuGpWfGVLvqoD2zCw2iMpLT4hPcH3m3QbhxZYGQhC1JZpZ8t0sKa7mdUF6+NSATTQEf4U3ecq+vv++BmaZ91lT+pND8ZDMMv5016GUd5G1X2KIcE314ytRfxHhIwhyUbWKYRSlfwZil4seU+Woi9dK4Jgn5oZAbeAL6AKxkDhxkHZArJm2lkwnU0oAfpVyQDIOIrv4BqrnN/v+ySA6JJ33RU/8q1AyqNgKkD0PqquP652OL5mNIEoTSAi/iNCxtcg42pRYNgbu3uobBRJJbHKJCvbD8TbBCL8hJuCKoIc4QiEEdmwbCzZNmYsRyOanw4hAaAABSQ2d993QU009wlQF9wBIvIlz7qffEiXA0g3QmvvR9U+i6t5l0gcSCYMpxBGU/HSVDzi/0IpeGQKARAqtUohC6tTkOMYWBkwPop8ibrfw+FYmXEtDTl22gxv1dpYoH90Qe94+H0tHUU/xn47rnxG5EG+7F13LZB0M6Lmflz105Sqtxm4/uzy4RysNAeL+C8RMrdMNr9EFZ1vmpQZHVDl/xs4qX+EY2nGNTPkmWrzLVXZbmCBCSPK/4wI/WeITvgSzwK/+JNvh5IexhKfp+DfZeIGsstHcsukuWWIvP8aofJKFQqKtfMLrLNyveOLgvyqvZy+6cIgfb4Dh2+kI9TXEJhosF21iHHjPpoo799DFI45FFR5MqDmp6C6e2F1v8bUvk8kDqYQRkCApVUh/nuETKuSSa9USsPpJlVYR1S5eNc5O9LtnT/PS9+Wgi9YjOBTvrpaQh09vhlYEtpiU8aTCG7Heb+B87ky9EZgjoRWXQgh3Q8jv4ogD0TVjUSTpDEkxH+VQJWTiSYpRZK0g8imnjRLJ4a1C9UJpE9MbgyYKP4MiLZI20BgaMtw9KoMGy9xfwQSm7s/PntfXN6BmNJTUYTbkaSXAEUEeTSCjPhvEzIcPtWsEExV86XreDKMvSl2oTi/uNxoEF1/CcHAnmHvXxkIIIB0+BZCaNmRyOKD8bl9yVkH0nKPp5dcS8M9SyZ8SqweSfzPy+9fV2bZuBrF2BqNOIJJUqlrWnaIP/5PlQcj37jywEewtqVf5rofw0uPRJSdiC86npFzojDtXEX6s4rMj+XZI9gcKTYH8T8gFDZHrjxLtTzd+C+s/R2Fs/fF5PfFFB2OLT2TgrmcV3ATm3b/z0JOR6jzHQ45+xMKjqQUX8gquVeIfo7NfluRoYVJd/izBBxnoi/Q/8IEOD0570hG0eW84sfoovclhUOleaNluX9vqPL/lL5wKMtFlubJlWXrBeGC/kxbeNoX6Nsx7cZne6AwmIJy868WFD1Dw/drGC1CS4vQiOL/OSGLC2VKc9WCy4P/WKW/qyowLKjGZZmPSwo+FaOBnoj/kIr+MY0pWZarGloW4kRztGPaArJl2VizLS24ZiZ8Qz2hjvZvlYwtOBhZerwqTVqZjvhHlIHAZSAqshDl2TBNuDL3LykHWZElG1kU4Up1cmTYOsFk7cCyhJc5XEMzvo6hUNOYr+fAsA0cU6ko81pJ1t2k9DgfkrMH1cabYuNLsfKhWnjTzLzpRh4sbWeOmhNHExTq0Erf+KyYyEr30FqraIJlXJVlQpVZPMEkAW+USNCNr1GNqVWKI+omlTmmZ4bO7Xszp29oTq90Ti/ir6gPNfuA3Nz98hv79q3rOda++6cVO+8v3fnrkp0fFu8aWrxrdPEuxATt/EpLAHUilm5HLN+GWLkFsWozsn3jGG1C7uzZ3blr3/atR7evv7Rtze0tqx9t6Hi5bu2njvXDazZIV2+Utm9ETNCmCVoFaDNixQ+IZdsRi3YjZh9AzNsH81++FX4T8Ad/v9Dyrchl22QX7VZftydg63rnLesdN2x17djjs+pA4M79O3d3de3ZsXf/2qM/Lju/f8XFrlVXdq66vXn9jZXdP83dh1iwB+YP9F+6A7l8m8zybcrLdhl1bQw+sNyzd4Vn17qA7TvCt+yN2d29e8/OPYdWHzqz4OzxJSdPLTh/YtHZBT1ai/fZ9q0NO77Y59hSv76O0D3bYju7Ezv7Ort2d/Vt6Ds/7/yZhWcetjz8sSP81CLfE0v8f+yI6Nkev6s7edfeXXs695xZcObs/LMdB8I2HIg9uCb8NNhnacCPa+F9dncn7ziQDuTu+2HflZlXhmYMbetL3tGb8mW3A2sjx3frPJC2q2fX/k37r824Nr9neH63FNhq7n7gR8ScA7Dp/i2BA+f2oubtV1rQZ77jQNrO/amHVoedXuh7fGkgLHRb/O49yZ19aZ29nd07uq+0XQGK7dyXerg99I/7ADucXXC2c39q5154H4DoyMoQeLdlv9kNwOzd0Ht86fFFu4c298UDofD7+1PAIbv2phxdHvzHQ4BngUeAhS9O+6VzXwqww66elI37IoGIzl4gN+nYsqAzC31+d1RXV9fh9sPAKS965wHm8FHdKdv3Ju7oSYQRHUjbszMRHPL7Aw/AGu7duhdggVXqTgG0oy8V9mNPMhAHjvq9uDH3Ab8AJU8sPQH0/HIg2H9cW2BYWM/lQV/tBscGQL0T2O3Hjh9PLDkB4P/mqO4xm/SkTJjxy1Ewt50A3b4t+04tPnVxzkVE3xzw5sSxsIWTAQGJQKtxT8EhtC6ye3sC2A24cvee3cCbx5YfA7R7z8SBsDFBdHWnjMMBOoB/4WBYNHH4uMLwR30wBwD2YMfB48uOn597vnv3VyZjpkiZCBs4ctK+E8bwR2NMdu3p3dgLjAY0ObA99QuELxwAN2CE78Rk7xiH7t1du7pA1hxdfvTIyiMgxY5sSh6H8IXJOIcvEQtn3Lb4rq4k8Gbngc5d3buA/Xu29YBQAToAODsO7Li7MOrEusTf8On+bUiP8dm7NW7PrqTdMOodE3y29wBXAiaA28klJ0d65/48J+RUR8IXVrBxuie4AbZHVwSPczvYEb5vS2z3jgSYVQ/MCjiob30fUOnwqsPAPtKe+R+meT+Z6X96VfQXbmOxmjzhlG8SAZgaWKx3Y/QEt66u7s5ukHRHVxw9uvLokVVHgHqI7vkfJ7s+meZ+elno1wDom2A4zry7cyJBTi7xP7Iq5Curjb3A2kA3UCSBbqP75iF65o+0OHxstnoy2fbk0sA/Bn/P9gTACoA9tcivq6ezq2v3BJ9VY3zaDwHdflz7I9AKsXeetMVupNH04yT9xy3mJ5cETKj0OSl296Tt3Ro/nkoHetfv7dqxt7Ord+P+I6sOj5tr3JUgPBDdCxBAt2Y7aaPxcIPmxwaNxy0mAMu4Vl8Y9vbm7+/J3rc1/siq0FN71xzcufXHTd1HVh0CTIB6ACN4AXwxsmchYs8EQ0SjsbRBfVii+LFB5XGL8cnFn3l+zr4bffgTO/O7ejP3bku4vG/5ye1bjq/Zf3z5EaAkYAjAAs4gi6WdS77liWhQl0rkhyVyHxuUHzcbA1uN9YUxzp9z88Gmojv78Gf3Y/v25u3dk36nb+GFLZtPreo90n7o0JqDwL9AWxDP0h1Lf8tZDSGRk8JP4ZUFzJ80G51Z6Luz92v8jKdtV3fKx82lL3ZWPtyBvbg558gPaZe3bDzese/Qmh/HPQ6iqB9w3rHkj8wRYw9WHJHIAP6/NBufW+jftT9zwncgUHtSe3oyR/bWDGwue78F+3h52uXlsZd3dBxdP2Fq4H1QDEc2r0J0fp85QoIY4y/7qUHtWYvlT4vD9+/N+RKu3fuyDvcVj65FD2/Bvl+Q8HhW4E/dK4+t3Xt8+dGDaw6CuP2wfZl04+q/YD7GHzUiUeifpPdyiuutpfGHu/Im7D8GAbGmULqlfGhuzLspblf3Lz3V3nu4/WB3556f+xaMbFiNAMx3Lv4L5mP2kR9t0BpstnnbFvhgWdLJ7TlfMg6xugDxQ/nonKjBFvvbe5ecXLN377bu/s2rpOs6EBvb/5Yz/G+DhrTJcniq94fZ4Y8XJ5zdmAEz3wPGjxREez5gjpgdOdpsc69nyeGtna+3rRhd34FYt/afM0c0WUineIzMCPo4K/yX+VHn2uN374PLDiziQCYsYmsFECFttr63f1Fv78bnO5YPr1+DWLsWlrLpX0hBTHGXzggYaQv6OMP/cZvPyWXBO8bGAxBCsJXGpCCarH7pXD60YY0UMP+PRCCmBwApw1O93rfYPZhsdWSZ3/axKIV/tLztq4jBLyL+QynwHbqB3YaaLN5N0rrXanRkRRBiYyliG25cxNPtK34j4j+X4g9ejDaaDkmU3jUo3p9sfrQ9AtFZheirQ2zHwY9zaLJ6vnXV72X938QhGk1GJfJDEsS7BrUHUx2OrItF7KtFbK+E75LfZPWqc+ng+j+I+z9LHKtjI8MS+feNhvfbPPu6cxA9NYgdE0KHtqz8jsT/hlCEZFgqkRlu0HrfbH1jRSKim/hFqBRUrbX/K6EICUraoDHcaPpmdti3QhGb/rdC4WYE+mZb0BehyGbr/w9CEY1GCFjohE9RzTb/X4Qay84KQ+wF0YuDbwbaYv//QSiy0VhzcTJiPwnRS0Juq5CbG602xe1/LRfZoCHbZO6+FwuqnOwWrNr8ONPZQf9joTKoBk21VkfE2iK1TRjLFal+axP/pxKREhm5Sbp2S2KR7fk220oiunMR/7MMRUqGZSTy2i02MmvRyC0r/xdSkBJ5GYlUtUEjYne2Zg9Rbvsy5H+7xCEbTWQkCsoNcr6LAzU2lhgcmCe7fg3yvyoC1Wiq1KDm2mZv0LlMFswe/x3OAagpHorN1rbTHXW3r5BZ1/F/5jn2DLBpPuazA1J70zS2rkB+y/PfMwTcZNuCjRbGpfWlKW5uR/7ns4SHTFuw7tIUuQ1r/iMOlqip3hoLE9IOpFnuXyQzbv9/wUET1GHV2eHpB9K1dyyHbfJPR0d5ZIO28hQ3BZCA8CF/PyQjJQoKjYaBe4uRQMkNf7M/UoKSa1Cxnx8sB/hv+DreI5vtkI1GyAY1JJyhgCcCJUHKSeQMW8y19i74dk/5Zlv5RiO5BjV5iZy8BKkgQao0yJm3GAJDoQDAsZUOct88wylOBq1W+k36Bo0qxo2y5k0yLpNVsta7AIPI/7ACMbbaQvXMVz4wJ6XdOWGpTewi89gFBvEL1NOWKJZuUpXZvhS5Z6F810L97kU+Patr9yvV7pPX2bNIbs9C9c6ltls74rbuxe65SuqVsdixyn/97oz1l0q3PK/c0U/YPVrdhajegyD+F6n7K9X8CY1/CuQSdiOqOpH4nXIF+8IJ3U+ru2CV8Lvga9L/j1Q1Tp0TVLnjM23/S9oB71zdJVO937x497nc1U/Tl/anLh5NWYz45zT+SMO0JYis5fC1xjU9CFLve2L3SHWXFFgbQP4bGoMPNCn/AYnZiEJ3yOaslLVx94pLS8klCPjVovpp24+f35aB+N2GkpORUwKbsrKSkpqmro62loaapoaSkgrY1NRUlVVUVNXUNTW1tbV19PT09Y2MTcwtdNRVlWWR33JBolBIV1rfkY5VSyF9Y2MbZ0/f2PT8SkotiS5o29B17dyBvqOH6u0Qf9hQMiiUrAzYZMEmN77Jy8vJyo39J/91k4X/UYLVUVZQBJuCvJzMH3jJmmB6X53btWH53LaOWYya2oKsJGU1fSNzW2dP76TkzDJ8eTVN1Dy7/eDJs+euPvrpNE7mj/rIyikASXIooJIcUA5WcGyDdZT5uqFgjWG1J5QG7/wBnFPz/bd3L+5du3LJtBYJo5pQnJmQEOtmZqCja2hmqqejo6ykoq5naGbj6hMVnViALSmrZkmmL16999Cpm8/fPrzXlWv5R+1g3eRgW8nLI5Gw2eHtW0/AG6y8rAwKfCwzZjxFRfnfI83c+PO7h7eO7Fw1b1abgEOuLC1OiY+K8nc00NHWN7WwNjWysMNkZmSnxmXXZKWWMOsy3Iw11RRV1dQ0tPWMzUwtXQIiImIzi4sxOLJoyuxFa37oOXX96aunpy+cn+z5m8CA7YdEwtaDjST7ZQPqIX+nMdBUQQEORti/vwkwWQvilrMn9/VdPLVj5ZzJzY0iBhFbmpUQHRPvZW2oq2tibWNnb21ukZ9fVJwSnBKRklVCn7Zwbg1GGFCB8/EKSC5EE4uI6IJJpTGhXrYOvk4ycvIThkOOu3YiBJVUlBTGzCsr+9ntQFPYycDq4H2Zr0rFpWOqbQ30DW2cbM0tLMwzinBFhalZaUnpBEjcMGUFXliCzQl3L8+rXLxr2nx2SWJUVCGPWpOallGMq6ZW43PjKfiU2IS0aOAaeBuzw5g5xk0iA4sajyzUmAVhRb/YC4TCN64sIdTW0UyNbRycbO1szWPz8/G1otwiUX1HRxtn8pRGMhZPjk1Nyc6JiohKL8YzZixYTstckNNO4c6QLJ+8asb0ksrqGiIVIynKSc3BE2rIOfHldFp5eUlynM/v4s88Y9vIpywcjcPjSCYnubq72xnrGydGhUWlJqWS+et7d6xbNX1155rZk/hsdFZdfEayV34uRbR07rw5c9eumr6gi87cOWnHkpaZi6YvwGBpVVxiZVVVKhafkU/E4EpIRHxWcFjCt9Gj6ZLF3PJYOnTn0M4Na9e0t6+c29zUMKVRyGdRSFWluakJiVnFtUwmnSGc3NbW6G1qbGoUlxAVkV1dVkRft3vNnjnzp27fNn1bu7CezG5iphfiyvMbW06dX7Uj6GDPSgJu8ox5m6av7Vo2T7JIQuAUE4vz0uOyKtAVaYnFqQlkEr4gMz8sLCs7p7AgqzAnK6uEgK0mkZkCLqdx4cadm37YtXd/X+eO3UevP3l05cyVO6eaYrS/0V3ZPrWiAldZw2ztOHTu+N4N7atWgNhtFDLYjQ0iOqmmoignLTUjJ7+8lkqmT9mzuXvmqsS5lBJiTV4+uZE6c8ZS3kwOKQZDahSLGblpOXnFxSXY6OgcgQiHKYwpROeXVqCzM7NSMwh4LIFE5Yjq65vntW/avL1z556dO3d0HTp3+uGrBzfuPbh5ZmvklzxStwxFV2BLigtzc/KLy4mcNbu3rFg4d9FMiQSiESWN9fy6usri7Mzs7Py8XDQWV7tz/6HencupRHFeeUVauF9MCIVNZXJoddnJ2ThKPYE1pzIus6yoDBsXkEqmleamRGamgkwozomLzSwqxuBriHR+Y1Nj45R5qzf+sHnT5m1bt+3ad/j4yZ8evBl8fu/2E+k+vc+qyRv4p+QUoAvyc5MSwBYXHYVubV8xb2prs5DHY1Em1YvEtNqakqzMvMLCwuyMzLT8opr9TYf6ettnLp3BwBbXliSUxmJJkkYeubgiJTE0r4Wcli8oby1JT8/KjQzNxmJyEjMjIiKT0eWFOdkZKSk5ZYTqWrZYJG6eMmXyonWbN6xev2HDlh179h04fObihZu3Hrx49npwlrXsV9tZBaSi85JiEtKzMpKiQvz9A0MTyYtXL54F8XkMqmTmJBaHxySV56RmFWbn5WTGR0cGxRQJhHWnjvXs2b9s3qrFmxcuL0az6wqzw7FV1MrQcHwasSg0Py8hvlJAI7JiQ8LiEiJSCzNjIxIC/X0Ck7OjU5Jic9JysEQKm8ttnMoWTps6e8XatWvXdGzYsm3D5l3de/u2dJ24devaC6n0ofeXZoFStwmIS0lJSU5KTEhKiAkL9AsICA1NpK/ePF/U0EBjTZkiZDAZdGJFYWYa8FJuUnhQgHcEpjS/hlY/d8XK5R3sGExyUkEBrW7amu3LdqzddPzCjt27t25ZUj9j8aI5nds7ukSbpsyEWtvqmQIMNS8Jk1lCrPUATCIycZiU3Ow0Np5ewo0KifKPjYxOiI8MDXJz8w8OCctISIsLS8woraplCLkCiMefMbOpZeH6davbl69at37t2o3b93R0Hjxz4dKdX15eKW9ZwB1LIxlFXVvfyMSE2LjExLioaMDN38/P1z80NDKTPnvW4tkzmoXNTTwqlUKpwKKzkhPRJZmR/v7e7mGhUfG5tKbpq7etF+XFJiTlFJWRYpPLJq0R87bt2gMicXVb28oFEKmSMX06Ps6lUDkjr5ojkVTmZcTnVWDx+Gz/cPuU2OhITFleSU11SVVGeUxqaHxKbmpsjI+LtYWPj5t/ZGp8REhMRhmRROIL6ygN3ObmlpZpc1d2tC9euHjtqoULO7Z1bOnq6Tt1+aezjWVEHtSxDo4jFV0LF/+wqPjk5JQ8dDG6AF2IraphTpo8bcq02fPnzp27bnXHimnNjTwqiVQNIjU1MTk5PS7Qy9vfxdXFwzumSjh5+ZakjJhCj2qzAkt1K5fwdAy5rLw4KSYyNjacTo5x8Pcz8aNW1jIJuNLCvBxiZHxEcjK2KjbS28Xd1M7ewsEjOiQgKCa7vIZC57GrSZN4PKhl5jTJrKWrliycv3xh24xFq1es3bJ95/7OzhXNTBaF3TJn69r5K9Zv3bWvt7dnD7x17dnb1/3DhnUbtm7bva9n97YtK+ZPXdD+w/yZyyY1COgUQlkiCL6E5KCwYC9P3xAnXzsrt8hipqTZ2lJD2SPUydzYRNM6NjqjorQmP7mEVEWsY0xtKY3EeKYW0rFVFTUlZcmlDZExWTnFuYnBvv5R3lYWlnrOPh7+7kFJ+SWl1SwugymSiMRNU6e2NE1fsHTxnDmz26ZNb5s+c8nq9Z2b22c18nlsiMNvbnvx6PqFC+dPnTxx/PDeru0/bFnfvmxl++IZk6fPmjxnRce6tSsXTp8+c9ma2QtnQY0Qu64KnZGQEBMeEejl6+sXGGjhFWRl7RZeXFNuGKzpaOUo7xhbhtSwN/VJyskrLMjOwBWySYIZAlZxemxCFRFfFJeVnEesTYqNTylxDyzy9Lb3dLTycfXy8nG0dwqJz8jMKRFC05uFk6dNghpnzJ0yfd7CeXOmz5gxtaWhftr8lZu3d8yYJBZA9RAEceuId66d/XF7R2/vvr09e3ZuXd+xeuWiuVOntIoFApGkeeaCZUsXzpk5dcbMhQvnT+UJ6wV0cml2SkpUoLefp39ocHhipEuyu0dgRFpOVraiY6CliQ7SylsvzCwKaRCREosuiMljNTc0NU+R1KTGh4aGZVZQsbgsdDwNmxiflB/nwaO5+zhHukfkOSdWh3l7O/pGpIG6y2ibxhM0NzU2gzYsmTRl9pypzQ1iIZfOFkyauaK1eZIEAtrXC+vKsOSrZ/Z3bt/2w+7d4M/mDR3tK5ctWbJoTouQwxfwBfUt02a0TZvcKmmZNnPebHCcpF5ILUpMig/08PByiEwMCfSP8ghwjsBlZaTGJXmYGHmFhEZEx0Tn1jJoAoyfpaOTta2tk5Oxnkm6tZ4O0kxFSc/JPSTASkddwz0otyghCc+btWD+zMn4wsTI4MBYTBOEK03wRhMz42OSU8KSior9IyOD/AtS4yqiHfzcXQPi0rPSMewGkQBqmtTa2tzYIK5vndU2ScRh0Wk0lqhl3pxWEZtJY7C4zLoqMC3hLxzs3LB2/eZN2wC4jes7li1bvnDO3HnzpkJMFoNGYwvqGyQQT8DiclvbZk5undRYL6IUJ8fFhbi7uXvFxgRnFgR5BAcmlcYnJifFxaf52rlaOzl4+zs7ppTyG9nViUHB4ZGuNhZ6uhY6OuZurkbOCnpGYUGx+Wm5JaH2Hjp+NVx8VXm5sKZcMpNWGh4RER4em0lPTE3y8C4vKUiPDk8PzEIT44pTQ1PLwAgS6B7oExAenZCcUVLHBxgbGluA/xok4sZZTXw6ua62jsrgN82YLqHVVldTmVRidVV5WXEZ62zv5pVLlq3qWNexcfOWH7ZsWrlo8ZK5bdOmTWsWkvFgtiEyITGXUlNLqq1mTm2bAvwvZuLyM5NCQ4N93Z2CcpIyc2N9o3NKijNT4tMK8/OjrW0dvQI8fUJcotDk0ixMelpGUXVlRZqPm7OtnZNHTHFcYnhKLJUg5olpZGJJpn0ccc6iJXM3bllEbCQkhhfFR8bFJ8dgc7Oj/eJpdejM1IR0R5/sbFwFPyU1s45AQkdGB4aEhkcnpWEryJIpLS1NTU3NEnG9CGqaxmOS8ZVVJApb1NgioVcTgPLUGkJFUS46u7CG03LuaMfMmW3T2+Yu61i/YT0YBNYsmTl5attMkKgcMr6spKiUyOAySVV4AqEMy5k2vbWpScyqys/IjAwPD/X3t03JTUn0iUouyi4qSvPzSS4twORY2iQlh7k7hJYVcZvKo2NTKkpoIk5pTERaWm5+JqaIXN3AYbOP7Ly1ZzK+vKa2FJOS2rpqsWjxD0BHSMgi19bWVJPpVDIBnZ2dm5WJZs5YvHjFuq69XT/dvnn7/NGTJ9c3CptbmxqnLm5ft2HNiiWLV6ye29wya97MFl5dVVVZQX4JDgyWwKG40vxCvGja9KbGJhqxOCe/ICkpLioyoaA4PK4Km4otTkGDMEnPKanMSolwziiJcbROLGNK+GXx2ILSGoaAxabQ+RwKtgDHOnvh4aXza6fNWNp55QA/s6KiMKyCumFF05TJS37YtEMydwrPKx6MhUVRbpYulTxaJbowPRaTHJCEF+ZRaquJJeiStIgQ/4Cw2Nz0HCqY4eFSIaqXNDS0TBEB99QSa+sYPB6lEkek0Kh0OoOCKyxEp6dllwvbWiav6gQ958SJvoOdTYIWKppAotA4zYtWtHesXjJ76vR5c+e2zZ7R1MCjEqsqyjCllXUMahW+HJ2VnldKrAcB28SpxpXkFxblJ8cnpKGJeRFFvILUsoLs9JQSYkU1tSY7MSOfUOvv719J4XEE7Ji4xNhyiqR+EjiUgceRm5avWDZ3YRvfJzSVOGnOcg4xNxmfkMWd1krLrZMs39rU8gM3l5lsEpyT5WLikNPUOokmbqzGgrEIh86qLskvLsWkZxeW46vys9JAqJYSykiS5skgOidxyHUUflM9h0YiVFZW1VDB9J2LIZBqwTIDX4rOzcnKTIsvpAok0yXCRdt2tE9rbOZXEzAJWdn5haVEbuv8hUsWzJzSPH3OwoWzp0wSCQQCTk0VDluBr66uAuNQdmZOYXEtf+bUlqm0KkxeTnZONvzsnKTCsjJ8TXluMR6bgq1AlzH4xMywGAyRkOcZmFdbC0koJfGZCSWCxvrqUjAkphRWl8W7ZSYmuCoMD7/1ianG4Euyk0EWVvFrS4PDSGvm4bb9WJ/EjbcwtfcKtTYPqGlqZvHqCTXV+fkVVXUMGi63hAGW5hhseVlecmJabllFRbVoVktjw6RJ9VQKmSFqoFPIJDKZQmeAAEVXUqjEisqaytw8NFA3Njw8vSCziE4vyaoil0T6hbo4+bg7ByXlZWVjqQ0iNo8P1YtEYh4NRA/onOxqdH4xtqICiykvK0Ln5xcUlmEls6Y0NddUoHOzc7ML87MzMzCl6JziKnwxBgQFHZuHo1Aqo8Nj0kklGEPd0MTq1gVCdpxjWl1iKa84nkKvTRV7ZD2aOSiVvr8jlUrfjQ7ZbDxv7RuVQSzEYRy1baLxqc5oEc47O8zS3srURN/INgICM7aIQKpHx1VSOXwWj15LIeCwmMK8/MJiTGFWRUkljT15cjMIMAmTWkdiQjQqlVxHpjBY1XlZhThsaRmeKWJmphfkJQUE+PpEx0Y6Wafxqty9HExNrFTkLWw1NWwjkpLT8vAg3nFkfr2knlVVWcthM+lEbGFhSWl5RXkpiDoMBp1XgCkub5rZyGeTcMUF6JKSMkxRQV5ubnp2BYVSWwnGxHpWGaacTIzLTynMR0cZajjkMiUSWlWEPW1m5coNP4jra6Pj+h9Kf7M9lX6IcDCMwILVlZ2ublJqqKehpZOWobWGvYW5oa5Jqg9xxqwWIZ0zjVFQJ2Lw2DS2iAs6Jxadm4vB4SsxpaVYBls0ubWpoV7MY9QRSQwel0kh4Ilkek1RfkFOVj6Oziej4YfHZOUlels7RaSkhtg5xFZhIxwsTPQM5RUcTJT13ILCYhLTS6rKCRw2D5QTcaOIRSaUY3HFmTUsekVJeRUeV1ZcXFpenodvncKnUuh4sIouw5YCC4RFF4JGXkmi1TCnMprYRTgalBCfXVhakuyspuuNzspMzW1NiapjVnSsmc0gZnBPfwUfY6/m5I2h1mLyXeysbM10NYyMzIytUkJyheLmqdzmJgaJDPFZfFYNiUYjVgK/FxOI1Xg8jkggcetFbW1TmiQQl04kEEGtoZMIBAqHUZ5biC4BGVJZVVoY6x8Y4uvuaqlnYm3tFBXrbOWVQsB466DklGWVVVU1DZ09HLyiMrJSiivLSXQ2k0qlkXGFOZnpaZkVpcUlGFwdCV9eginDVZQQW6dJaGQWtQKDwZZVwKjjMaRaPLGhBWKwxJOY1SSCaEpJSmYBLi3QTc8szN8tObWSU1hXQy2b2VJHqyFceSWVatu6F5VicIn+LvZmStrGFo4W4cm+Xnl1hGn1giU1ZDaXxROiiVRCBR5XgcNVlGFrmeQqbB2lBmrmz5zW2igR88n4KjyJQqHS6Nz6elJWNrogMymlgFBdXJAW4e/pYqOjqmXq76rnkZ1ub+IRGx8XaqSkYm2oJCeraOzm4uAdnZiQmhibWU5lMjnkanRKXHR8HpFNrSzFk6rJRFxpaUVleQFnzsxJHAaHXQcGE3xNdSW2DFdZCmpkY8vUVglvaj2ZRitjYLITcvLifQNCzMxtnTwi44rScwm4jHxygS9FzGg7J6uha2mfGp6Z62VnYmRsYeboFR5h5xCJLquf1No+Bw9WefWCGdxqQhWuEJQwOk/IZ7F5PFB2oeapHDbUMrmRx6FW4ytJYCHJpvLFhNSojIKUxOR8XA02Kzs33sfN01hJw8TEI8rMIpkYaePm4eQRYSqnZ+dlKU+f2yZhURg0FqWOTBOyGOSSrAJMfiFVxKSwmufNauRyBOQScj46Jys9xMnb2cLcys7OUktb28DdWt7CAaVlb6mhjZDRMvcxTcyNqswLCktK9HFy9HVzsHaNSC8lTZ08b01zNVfcBAnYFXVMSiGGyBQ11PNFDZNbm5ubW9sWLeQJGpolXA6LXI2vonAhHoVMLynNS8iqLi8uxFZXoRNj4pLjgxy1lZSNHEw9o+2d4pKCXOy9XKwMFPVtjdxmNLPINeRaUMjo9HoOn0+pqCJV4vhT6+lMESTkc3j1YhKNn5WWkRhs72NtamHnYGsfGhMU7OTiradvraGprAGf+pTTMnc2sSlOK2DiMosLY+28/UxNbAKTwRp8/sy2JbNYPD6HxeDjcVwuLa+shls/qRFqmTN7aiNf2DB19tSG5mmtfCaHUVuNr6WzWHVVNRgsuSg6k0CsIFBrcsK8fX38vJzNVUFkWXu6Wmnbxnh4mJv7+egjlXSM1WyNBdQqEDdYOFurmTQWm0pic+l08SSBSAxx2MJ6kbiBRok0SLDSk5dBKiAQSt5GNpnWxckRxmZjJ29tHMysdMwjUgoJUF1xRYSVm62ZK1i25KDxLTOmzG5rmCQCnYAvqK4hC5glReVEdkNT65QGDpPG5AglkslzwAqCRwcDOIHAoJGrsfmJhZWVBVmY8moSni7EuLq62ltZmOmqKsgqG5nYO1n7hNiZWNg4urmZ+Xm42YTaUXT8fSxMzW3Mkcpq6oqmep/PVitF6lhWmaZG4gw1ldURsvb66kryynaB4bG5tcyq4ihnJ3uviNiE+CIMQdIMTZnWOJlLpdP4DB6BSK+nVFVT+M3zF02qLUWXVtbSWCzRzIWLZ4kolLpqAp5KqcWVgFkzOys6vrQOTF/V5eXl3laGhqZGqooqMihFdQt7awdHf0MdMwsbB9dIB29719CAGr9cLK8wPjQ8xMfUwNrOOyLcKznG1cfeOi3B3kvTxFlLxdRV1UpLWe3LyTdzBZskdWMOPd3bKMxS3dFUQUFWwSwgKi6nvAqTnxTg7BABJu/UojxMLbBfabK7vR9ayCovyEuPi3C3MTPSVZVBySKRCprO6gY65kYWxpZOtiZ2fua6eo4uHikOumRsKR0qSQmOCHCzMTR0cgoPiKxNj46L8nP189C3MDDUsXP2UtcwUEKpjGlTGudnb6Utj1LS0nNNKCGUFKZnJPna+ifkl1ehM8FYVUPxsTA0dQjFYPNzigriPV1drbUVZVEoWTlZBU1jAx19HU1rZ39PW3MzJwd5TWMTC3dLTcsmGr64BE+qLK/jc5kQhzWtEdRLXFhBfFRselyIr6uNl394SBYxPSUtxMrGxd8eLHb1rV39NMyyw/2cY70sTW2cvbwjCwuLCtNjPB2DsoqqSMTiCg6JUkupnzx1xsypzRIRj4GvrSNUlNWxJFNnWBjr6xo6RyeFBqRVxto42Vjrqyorwt/HIWV1NO3VdRWNzC28fNUN1E1U5dXN9XUdPO0cHR0SKI2NEm5dcV5ZWUE5u4HLAuv/6VOF9TURyRUVJelgYE1JCHMNi0opxpXnYqOcje39bXQsjA3cjD1tlauKM9NKaGwiSIBY51g0GpPj4xqVUUaqY1OI5Xg2m07lN09pmz9zSqOITasqr6KAJOQ1tDTW00lcS30dbXU1LceEcGe35FxPA3trQ1UlFWVFJBKFUDHU8lfVljVUM3DwVldVVVGUUzBX0THzcrH0cLMDswUtL9BCV1PDKmfSsu19HbQyUn29gFaaj62hcZtmTGud2jZ3xdK5U/PzSVXYnNzSyqqywpxw36AsXDm5FpvkYWFgYKBtYGxsHRYb6WO/BKw1OOXE+pnzVy6ewc93dU3OTwwKTCnAUoXCVgmZyBOxRZKmqVOnzV4yb9okPptZL+HV1nG5fKGQTZu1as1CYXVihLe9gZaGqqKSZnSyv51btL+5ub2DkYYqaHkopLK6qplRMICjIedkru2krYhSlEEYyOnqGLo4+Dl7xpIZ1No6dJynmqySL2nZlh96T3dNInGETCYNk1vJh0/OgPXOlDlz5q1oI1TXcMrQBeW1VDq1MicwIIdAYTM5peFOWigFLQMTu4SS7PTgvBA7ORDUqiYpU6ev27lh6WQWBlu/auMP27dsnFfo4xUZEhlTSJU0tIJ1Rms9k85ubmmZMaO1ecaCeXNmz5wxnUPC59ZAYolYQuUsWrto+qSm5gxDVeOgLNBEGttmzWidxCmOic7KS/K30VVTVpRXcgn3trN2sTPU0zOxMtNWkkGiZJQMNA2d/DXVlBX0zPyRpnZIBFJGBoSjnrZ2QICpU5CxpjyRQudQK9CJXsZK2pH163ZuWb1u+5oWnkDAZHOwWZV1dEkDlyYST54/Y9aSRa313LoZJDSpwl9f1diV1bZp16b5fHwNo2H1vt4fd21aRg/1DgiNzybUT5m1Yv2KOYsWtohbprZMnzu3qX7ytDmLl7Wvm8zltlYWSibVC7lsMjRLwmYIVy6vslOx8onPKCI1TYa7JrEszi8qN9zDVENZWVndwNLO1szE1ERTQU3bQF9DASUjo6pn4mRnF6KvrqJmbBKoZAR/2YGSByOAmY6Kn522rZGqvIKSIsAvr6KloaRhoKehYWxtYWpnrW8YFpfgbqCtpamuoWPqU0AGy6PKrLhQE1WNsMldPZvXrWhtmdUi4fGnQPWEtEIyhQcWGfVsQVujePqceS1TVm5df3VL/fSuH6bm2jhWrNq0flkbhdk4uWXxrsO9u1c1MzLCEtILcCROQ/OMhYtWr1mzfHbLwiXTpk+n4ma0LuxYuayjjcEQ1RYxmUxqNaGmRkCvLilq3rlL6Geobx+eiGMDm7P5bEJaRGRCYqCVhZ66moqhnbn5/yPkrcMaTfN04fKiiioKKdwtBHeCu0twlwAhIQ5xdyVuQIgRIBCCe0FR1lXdXV3tNtYj+83unJ05O+fM2rdyzkqf1OzsmZ7duc6+f3DlfSMXz/385L6T+/d6Vh8U4H3zbqCP970bV67dfBAJzM1Iak329/dJ9AXdDYt6G2d3Ym4GhwXfiIj3DYq8fcMnyPfWjft+Nx5E+t0PCbnnFRLm+zAtIzIiMb8+1/e2t++9gFBAfnn/WHdnfSUoNcbbb3B+74PvOeWHEgKNMEvhC0QyHAzSMTEySaFqTGbVvFFpNBkunn362Z//7NfbeuFXf/GRsfZhh2HZU/+0GyfbpqW9s90VCRnV2doJBrd09QyMIvAchcZgU+jXlw1z3LFuosViMWuEYuoMpHeSSMDPoKb7MDj4RCNY+c5XJ6zm+NCk0vYx6DSOREWPt9Y2dNTkeqpxUvD9SEASMDkg0OfObb+EiADP3t29cfNBVn4qKLw6ITo41DfsTtqdh9c95fVGoJ+P1/Ub3n7+wYCge/fvhYfc8DQG/zuBEQFRwfdiI3xDg8Pz6+syPJ/rez8iPi4uPrOstv5yxWGcmxzE0JmUOZ0e297VPUogMAl8qYDOFKk8AeGcs+/98l//9l++/fZTN4/xs2//6nHXrUS6mDu3dPnZZ2+enxwfWFiw/oHqivKivILCopKKyjaMhC9xzC/v7S8JSSOdSJvDomQRaGwpqb+TTCYSkNCejknESG2T9NnPvrfOLPW/D6yq7+4bgCAQ/eCGtp7m+KSismxAdGJ2mofOJTz0rCgs2sf74b0H0T7XA5JSQE2RsUHxgNiHSYFhfreCfa7cDM7M9rl57crdLJ+HAZEJIYGRUX43bgcBgAHBUeEh4ZEJoQH+KdU1tRWljUWejgZMS8nMzgeVNIHbGsrKskNuxeGNzvP331xu7x1fSEchBKHcZteh+nATCB6JMkVmcuDjdA6Rrnbs7G1Nf/In74mNl//jrWT7zc9dMuZffPuL3cwbd7vIko0Xn3342Q+/+ebZ0nBNWX5JcUlxNqi4rLw4PzM5p1tp0S+rjzelFNzYGFWzPE8nssQ8DR8KYTKZZDQcghFz4NM049F7r9YF7RH34sqqW9vb+4Yn0JD2lqbCxNjciryUhKi07PikjMyS4qSHD0ICfWO970ZHeV+9F5fQXJvsHRdbFZiekuxz3Svcw3gDakPu3r7pG5MZ6x0cFusTEBgZ7n//fmh0YGZaaHh4XPyDwJiM4prM/NaOqpT45LTsjPQMQEx8uUc8VVblBd0EcBf4bN7+Jz/600u3jjY7iTea3G4ulsEWUajkGTqbTxiAkTFIut526No+UMLKU6WffczTfP733/7qb7/9x892ObRf/q8PIF637jVI7XtHTsuKy2ETl0XFJWYUgsorissqKooLstOBScB2vd6oty/JkDDoNImr8RR6vYwu5JKpHA6HgukeldExdLjAumrSS1jYpsjIwuqm9oExyBTCw8P6qnNzSqpqCxJjkrLTUgpA6fm5uQn+wHT/0LDEmLCbtyNC4xtLhpLSCoszUtMexl67fuXK9du+WYFXk0L80uMy/aMS/L39gqOSAd6emuBdXJwFjEoIDwyOLyjMKaxtqS0BxmVlF9Y150eFp9a2jw01NtUmeidjdcj+KfmbP/vH52pW9zRhSrhtOt7VC2kMCpxEloglLPTkFGoaTpSZN7dcR1tLJm5XdXlJaesojDmLGW5tmuAYloTjMKZcOz9Hh5YnpmufsrUb3//VT///3/zdB3vczvWtwdA7IdF9UrVWzmTR2XJism9QSDggt6Smobq6trwgEwiMj4lK4xo0WssiYWIKhqB4MlWjUTM5IiKBJ5Hx6LMTzPHSgZl+1vKKDtuHo/dFB2UUVXdMIGFd4CEIYqYdAChrrgalRqfmJSXmFWZnAoBZKTnJN2+nlwZGx/n7hCSWJ+OGsptSOkISYkNSQr1u3PRomYgr4cVhgcVRwLSK0MCHMZHB970fht9/kFlT70EuJiosPru0oqqmqbi8ODm3obZ+sC8/rbyuoKq/r7WrNvF+M49b1yr79JsfvhKxkc1TFNyc+cnpqY3FHhuEIUWyOdEMCjGEQnuSQGHaXnNo+6pKkrMAcYD07Iqa5o7K1ISE3Mah7vqWURgM2l7V1l4QlkZEqDY+/dEv/ulv/uzEyOgZrQyNjA95EFI1jMaj4EPw8dDrV69evxtcWNM5MNhYV5SWlBifCEhI6l8QL+wKyAwydlrIESnEShFJKoNOyK3WRR1nljVZ3jyOpNh337G19zDp5f6R6aVt0FnkYD14emhgJDUspbYJXAKMT24CAvMSS4uBiSnRKZleN0JTk6pyA+9HRZVXFzPDqoAxqV5BIbWpjdevXA/0Co+MeAgE5idW5HbAIqoj4jLCbt8LefggpaciJTq/Oz8pJb0SVFDfWNjueZzb3AOFN2Sl5CZn9RLGRtpjQsvFdLDIZLYx+XKyeGAEimQbdp+c7Bh4HLKaM83nE5CTk3AKa4Ys0qoVBoe8MMzPLz81JSUpPbsw697boPfyiwPl5+RX1hSnBN7z8kpIS+hEi+f3Pv6rb//hB6squoifH3PTy8MiQnJaxyb7O8HRvxNIN6M8vLsclJkGiE/wIJfYoBUr9XKFgk8hUGYIymWLmKnW0jmWFcfWmogvINY0tCE9uvb4NScTrhmJ8M8o74BRKJjmcmh/S19hdGheS2d/eWR2eVZ+WkkTCJiTF5dakhUekp6ZnJwTFhJd2hZTMZiaEeGX4RU1WJaXdvWaf7yPT3RxREI0IDMJOJOcmRYASAemAgIDQTmFrYV14+3FeZ70rgC1DXaNDgBCSsfHYZi6+NzG0VkOFQmpDkmcXsDO2qElDSXFRCZ1cqgHLjftX57sG3gevimTzPH4NPQ0AkdkKBd0FqNeAcmL9PGOzMhPzsksTrj5OytZYGNffZUnGoPu3bpx9cotAMus5Js/+ctvf3Opk6o2twN/60jzCkoANffzeUbHklYmEtAwCNaaQymUG1U6p2vj7MUyd8VKBzd3YKgE/s7aUJFU3xUUU9YyzWJgcOAu2HBzQ9bD0Nyqjv6qmtISUFVOY3tJXF59QVERIL0aEBqTkJoeG1FU6ONXmwGI9M6pTKE3RMTdvBuSEni7rrQyxgcAiE/vT04ABIQBQssGi3NaWnPGKA01g3WZJWVVxSUgJG6wvTCiAI6YprYl5EMVpGGCmNCbFD1gpyIWCaGBcdGxECKGhEXyjM7Hjx8f6PhSlUGvkgk4RDIaTWbx9Satw6IlDVQAQh4kZuWVpWUVX/93j+CNetxQXVZcmI/XzWtvXWTNB4u8xc//7p9+uU8iOx6DfmsfuXY3ICw2pbDedeTUqpRyEYNCpmgXJQb5nERl3do9+eCJ2fR4A9LYCkOLyCY+BjO6oKgMSqmFsphTkJmxHtR4ZV58cEhiZlnP2FhDaU9NQUNrWWF5TtVAbmpKalhQTFJ0bFJcakp4mE9M4sPIpLG61InIAN/IqNj04InUiuS4jIqwlMoMj+J8GBWb0Vld0t3WUjEBh001FTZC6mvKckaxXfX1xYVQHny8PqloUsWoqsGIZtsym3UGolHbEXH/fnhcN3JKuqxYMO1cnl0eqtli2ZxRwSXOYmfpLK5Ib9ULtEsq6kRrRrjvvfTkrAKg/+9tlP6DfQWRAT53PRC9deNdQyhY5h//47/+yozDSf/NnXbNy9vXPyAwLC7e+zuOQK+EpLT4uJT4+JT0+PikDvPWjn1erZ7jsbg0hkgssS3wSQz+0u6jFx88cll2BbXgkdFZNA6TjUDPLgpAwZXDLBG8pm92rGmovwIYFhwYGFEwOD7YMQCpreoeaSnNyKsGT1XnRYdFJsbFxWSDQamJ7Q9u+nrdz0zDPihKSapJzQLASjvzU6IeRqXcDy9KAdx8GBKVWFKXUdRaMwAZ1K5MtnZ3DXVk1U2i0b2NDS0t3RjGQEZ65fTsbF9zN5xL7O5grgrszyVjmXcCMnL7Ia3WA6Vxaff08GJHTJHw+GYpkYgn0rgSicLsXJJoF2VU9HB+VIB/fFJSRvr/BcLzAJgbevetW/bfPboTzM3/+b+//Y2aR4X/9vz6zVted257jrt3r33HvnoDCIwAJKUkA9MSYmPjOx0HBztWKY9JpzJZPJlIvWJV8oh4ycrR8ZPnJ1q7or6uq6a1trcxuUGAZss74rMn+ZKJ2q4JNLiiC1yeHur/wDeporN3cLy3eZyJHRjMjG/tG+5r8VS32NiQ6OSSqeok/6K4kIgr93KD5wJTC1sHO3IbhJFd8VkdcVUP/DsTs0ujwjLSohOSMyrAHfUQBho7UFg/iizLIAgwPaU1Ne093dDx0hRQ3yyViJwYGKVy4CilnXr5Iy0PF5dTXDI5VKtfVVpXN/a2T9x8HEWv0zO5XBaLI5RrFRrL8uqSgUtjk8uSQwLzEjwt7w8s1X5e167+zvX79m8q3voX//LtP22qxPf/7eq1f4vY78D320eB8bFx8fGAJEB0dFR8o8Fp1s7RSSQqi8sRSRWWXbP9wMwiqx1Ox96pfd41XDGQkplXU5lVM4KBCWitmYN8Oa6bQR4ngWvHIaMVMWFh4UlVRUWdXWMTSAK8t6e0sG28I6ewNCMs4GF8RHbmACQ5zDe1CXu/qCant6Iend9TEz8GTmsHpvUlg3OSuR1lkAJAampKfGh8TnFhVe9Ed8dAF3hsqrV8sKMV3FeV09ld11DfmJnaiOZr0TXg/gk8kUDfdW383d4QeaK+o2ESW4JRz29uGOb3tu1SOpXLkrEYVOYsCoWj8MVKnca+bhBQsJzmqOCQ9KhEQPR3rNCeQPtDV/Z19Mpf/eu3//LaQLvy/zwAyQlvDSbxEdFRkRGZcIFgdoLKkylVSrVKqVpYVzk21+0yiWnFbFldMa5wwcPxacVVhUllpeOTFBG0YYytJjYR5sZx2N5ZKn2yPDkqIragOCGmaAgBG+wG13WWl4GSi9PjADGhQUGR0a114+CYMO+agpbEkvLqylnoZGlteVFGHrIpuqexoqtncB80W58FSMxPAeSlFRXmtvR1jVaWt3T3wRGVNWAwEV3bPtpQ09ZZlZjehREuKUbqmmY8wl20s/juf18qBEGqKkfYrVWURYV5QbFgd6lnUUSZkEUlCHk0IoGIQpG4EqWYr7RJB6enkiNDPAsHxv0BHFdvXL/+XTt2/8XfezTVz915f+BNv3n79vU/CMjgpGQAMDkmysOBo0LDq6F4JARC5s0pJHM6hUxpXNCZrBIKVWS2zesXlFo9F14cByouySjvrkSSDVp8t0C1hOrnKthwLI1KEhMbE4NDY4vz4wBlJCSkr6GwrLEkJz0gNDsT6B8S7u/rlztMqc8JzBgGwSaB8cBeZU/9YB4+K2CMWZ+DQXbWgPMUeeix+qr49LTM1mZQdttIbQmkrb68pXeC3l7VWEskdncWpRePjNbEJWRPSawWZldqbDkERV+Sn/zqWfetiLoaqKypqN8gZwi5GrON1d7QzzGQsCQJn8ekkWZHx6B4DgeJpPGx3eC+2Dv3AckpuRF/aN+/ffvmje+EZOY7/+zB8a+ffidIb9y5f8/ngfedO9+55p+bHBMeGR0VExcbFhBYOcbg8fgkGpsvEFqUYoVKpVk4YdfU0VR2s1wgZwoWZ2G5yaXNzUVtUO2K1amn4XgWShec4Ub0S5h0sQhe6MnqxMKs/PqZBUo7uCE5w0PgEh+E5aRFhAQE3LsdGjLGK+3KmqoqBU9GRgDIGu5AdVtBJk5VC66/bBvNmejm9tpRqGFgTFEVuCKtEtmdWtQ91FTWUQ+mNGY0jeFHEV0xkYU9Delx0XH9/HklO8mziAC4TMF9/bmz8kFs77SEAqqjLMjIFIlaSmytw0jnVGNwCYMvFAm59NmpCQxzFjHcXALKDY546OObkJidc/8/ZKhHL1y78vuWc/LbH2aVf/D825GDt7Mkv4/cm7EJcVHh4dHRYWGBd71TWmCebiYW8dhciUIoWXQ653QuzUgtSmBf0/FxKJJBTh1M6GQRugY4W4+UZpOCPNZZN0BELVPBDAmNyUFWRAaFhOWmAqqRemNjfVN2WFpOYpyHgqfeexj+MCA43j/dMTCOnmzFATtyoiLLcS+VdUVJUUtsTxMi5bdH9xdBazBTsKHmlNim6rjMlpaCtKySpv7yxqb0xrGKbvjkqGgZDEjIbioAJsRkTSltuqTf+v0V5um5l0eYjmkkDkcZGSfKtGIWXy2ZrqpGa+ZkPXAjSzVvnlfLhBw2jy1TM0cKwv39/QLu3ApPTiu/+h9r3dVr372E+7u3QBZd+S+Oe4GR0eFRsTExUSH3bkZVtze3QBkCiUKtk9Np6rWzNZFdKmJjZ5UW09wMlKK1GfGguj4cbxgtWyfTVQZskvd1r54ZvKAWQmN28dBdUbd9fL3T2qAsDrW/vqEkIz4pNbu2qTwrODLONywkpgg0TkrCFXTCm9LAdZXAcrhMXpqa5V8vx3TCMcTu0rLBqYnWkZGsznJgYUhouUesZKXHNfW3lzSCamd5yM4RpnqNVRgd31SYkgksQeh3Gbc9i3jAW1RVM57vURV7stE+npzLkWsWhGIprhlUPcVwzfTNiSWa+XmdSqycX5CyJltK0+5duXLbx+tWUDgo4MqVq/8vhGK+/Pbbf/3Vw/8KSP+I8IfBoVFxcR49fDcCxmMgpvFkgd66bBESudqNfdGynC/EQTkKwxx7Wry47MJUtbb2c1hkAqUbp1odvOUhqUAOktkKR422UrpLEh94372RS2OoFMTJ0cHOprzMit6WwtaUuKzU8Jj48OSSnslmd1d1TV3+UPJ8WWnXxGBxZJ9PMbUWXODGTvf2IOhjlV19ZcPtqaW5WeUJOTXpvjGdjZV5WcXDeGJ7D1ahXDYg2rNBzQVZ5Q1IyRwk1LOIu/pzboP60RGLLMcRqe1wCQXPZc/gkb1tneNzSolhX680GeQrljW7QcggIjpr8v4Nl+tBd/8zitevf3eg6cbS3/zzP7rC/ysYH0THhoeGRicmxYX7B2ZUdY5Dh3qRZLHWuKhmzwpNVofFZGLLp1BcsZhHnV8yGchTqP7KzhkWGVE9pnqEuu3pb1HEaRl1Dt47Ot4AjIp66P8gDUOi8LlTPZCOtpJGzFhHYUpRZlROamhJdVhUej3+YKkstTNvOISlB6AK8hPiB4Gp442JxfauSQR/bbC7vaZraHCoaaAkpzS1srUTmNdZkVfZVlHZPDAJY6t5y2KVrCIpN7+ipb5nhoxuuHX1epDr4622xad6chd6FjGW3UzsBUMGyuu62lEy5Jpubtmh4khoFOXCAnMWOjbY314Wdff6LZ8bfwyP+353bv4exTsTZ1/uo6P/88uu3vwu+jdjohNi4z05HZ8SHQMnjnWC28HdI0gKk8WkwWcMpqP1pdPFzXnYNGJazLWZ5EYaUTDTk9HAVvNra0WHxLccoVAokGqXCT2jnS0FYYGB4SkDqLHBESK0pK68BtTI6ezry62ryklKjM2fLk2M6WDSjqaqR1tqHiRLwiGZ0Q+y0krC2rqDu2ubxxBsl3h4wsOXaiGjlbWNhWnpZV09jXlJFb0TPFh+n5jBpXC0m8c7kOKcgs7h+nYUXgHzvno159XFbDVbUhfu7R/gG3A30DcsISEqpaoHv62j6VgyhXgGCoUxNYsC/EhLB2wg8t9Z9tX/lM3A9Eiv/3vyMB/Bm2n5I0hfvXb71nfPvR8mJiYAszJCHyQ09XaWpiWlZORXtE8SyTOTcIlpecFo21t4pJgcBY/Bx7onKPBJFJc0UEsw6oaGFtwdns/zaTGusvRaxiC6t6sDEJzeOMoY7esd5xDrm1sqgHk9DX39dW09NZUVyTkwcn9p/eiEYmEGi8m6HQuKK2j1Co++B8weqootaWormJugOEV4/GRReWdnc2N5QVJsA7o9HljZ0AnlY0YJWNL8gn7n8vNPd6Yruj1BPoA0qBvi/W5MHRi6ogorojwU5PqdO3e849IiolpncMbLbQ5HrZaLsYPDMwKlAA4uiI9I8bkdlRl87Y8m5dUH4cG/nzu8HZEc/+CPvu66j4/3jd8xpFs3rl1LLCwvTU8Ija0nMDiUieaKwvzMjMLGLnBNL15lFxuEpg3WmhaOaiqpyolMz6lq6xyCkTSLpKH5l8fZV+9HNEkcTx0GLddgEjNkUCK+lqjH9pCEfOVwUVdNZmnbIDgzH9zX3VmRDyrsmO5Ir6Sv62bWaQFxccPACUB49s07MUWFbfXN9SNTiI6RGcwoBVHY1lNR3AZOT+meHq+dIE2MoyBoEn4MYtzfe/fJxz/9n5/zpqXU8WGyzU5o6/CNcZ5p80OTY72uXPX1jQTV93c1Ta9tbTz78RHPuKpViiGwSTJHQEOiJ0r9vW5cvfUfRjj/KJRXf1snN4ev/5EZ2geB8aG/pTmBSZnBvsDhFRiBgmdAO8qz0lLTk4EZWSmA5PySsspOlHrLrhAY3DzLOoM9mpMD9Pe+9cDfyztjBFZUKvjyvDMor26QsbjxyYZ6df9AL3slh47DJsfHpoUUphXXWDdQ1ToyXJqQ2DfbWdZekQxqgIGj8+jbcxpKXXV3aj+4t7YSdNOvKKdxe7qkvZ8xmNEwMAwXoPoJvUWNyGaPlEPCx3FUJnhcJBLKqQTj2bv29dff/Pqlgbbzi6f246PzySlISM/Fm8Om0IeBt/xaCtFSDZuhdT16fHz6AylhljgAac2pLa2t7hjE8om93fieNP+bV67duvmfyl90SKDP29p29Y7XtRr++z/5+U++kNXd/e30zX9QNncii8M8O3Dt1oPIygkiZpqIwfINc3JxW0ZChIeGe9367UDyHb+kGgIaLdt+Tlk0CMysspy4h7c9W3IjJCw4fGTjI1RkVhOUtvjc/dE72kebq2bFe7BeMgvXA2URJ1FUJBg82NLRURXnGzrCh+anNLW2QUba81r3lDRsdgccHjVRPISvr71e1l68KshoHa+F1ddjEEgdpp1Ca+qE9lZOkNtlrenIeVKzQIJWKfGTKreFrH95eXi2KlF/dHL+7Ox0gQ3PZpz/8tfHiJrScSNBQmcy5nQSJX6sNzcqMtT//v23mXzfL7ZigoxmM2xGrYbakex76/at2/fu/vvXp9duACZIDOZsf67fDY90ziQ7n/7zz97A7wb5XLviFwnMSg6JC/Lz9vEPDwkK8LnvkzQIhRPEAo5AOjcnY9PpupW5mbGR/p7W/NQI/3t3vLxuvx3jvnX77sPE6jG6QilY3V2c6WktDr3t0YpeKfjnPxQlB5WAITO7ryxfvFh5s7tz6tptwbKJ6NHO4a4qKGuyybPT3fV1BVHprSRYdsY4uHysszqr+5DVmNcmHq8IAmYjcf1DacCmxiNcCSa1uBg0QhmEYpqGpyAU2kBFxdh4L6WiGCdFoHEwnIBBgOLIGinFYFhxmeWad7//8gPsyqFRPtJx+O23//BnX718R1ORk5NZUJ7y8N7dO163fzd6fvPGzTv+KYMcoVGxvSJj8wwHC/Th9oq8jNS0eA/ND41MTMspnkQjEP3Z92/dfxAXOG2+/Phyvy+jIjno7tvQvHY3NKa4a5bJkRnNVstwLwKDRULHRodhMwRkZ0WV+4nbZdUrqATMWHcdKDMl1oPuvfved2/f9vIPDg1PqqOg4AT8ZH1pRv7I9g9/sVqcVDBIR+K3XeKnT3c+f/Xuxe7eoETNIk2UF1ZUQThjta1tGC4cOZxT1lpV0lSQXFYzWhGX2yoi1WKWFDBATOJwy2R3Z7N/GeevybIOv7CbOWPFDXVFA4juaaWjJbuxFDbaUTbKGxvjt2CUbLlFjiPwZ6kciVLPn53b+/TxBZx8sGKjIbir73/12T69MTIWAMgqSQv2uuvtE5GUkBAcER0YFwPIKu8kWawq6dnJ0b5KYlgwLGlJw+0t1UWZSZEhEZFxSUExpe1DPRXxudU1ndnDQuuGVZEOm+6qBSXfueEJxbuA9lmpWWPV2mUrGzsH2zsbp++9++z5syfnB7vbKytmnVIosOw8ffH40ZKATIE3trdUJAbeezse7+UfD8xoaOdbXn795//7H/7XdmsVGGqW0TYONHz3xfe//84Ty44DpeSwSbDRwZG+sak+8BBUwId1ZSf2tYZlNmakVTcW5SWXjECny3Fj1qy4+/XFbaIa8NBD+mN1bn+E1/WgnLy84OTRqiY81YHJHBb3Q6pah8amIL0dZJFgefGQTmZOYOFojZyC46uUm++9QKt3D/YOLWoBFj5YlxyZ0VAOhrYVFFUUVo0Q6KpZDA9GEUs1NqvFbOeKHCf7Oxu2lYuTgzefn5l1EiGbTsGSsOMD9blVEBJ1thNKwMx2j9A0awuGRgpieoZIHS/Ozi6FSqmsTaXRIDIdnB5f7G5YVg9ePj062905PD7bdtoWjEaZznW06z5cs+0uk0bHRiY6ahqzox4GJGWl5eYX9WEP/uKXX5ypCGNQiOYxg3shkzJlu58cnK2zHToIFIufhg71zCAROGhJJ5Y43lMWmd5UmtuK7EgqLA8Lzy0uKo9u4wkmghvj++s6K7omxokrWnh+m5dfQlSi/934tOi8cdv0MJHIJRGm6sYHe1FjDcMIJkNpZA2PijGtnf1cHkZoUjHUl1KtW7pyuPb8XasY2tnZC6Nx+W4Hz7BOhEkcB6dG+SoPKxKLTCt6vpDH1e4c7B3sul998eGX3/ztP/3D3/zV3//q/UPriklGJ+FlCzr5AJMuUJAIQo3TbCLrjFyS1OzcWbVtnRxvH6+fPn/67GD35PzsaH1j6/Dx1rpr2bm5ubVlU3B5ZKbBcbCikS3v7QjIMAa/d7qtehzcwKgvqGsZaetiKERsMkcKH2MfylQW0fIiFcuVKra5xA1Y3gQWhe6sHYdDUGxkTbsYPgFNCs+r6IOj8Zmh6dkPfePzejNzW4UFPkmNTfHAuB5Q+zmeg81sDfbNzADcvBUZEgoqN5omCS5Ynd3GoYxPoycQbflNEJ6OTRpFyDDdw1gySr5unMNdGif3DkSbz08ev/rJL1fw0wyNUKg+3HA921Vvr62tbiydn7GEi/ql5QUOcQbJMa64d1Zde49ff/TZj375m3/8y7/81Q8+fHG4YZ03yMzrTjtdtWjUsQQrTvOWUeraXDGa7Vsfn9gOXjlc7u39p++9evX6B5988OL49NHptmXBuGByLM+rlWwGcYYk0c8JJZJNJ4fg4bMTUhhhhU9R4TFTA/2QSQrXE8Jsz7YvLhIsyuUXVgkVguWpWMK94cLhaQa1shPag5ygqLrbZ2Y76nMjsodxOBgJ5O8DyE4Ir8xtJPSmAbziKvuvBFVF37V9yp3rBqVkhgISH4T63Y/KyEHJeNAOgopoVypo0JmOCUxtwbBaQyZiBuCiKSRrnKHVqwVyyXOjaOFwZ/vVi4uPf/LNh+v6Vb3UotEsuV8YNp3760q57v1TlpjBk6vniDQUhCo12KwLlrWd05NXn3355sNPXj8/cVnsdtPinNW9YJYtbju3t3hbx+/tck9//MXe3u7e+pLrYsOg089r7DuXzz74wU+///n77zw/d9t0GrVarZLKuGQsdBIKx5FnmSwNk0+aIRNn9FbF06emc71BODONIEjXF8UaDYU+u30s1CtMl8KVhe6hWShk0uJoa4Ug5M1VY0OjJBjfgW0aHqwZivFrQHf2wIEh0RHheUNFsc2dE/nJIf5N/UXXKwPSkc4P8ARg1ER6WmRcvkeNJFQ3I1EdjdMyFnWCSqBQZ6BS0iTXZGdDpyZRFCyNytFahxkyln7lSKO3nLx553zL9dGPPv/6h69XV06NbJVdZ57ffL4vY6o2X1k96M7w+CQSdghKZsvVSs2i2ek6OL+8ODva33GZ5vR6w9K8zbXhch6ef3D4yvrs5aefvfPxD//kF997ebJktbgWJbI5rcHqPLh894uvvvrk9auLXbtRpREJRHw6g4ydHISMo3AYJFs5McmhQ7Ec9rrMtLOsP1STOWoGbPHUbLIq5xWzrldbqxLZxvycDtJCgtRXQ19qGpq66cjijrFhvJS3fyiqHGCSGmNiG3pry0sjQtL9gkDTlQGpnXHF11OGMhejgYAEYLVWC6uIa+tpjgEkBsRmgcDgSd14e3sFZnZoGsdZdqt4HIZEu0gd5ZHgQsoAfY4o4kBl2rlFy96Ow/jyR1+8t2K7OHS//vTR6tahmihbNC/prFoKUay2O9liHpZMR+CmBvtGYBSBUCDRLNjXNne3t7a2d1esnjZmW7NvbLgvXn710Zefvjl955MPv3j6xU9/+ovvPX/vdNfhNMvkuiWT3b65c/7y/devLk/Wly1yLotI9NDDadQ4dBpK5WKm0DIUBIfX401LOofaumzbXllg2lwCl9lgX1hw6sSubeecAa+SLfKGm8eg7TV1xHdms8p6VMg2DxFQbOycbAq6YKLp9uqG8eHUdGC474PAIvBk0u38xiJMHbqsuCayNjwquRepBVQkZbaWgzLvBsSDkNhRKqE2o6ATMoVBqDVru6RpuVisYTVgOTOIKfCkFtErVM+uKYzSi0fbO3u7H/7mB1tLL9ZMKxvbu+ubS1T1kdu2IOijknhiBU0gZ6BxhNmpoa6hUdgsjc6RaXXzthXnzt7Bodt5fLS7vbO1dfbk9ZtP/+ynX3388sVHn725fP7pD7//wx998smbx49OFo1Gk9XusFrX3Ls7Lqd9Ua/isagEPBo+MdTVNw3FMMlcDofMpE5yrZZ9m2PdbraZt81MpVn78sxpkBjPNwxuh0lEVQwzafPkhqnGmsayxplXVGAtyVMbBuMGbEtOmQxfV9v1dpa1KirIP8zbKzB5LKOrsjyoIbs3O6Ec5FuQ/tC7Nng6EBQeH1Ex0lzudSOwYrSjuDAuKq+xH4bDd7XP7jIZBIGKJYBNz0hwfX0NKFZXu0zOYS3orK4j155z9/nli5cv3jyyLbsfH65s2Q3mLf2adExCmlEJeXSJXkzEEKlTfT09PSMYilCp1mjNZodr+2B/d3tvf/9wb2vv+PEHX/7kl7/85svPX3788cvHz56/+8mnX/3smx+8evfl1vLS0prDtrRoNKh1aoWEz2LxeFw6HjYBnegeG5tCcrkyxgyMgtRubOgWtctrR7uWdQeHYzF+8Gb/Hbzl9emRSbeswghkTBaPDBuaBFQAEf20r3i4fpbp8KAshmPV8cm0ttSEtIaa2tr4YP8bvqEpcfk0GHIsOwQEz08vloPiGvLuRqUl5MWww+OiPbnWdOtOaHJRTEDwg9Sh6ub2YlAvnik2orEaKrZ/mEzyyOrxXjS1rJcp6VPMqjyc55nUdrm9/fSzyw8+fPHs/HzdaFpbNyqEsgGG2tNVOAaBel7KYSH6x0aa2ofgOJZcN2+2Ly3YVnePD917ezvHB+6NraPTz37w/W8+/OLL9y72t1xru4+fv//p1199/sGbN89PXSsbq/Z5pZgnUqllbBqVKZaI2QQYcnQABZnGEGkaAZ3A5jCWlwzKeev81pOTFfey2eR0OpZemlQfPtnZXRBpVDSxSiRQTrROdGQUFFMaJWeCmdFx8clSWcvyAhWOHKjPD0vMz89KiY6N8fGPiPCL2WQFpxVElYPbvCJZ9UBwbkuUDyhxDJ6ZmdyYDC4Kigv1ewjw9w7LHmiMTSiamUEy6KNDFN7gbO2cFoGAYeC1SMZML2PawJw1z/M+f6l6+uGB6/yZ8/X/99XT03PV6vLWmZpHQU9bFxgSpXFRNC9hkpEtiOHefk8g0eg82Zxab3I4rMvrO3vHe3t7myt7m/vvfvzRy9dPn16cnOy5d1w7rvPTy6Pzk0cXx07zglGjVkk4TL5IJmLSGHyhWMpGI+Ao5ASKJRDPa4V8qVm4sLps0Bms8svzC7frE7dBq6auH5veefFqY54j0Ul4CiNHpGiraSvN6Bmd7192dNN6mkl6FFq6xBzrGeqoTA8JTY73v/8wM/3uzfs3r4cY+vyaryj9YjwiHhUf58fqulpWUtg1UZ5UWRNRHQuI9fVLSrx53bs190ECAjHOxZd2VtQgxQKIzAiDIUb7mlrJGgqZT2UzPTTw/FPnzpuX67u7j/Y++/nHj78+Xdp2XRyTWSwMfHGR42E3UuMcHT8zOTk5NIggeuQ0jcZgi5ULZg8LWNBana7tjWWX07axvrx69t7p8dH22srmmuv0+Pzx0aPD/Z3NjXkPSZUIPFrA09QYpBk8hcIWMNH4KRhqhsPlC4wKtcS6IlvZXV2eNxhXXq5fbp9sLFvlYuS++8nByecbYpJ4jk0WaXAkRnNdRWklbdjG1zzKmhrsIbc3ygR8ZFtPf11GyL1b4cCgm2HAfP+rgYEhEeXg0Iybulzvgtu3p1DBdzNIPvG+N0Fd0bn5qbVJgf7FyZGR3j7X7pek5aKnh2lEUGpzLmjOLtMo2Bg4qbUFyWYjiGQOkyyeh7ne3/lg6/zd3UfO97aOf/z9xz//+HTPffzU5VaJyWTrknVZrxKSWGTa7DAWNQlBYAk0JpMtlc9pFqyLBoOnfFssq0t2m8N9vHv09HxvY3fbvuJwubbcu+fHFyc7y8smhVgoFMq4TA6XQ/Pw02k0iUaj0Jk0PJ7L5rLUc3adaXvJdrBk2bEcOD56tPzEeeQy6+Yl2xuW/XnX43U5DU/nYnXSCSykAdzcS2FOLGqlymHS0CQ6r0bO6y2u7AC3A7yv+4TkxtyPCUuIvheSklZbXVsTiEA03/O6UYKvDbnWlhyUeDUAUVcV5ttV4nMjt87P+8oDv3vZUZWjw4PdnaCSjpqaATRCS8CaeZSx9kkcFIGeIIxySBrm0r7jyO0+Pnvv6P0nKy9/9O5ff/L5ofN48/VPT7U2vf5w3bRs1JKRsxj0BIY6A0Nx6bMYIoMtkmlNesWcB6jFBZPNbDaZ1o93LfsOm9O9Zrasude2L06enm+u2c1GpdQTrEwqlUwgURg4NGL67Ww8njSF4AnZDM2cSK+fXzYvuc/0x471Vft/33r1yHl+srZmWX9iUa7pV1/ZxFS8gMveFSCQVT0zFBl3dnzVxURXocaZMx1d9Y2xkaDi5sn0277JwNJon7C7AaDohyk1rfVDuek1kS1pd4AlU5nTKSA/wK10R/9Mi299VVBEEDDax+thuI9/YHb56GR9a3t9fXd57iBWxqKZljD9lQPgdsxM81IlcnZWOqe3upb23Acf759+vrn20UffvP7s0HV+dv7xU6vi0ubesdlNRi6WiiUhCAgEFIYnEZA4OpUrUajlHM6cSikTy0RzUr1xfsPDaQxyy9L66iaFwmAxeAajfWvVpOGJGGQ8kUwk0egiCYWEgQ7BEQj0DI3PIrN1cjp9dt5qcrtffGI6ODrCrr3ZOti6cB45ZwiC5xtzeqnxDYujQ7nFgh0emowWUygqxSzOzkD+BDvR3gWB1ZUl+Za1VAxOl0WmZJRkxsQF3QotSgB0Nw32tgJKb+XBUxETAwNsSklYUlCWvDWvA5haFlCaHJwQcj8kzD/AJyVzgDc82NGYXtUAmnIrpCIJE9KW0djTPisc72qcWmgRayVK59LWk6OLy9UPHtuevvP15x+cPv360fHjj1bUB/tL5xcWs1FIYaF4fP4MfHBwBI3DoLAIkqei8BhULpsiksve3kaCIVo0MvicWYaEL+CZNBIBVyhVyaR6nY7NpBJmUAjMLJ7MFjIREyMjUNg0hkAl00RiPUcgmnfYTRsX569MW7vL48Kvnmxvuhw7B3ie7PDIrnDYv7bg5/ELbPI6E0sSSycVAg1iAE2cXlBgYwtb0/LLo7Oh9SU1Q+UxsaCK5NRIn7shLU21ZYNDXUFdvumAitS+8qrKVmhUZFBmTyMsNbe4PAUU7esb5OsfER38IDaxqGO8upZYmF2V1TqnwHGInS099T04LJWPr8P0K7GERbXh2dHG+auNJ0dnX5mePP/i61fnn/3p/tHufzu3PDmxnX6+qpFxZVIinkfj0xGQMcj4xDSZTCbiZ7AznqDAEchcMYdGovIVKrFoTq9RzuuXdGo5n0HAkih4tlhMn5nF48k4z0HGE7AIGBQFR6AIdDxJwBBI5XqzVScxrn9wdrZg1a7TKX/y6WOn3bD1jkhsvFi1XrqNP1ifXKFoRFS7eHZKze5b0y1x++BqRBertb44PSG7NrQcFFpWUA5MjcxpTs8NuO8d3Z7XiCJQG7N7q8qTO42xiYAQNuhecAql1JTQkFdfkXzv/r1gQGRgaqJXZEZMaiUwbDAvoSijHNKKJ0DKysemSXZ0LxI2hOqdYnB2tMdfPzl9btG/8+Hmr3e3n7346P33P//z072V733tPN+wnb37Qs0TqBdIQ0QxdGoagcbhpidgRDIBg0CjJmFYPM5DvdmkWSprTiYTG+bEMr1Ko5ZwKbipkQkMhjfLos2SiFg0ConCz+BJb++FQyTNztIYRCJTxFaZVhbnOfJ597tHq+ts1aMV3KvXrxeer7/6b0bbmuWJ1fF87+SUvD6tWsIb+WCyAy5+RGBxhpDT9UhcSxogu6wrMSY91C8oOD47JqQZXRwVevNOSba6eai9CFw4jCWhMG3JE+WBIfEPWvPyFXkPbqem3vEOigNlFQCBYSGRDxNT/H0T8mMjUxJyC9JhQ91tgkXP/0akj8tnK3qGKdajrQ9ef/ZaR9n74YuPvzk43L18/5N3f/7VlsP1zdnJpmJ37+WmSKI3LZLGkBQcEoNG4WfRKBQKiSRQkOPjCBScyBbQyEQuXypiyuYXDEqxRGmWMz2aAjmN9UCJhoxM4RHIWZqH+3AYLDGfzaBTCCQGgzJLm1uwLKxo5ULj6rNHB/Mi+8eX3McfXuy4DZsfq21uhWte8Xx+9T2tBqdwEmnkMd4ibVuBnFOgh9eXp5qK0kMBJcVhYSlBd4LDfQJjwmtI9clRdyIKG5fDAaGJwPyJGRm1syFDjUpqikkCP+yuD7pxGxAaVdlVE56Umx0Zk+4TC7jvn5IS7RMUEZUBaofRWctOHGyWL2ZbtZCilnHU0ZMnZ1+dCqzPHz9zf/+9g/XnL9/df/b9I9fSR5+eb3kI4MaOWbtkMBiFeAgcRyLTSSQylUmbRc94mhDJEz90OkskFkvUep1aa7J41IRx0W1WqJQiDpU/J/S0ch6NiiUw2J6uzhdIlHKpWMRl0KgkMteDktY2v6hQzC/++EdG/YL70WeaR5tnF+uG5++ZbSc6glm9uGn/iDKG4yyODGmRNNHCMnycd7RdPdgHBuUUZKUURnqHBN+4m3T3qldWWlxJb36cf1FGIS0xIzQhMiIdr+HVlSSYVuARITnUwbK7V2/HZqNV/SEPonJTQjJBmWmBN/xjovz8g9NBeQ0zbMQUB97UOTotmVUY4A1tQ8qDQ5eKz15/sn/ueP9H62uvPntn23j55dnq5g/f2d08MCwaHc7NJaOZhyUQZikMBofN4Qn4LBqTOIMnkxk8rlQ9J+JJTWt2y/zCssOxvLohn1/b8ECpk2lUJq1sTsBmsAUeWihXanQmo0an/e0VFmkSKrFYt1atXKXa9VK2/uTj4zdHpu33n6+rn1gOhJp3uXq2bmV+l9qAGKoa7JHNqFdQK/1d8pIIR2RZamTpaG1dIzAmKsD71pWb168ERAVHFxZEZMQXNtIKAgub7vtGz5oWI/PLu4n50cG94wOlV+/0jdEldfG3/eJigOmp+cm+t71CEoMe5vZ1VkMYqpHi2pry9vrOoVEpHYoYGZlbcK/CJ937F3unhtOn5N0vPnxzSdt+79GW8/GPzk/2tXSB4/TkdHHBJsBi6WyuQDInV8iVcoVSLCRTeSzPag2aOYlAqtUrNHqFXMJjiZcMeq1IrptTO5fNWzb9nEgklknFnqfnlywW29K8Rsah46kTIwSK5uDRiVUqXZxfY+iPP//io69O9O49/tyahEFBG8wLTKmRrySOo+C9PdPYMbmSA29rn6huMxUE+wCGwPmV4Now/4ww72tv74vo/8AnuiShoAUGKUmIxafdi+tCSNi1bW2g9pKELECXsPj+FKG1DRhz787DqNScJAAgIDo9NcHvQclsT34LBNlTXpCcX5WUXdHGgnb0DE2PiJVsqe71ycmrc8O5Drn79dmTLez6J6dnts3337xc2GCzd59tn17szZPwKKpKrtEYFxeMhvlF87xKqlFKZRq9aV4jVyzYrUuL9tVVjy5fcjuWFpaWN8zrF0eHxy6TWuXhDDKZ7u2XIaurqw6zXs6n4dBwHFa8evHy1KFim1cdjJ3di4/cO987N3I0ggX8KIOrEe4zp+VzqIa2iX7wlLJ61EqAw/K7kOW9wPCQ2FpwGqCsKdQXFHQr/K2t7vqVa1dvBVeA2zuU/cW8goiBvKJOnhje0UfuScmoYfaUZrT2NaSGAXy8A4o7KhMyM8p7ywG+98oxcEByV1NXZV1TRlF0bHIrmQIaaEWmlOIr6WeOVefxc4tHJh0tnxw4yMr9k72DlcdnH+i2N+W77z29eHbqVHFoZKFWqTXZbOYFq23ZYdYatWqlxu5cs5hMyxsbTqtt92Rvx+XeW193OTd21rYuLh4d7y4tGVQKhVJj1C0s2Zyra+urJrWEw2aTp7Bi18cf7Tkdao+GZcks85cra1//elmuWH+Gphn0QsElZ0Y0VV+HwrQXNUtG2/rbxgobiMUVZbG+cc0DwOCSFlBIdtjN2+Fhv3MW3k++nZtWPsxtm44OBUEIuJnpgdFRUmEuDB/f0hdbUhsSm3X9dm6z570lfeDqNEBUPnI0yr8FXADKrspPTCktK+ujdVanNQclTpVAVueJDuejnZ3Hm1b77ppyWe+wag+PXz7+xGV6pFt+9fT82eW6eYE+zfBki9HmsFusy2tOh9m4uLhkX151OtdW19ZWbas7R48uDs6Onpw9enx6fHJwePnoYOPxzpplXq/XLS6alp1rG85Vz/sW1UIhhzoyLH/0ve89OXEsqlXHJsevt9nL7md/+YsPTp99z7Yg2TxkK80WxVRl09BIVXG1UDAFKy3NLgJmNGb7+iZ1DYT6VHbGpZZk+Ny7E3H/5rUr169eiUhIbAgFlRBAPHJ5agdSp+ovHxqDt6QPpaQ29z3ICkxsiYxriQPVNHdAMktBqWntM3UPHlbVJ8a2gWNCCoZy86orCxoj2zJ7G0qHuQr84tNnR2fb59qdD0lq9+rmytzO6aPDd08M23rjycnuq9crJg6JTSezpDq7Z1Gr66try/YFvcHqdNhstuVVh8u94jx49PLZ3rMnnz57+vT08aO9/Uf7h/t7TuvCwvyCadm2srbuWl1xrtoWtAopWwAbUBx9+Cc/+GBPwTKrFc/sf/q3Frpl8+ydFy9WPtybt+45Zi2qtYWBEU4HKCOzBYzjirqaOmILwmoTgmNB/bmBAQWxFb1pGdkBftHhvrduXLniG3sdWQUsqgoKLSZquPK1/eWhiiFNVVlBdFTqWAQgvWW0n11dCWrpr6goKkoIqx2qDvQtK0mMbmIXl0wScjO6Rqqh6QwmpDu/Z9KMNdsPN1xGl3XVyjrc0m3vOZ7bdpZPz2SyaZt90+G4WJTrRdDmXrRn3zzRsbntdi7bTAuLtnXn6uqSxW63rz5yHl48e//Fk/ffvzw9OjnfvXS7D3e3ttY9KnFp0Wx1bLjdTpvDurSgljFncGSBxvbhT7/35eeHWvDQHM95/t6fW2h2y8qF9OSzL+xLhuNdwabZLiQxLXWZ6eC+3MIpLrFkpTuroQ1UWts6VvnwQdRgb3hJcnxqTnJwaFRkQETYPZ/JG3Fp3gHAwG7++kv70CAUr8lMT8z2CKiYzO6RyTXaRHcp3BMdaWGJVVkp8f6RuaCMBhl3+YCUBsLiINzKPkrHeFU3xqTjk9zLaqXDfbxtPN3ZM61cHqrW9O4L+fSQ/Yi7tGxfFMqIQyPDEwi2dnHJueXe3lxetultVk+o2O1ms822vu/ef/H4xav3nr95fOjaP1zf2X966FrdcK54RPeS1exwrTlWbItKvVVFRGFncTMC98effPTmyPnUgcRzKLufX54Z9Bqu03726lI0r3h08Xh9z8Ej9CEGqiuy8rJH6OT6spzi4rJCQAcShx2qK8wtKgFmJsdnd+eH+njf8kmPvoPuZnUBesH9ExJaV05uFUJRX1oZGZMYEtMyMVgNqp6aUwupcFDlVBu6MaI+vqQzt7Oez5eRCFwq9PRCBDc+2jgha0+XVQ6NywrvFDzeoAus6yo0ZHQM0lk/SRPPay1rKytbq2aTp0Esb6yvOS0mTwPZdu0+ff7q/ZcffXR5uOPadTh3jnfXTa4Vu2XJtGiyb1rNFqtWxGazoNCxzt5hNlz14sXz9zc3Dz//8sRpOvuJHLVvX5fbVg/sFs2uxMI/3jQZWkZB9en54JTs6iEkMiXILy4tv7hukjoL6eqcaC3ObiiLCkpuzQ65eeVGQmS8N5aciUjPrqysqoNrKPWFZmJmfFl3aZUcghcP5KTlg/Km6hJLgh8GhJRylxSEgUG6lNrV3FRYOzmq7+vtSESWd2d3kGBC/PQ4mm87kLMWNpf2p5GOzQMxiYZiKHdNlyKsQsmiY4bbx/s7ursJLN380rzRuTmvd64cbzrX1ly2+XmHa9e19/TR0xfvff/JoXvdtWNY21i3ujYsNuu8Si412K3GBaOK55F+8B5wx+gMcWiSsHd+sSqT83S2Pffjk1/216257GymXjokketYPAlxwgBJBuWXRqcU52cUVCMSk7Iz0kvLR5q7x8fhOMxYSUopOCcmuZMwFH7j2s3rgKD6T/r6W6uAmWWjo/X14WWG2hxUW1xNQ3pD53B7MaiwHFKZkhCfnlxHN4gR4xidDtVe11rVOsxd10ma4xv76RAJa1bZBs0dndZa7DuHh25BU7/1x88VE+0zjsOVlW3LMF7OxI3X13fzZgYIrVi6Tq9RzK9bV1zbF5vH+zuXDv2K1bV3dLh3fnJ8+nzftWZftektZuP86ordw0S4TAbNzePzeSQsHN7RXFVfXtnQTmRCJdvm8X44dEDJoxjWfs0eXF1W8hhmeA+VoB6Bi7vKpJ2lqXkj+ZHpscCsrsFpMgsx3VWQmppQWh4sneokggqTq0ENaUlZw6sYfHNwVG0JoGm6LSsvLaN/sL0+K72iF8XgDDfiVXPYvhZ4D0lhlGBHYkKyx+wWHVo4OdZZ2g890Ii3Dza07bXI9392cahirJ7r5pjsUQxzbGSwfwA9TO+T0HsGYViZXGjRbu24N87dzw82t1eXVrbc69v7J8c7ayvurXX3rsNkW9JbFSsrGjmfRCcTlVw+CoYe6esCV7Y1Z0Qnxhdm10CFgpaGseqmQQGpcU5x8ASqYBFFBKGoVLKsmGqGFLYq2+tGavsHQ4Kic3PjgpKLhFA0tSgqJjG+o5f93u7i7FCKf3xUbScoraCKIJyobcgB5jY0VYzioEzhzCSOLWfTBIjWttLQpHaiUCieRpX3tOR0kF4uLXDluPpy0od//zd/+nJVbxQvznV0lE1ompu6B4dmiX1kGpkBa6hHqlUajc3+ZHt3y/14w9PTlt27ewdHJ8euJfuZe2vL7Snw6nntnEEiEZAxKCIOQsEOtre197U1V+QBkwBhyenAdFB7fUlOUdc0cQ7dPkTVrLFgBiqTOKGAI+yXP1sbKe0V8ijwgY6Ohoh7USnAlLzUZEBZ16R0tK0qv2SYzF0+ca6pp+ATPR1dfTA43SobzsssqSmsKssKzxzFQKCcBaOcOV6XGh4aklg7zZjGcsbj0xCSvtTEWiTG3YEaql/+4n/8yU//7ut5MYRxMtY+WzxFS8ifICEpMCGBqaHNgUvqkAq5VG/a2t6yLtgdy9YFg/X40H24Y1XyzduedDVLhR5GLPg/7d1nVFtXvihwJ7Hj3gvFNpjeQXSQkABVQB11CXWhgroQEkUNVUD0ZowBg7Exxb3ihks8boljx8nEk0z63CQzSe5Mkklm7szcPN7Bjj2etd6X9/38Fh9YWrDZZ59d/v+12Hv3OFx2h1rCV1TTmZV0IYMCQ+ak70lMjksrzU9LLijIjEnNrPF5fL3A7N7Wezggb7RpMClYnrimbe7KQY/NPzw2ZEGHbd++Oy0jPjozckdIZFZhZma5AZEDL8ZA0XQ2EVaAJhSjm2d18Aw0gTvdyxk+3aIvzydZO7q7vbSU+DQ4oawCXYwspdWa6VgiBZUVs3XDtqgMBKuKJqs3yRVKBpVaxihHstsVafucxslz99//+J03xw5USYeLqalhZblo33C/XasItugFuoDBpqHJGurdHcGjE919XrvP6rftOzZ/6fTBKbNdF1B7vE6rygwk4NW9J80Gnp6FxlCKi9msckF5dmp6SkpCkbowtYJXlh8XuWWPtaVrYGRk7Mjlqb7f7fXaOpx4MiwM0qDiymxt+Eohh26NXM8IiQgPDYvKzUuNi8jG5mOLY1PLcCl7EvZEIDk0aH4xlcEqLiGJ9cJKElHKL82MXbpdISQyOr0AhqwWlpdyseVsNDx5Z/n1awbfyOztd8/fPDjiK7Ujd4RiRw5bNd65sdHe7iNus6vJHjzU1zkYGDox2X/0+FjA52vS2/lmu7fFW+8lmSx6SV0z3Uh0mNmVphqdil8OQ+fR8GhlFRIriU8rzM1mNGrKEAwWEw1JrXCP2mp0AQVGgN4T7S5MS4PiiHSFrVmQ+fQ8tJSkyF1ZdJmSS24+EcRR2YiMmFdf3Y6avzXT6RnVzZ/peuSp7c6XNpQ0XZp1YHPYRJHG0CRR9Bq4boNKp65V1rGryBQGl0grp+iUFZVIEruJwa4hUCHxbGp1wFQkkAhg+ckZbFXktnhMJSopJEGlUNZSIJCk+ORcsm302uGWsJz0HVkMdfe0r8+vkEraJy3nZiu89D315kDQ40zNcwb6+XRZv4pLheOEdBZQ+7Y6r1JYy5DUVqORbEqRHiJBoggUnpTq7WiDq/h2NA1KFOrNaCyZfMCYFFa8MRQGK5MSoncm5ibEZXVPGTMpvdMGlkTSVGsQcrhiv8fRqK1XCyrgBCQ1IRNnCrg1VQKtAYOS4XOLS9SZ8mJcSgweytDq3+mnsplGg7FfTuN1tYuoeJQVtc7GUzYM2NUolsmCRVYiJVomQYSGVzK4OBSXCC9GwVXuluYWvQaVU52bjIDmYquZVZSoqFwof3RmoSMpTtKmb56tIDWMnRlA7KYdg6GHWaURyY7HPRJhrZLXWAVPKOcScLDSknySBIMtRuOgSUVJheVz2kKygkhKS920NqKQRpNXtvOyUAWGt696enI2JLj2T7g6+TJpndrUxGyeEWra/9CWmOW7999fnG8ffTI9PGLFU8xdR4K13gBux9aE8K0rdsrTNyfZNNn4xn6SsXxtdfy2ZKZQvpSXJCUlwfFaSmYqRlDntKn3CoxqpsGpy4JklRRS4Lkp0bgCMS0ZkpaEZ+BiS1wydCGVhS+CJW9evS2d5zZNUKsknYcu+lytWTtCYf7zveJeWa2rnDkarPv9lc4//rIQ6JjuZqWEpY9+O3/uypGemUe3BrxueSmGmLL0r7Zl9NXRvEO4PU3Tw1xO0StS2fKEZN4YPTMzNjwEmIxMo/tMFSUsE5tb7Z6bUrEqyitluotIaH21TFwvxaIToxD5aXEhCRIZObc0iQahUJn58fcqM7LSceWWFUW7c17f3jL5gQYKY3a7ddIuURaEW20ZrR+a0/mlNEnNF4uL314Nkle+9lp4zfyxmdu35xeu98g5KCittQO1YWkvTZCQ0anoCav4sroTgl7/yrIzxSlpUWm7N0XloNqmZxXpJaaaxi5gzeVB0zNRl6fvvHG41vg6yqIwjVy4c+VQu83kN2HLiNTcsrDizLyYuNByIpwKxWRFplfVpGyBd5JSEYSQMvzBsDT1kSflQhYNRxA4O5tcny2MXeh1DXdwePBopH1uP78/H5qyeiOXXyfE42HqfdNaTd9IXUUEJHtbXpUgYtmyyJFTLW0Cjnd/4u70UgQiYzu0KDcbVVyKyynjX6CiKdF8Vp7/wwVSftFqm8Y9MdPIL11XsHu+05OwO5aM0M4fIpyQkqoICMzebgsbQmaq/Oi8ooIUXuBGac/ohRO35393/7dfvNctFgjp6bt3NtYUUkmessr1q1dA8mD52SUUvkohohSlRe+OjE7KYxhEFER6BqSkksUhFedmpKaW0kSa+iYHkLsenb91987CibG2Rq1UxMPD0XgyHV9SxpAYNRxiOa4C8fl3Sxtq//n1e9dmJ0Ym5i7ee/LFt3/+428O+WuIWTn5GCaXI5A3Dg1ZZXLZ4uLn88MOXlERohSNwWKxZQQqiy+tnfrgr4vvTaoKcvJQdC6XVyXW1jd7qdDkxMS0rFwkkSPXGvVKqVAglik1Zkff7P3vHp/30kl0WZNdp230B9XVUolMrijKSUuQCHlMCgaGL0fBoYVwNA6HRkALCksreGq1Wm9unzl7aa7PY7W4fL5AN4eKhWWnJOyKSoiNCt+2edPmbWExEGQlnUklMYU1de1HTl2YcALTS21T+77Bgb0RIVs2rl+3LjQBUlgEhxfBoLmpMeHAIlwspFfQ+LRyrr796ESz2aTX1HZNHtjX6VOqdXqdRkFkSbhUDBRWQpZq1GI8ND0xCwYthBbBESRJY//ejmaTqlrV2Nrd3+7rqRJzCEXp0aGvL50vsGVPehGGWMmgEbClJdhyDBKDQ+RiOXJTnaUZyOxMSolU2djb5Vv1+vKlPSzLV7y+KjwTxRLKqijInOToqMTsMhatUqQR0uhMJlNsCJ44PRowycRSfWewxQVJT46L2L4xLA3FMTT5zeIySDIQ8zGA/oJHIwpyoCUUia7RarLY20YmJ/rqa3Qmg6nT10PQKPiEgqy8SrF9aHi/R8PGZEbs2Lw1NCq9EJj2acCf4vDFarPd3wrEQl6XVSW3NDtslqDPYWKgkFginVxAVRosOrnZ3WhUCnkcrkAkEfM5TDqLB7xguUKhVGpr7S29w/0uc52l1mhpbLTYWiqZPA4dDclhWjvqJBIxj0GjkvBlWAwaU4an0Dk8ZiWFSCIzeDKtudHusNU3OF2NdSZDXaOj3hUcoJJQ+XmFkNYDjqr8iLi0zFxISmJcQmoWtBRXUY5DlaKxFaRKJptbJZQqgAIcze5mp8PeVG821/o8zdmQtAIcIu3o4SAtIysPRc7bkwIlSvT1jfWmGmkVh8OmV1bSGGwuXyRV6a1Ob8DvtDd7/QGHxaSt91hNRqJA5+g90nnter+WBMNWCoC2rHfaG2uYpamRO7bvjIUgqCImEQMvKkKTeUqTze31+z22Bqe3JeixOVxuT63ZIQNUS4V3bx4PaKR8ma51au5EMz1rx6pXlr2yfOX67RGxwLqQmJiRB8dg0NhyClei1OoNWo3R6utt9zcZay1Nbn9BXmYqMKruvX1lusftDR6cv3nfV5G8ZfXy19dtj06HIrE4ZAkKC8zQMTExqXlFpUgkCktgCpVAhmm0OZqNErWltc2t0xv0Oq3mgwc3L0wPdu4/+ckvl+zQNZt3x2dkZedkZ+fk5kMRpYhiiqiKXZoSH5NRSqRTseVcpd6kVTf427qceouza8Lj63E3GAwG88J3f/vmneODwe75Dz95rNq1eVVkCYlVnpe0Z+kYkZCde6JjInflUjUtTSoGEkWqUhs1apPFaPTuPXCk3+0JdO/f1wvEyvt72/xuR9Obn3z9/T9/P+r0DT/+bpy/e9nyTRHpKXGha1euXL1hK1BYfCY0PyczHUFRt7a6tCwinlXrdTdpq83e7tHelva+sdnJgaDH3zuuIhXk5eJOffDVn778+GrQefDWHz6rT9u0bH1sdGT4tk3r1q5Zu27Dpi3btm/bFpGcU4IoKsGw9c5goMHc5GiqU0oswdETE/093f1Dg71BL1DeSVJBRlJBme7br3739eKXR9udPY//9e39emjMljRScUZKUkpabMi6FUt3tgHDeN2mXUlQIleuqtEYLA6Pz2OvlfJ07sG58YHe7r69A73tXv/4CXtr7/D+kQdfffOnBzPtdRp9+8N/fXNLkZSNoEjVJgEuI2zd0slUq4C6rl61bnN4DASB54qkMolYUBMYHh7qbmnUSoBBp7W37e31uz3+9n0njs0dOzF/8/E7Vya7bNZGm2PgwQ9f36vNx9CMvd3tzOi1z7Ydrdm4PSwsfHdUzNKZgUmpkLxiYFxzRAqDzR/w18nYRDrfEGhtdnoC7d65h599+9aJ1q59bVaLLTDQ7287cv3tByP1rftnzu93wJa2Mi9fmuxWbwmPTobkQRHQvIyE6MjIqNhECByLI1Tpmvs7W+skfK5Ub7W5PIGO3vfevjHmVFlHbk1amnpnb92YGp44+fAPj3/z5juP3x2uTl2+7JWV20I2rl27PiQmB1NBogPDWgAQiqXVEh6jspJZpahtcDVZDSq5TNPg8rZ09J6e6Ak4vUeOHwj2T199961jw4MTD//2y+Jfv/ppccGB2rZu7abQ8JDwOAgcV1aBJ1JorCqBSCTkcxjUpe+FIiArqaTQuQKpvMbY1Oxt7ewbOnXnyb2L/Yce3j1/Ym5mem+DstpyZuk4vz//9I/PbvtwSSGhcdklRBafS0raErIrNjUzvxBamJcNSU/NwdJZwGQi5DOI+AoqV14LTEi+1s7+fdfefHx3YfbQycMDbc12m1khUdjOfbu4+MPDO9fe+/aqn5ubWy4wNxkkVBQ0pxCOKIZD87KycqCl5RS2SMJlMFgyo8VmkIn4qgaXx9cS7Oob8o+dvfngvF7CoVYyqViitKFjbObi0k0BX9y4+84Hn90abaoiESoqCAx2GbBgwQpyIBBIdj6sFI0jVclrlBwSQ2A/0OPVc6VmT3d/b3d3V9fhI1NjQ8NDLotOIWIRqFIFC5sNkR/+dHHx59/fvHr5jYc3jgTkZDQCAc8H4gNYCbCsleFJFBqQI9GYUhWfTmMY2oOt9XKVyRZo7+js6uk7dmb+8sLNQZOEKfd0dgRskoLw1SsS2K3Xvlk6zv/2zTu3b54ebm1uNKsocGgBrJjAlemXjqKW8pkEPFvEodFZ6maXo1ahNgNvx9/W2Td49b1v/rn4EbkgH6Y88e6nbx00wsI3rI3Mg5Z2/2XpEIG/3ZsbaGn2dO4dHd8/2On3efyt7sYadgUiP6cAWUGikskcmcFukPJZsnqns9njD/YMLty4cWHauis0GVV//csfPjnjwu7ZvC6qsAQLz3EtXUHwtwdjjhqJXGcHVoZaoH61RjEFnhIXC8QDaDyRTGUIVVqDuJKE5xmbnMAa0Nre7VGQ8uN2RYSnoOvmP/7vT+Y96J1rV8aRDD289FJe/0f/Z3Hxj9d7TDJ+tcZYK6URMOUkPA4BvKOcolIUjsoVSqVSsZBFIhKZEoPTv3SlTKsSm7h+2fLk7WExlSOP//n14Zr8sK2bwuLRcpmkIhvF733/l8XFf/3usEvNFwM9RQJM/I1WjZhfJa7RAAmhpFouAWIdAhkIMxQ1mvrg4N6+NmXRzvUrtkO2bAkp8V3786f7BUnrV6/csCMuP78gLToNLhu6+fVSm373zvE6AkMg11ldLd19A+0OvUhkqFMJWFSggkQG8PcELIHG1j7Q3+XTlsanF5KSQyLSKJ4L3/30zhA+YvPanSnx0ZuXv7JsxbY0kkhlbZt846Mvv3x4aXbYLiFCszOAh8ZgUUgkupxEqWSwhdXVwJpZY2ruDfo8bi8JVSrz1oYllAgNTbM/AwHrGbsQB88Me/3Z/sEVYUm5sCI0U9txsM9rrZEJ5TqDqUZIwxUXFeNpdKBTirWNAZtJp3EOHwjYXf5eGkeuLogzevy1XNvTCxb+eL2PGb/m6RFbr7/66qtrIzJRwHNR2eoGnZSFJ5K4CrO7taOzvb2jpa6aTeZITW6Xw9M6PrPXa29ubfFryEvnESQ2jx7xc0StF/8KFPnjXVtx1NpVyzfsDtmwYtkr63ZlIaBZ8XvSishSowvo7nwGhVCGLkERmTyhUFjFqRKa/GMX71we8LkdtulRdvTGV1durLxxyW9Qtz5YquO3F1r1jNinG3FXrN+yIzQ0bFdkfNyWVdtiiwWWzqBHx8TkZ2akxifBCFwpt5LN9526dg8Iaq1O5/XZo8c6jeXxSNPeC2f2tzS13vgemM0enBn26pQSHp1cgSmBZqfE7AoNiU4rQGLLkdD8XHg5S26sN3KJBDKn2uwODowfbTdrtTrj+A+I3VvXbNgSj6wZuf7hB9fPnH/jK6B6784dmdzfH2jQiFhkIrmSLZDJhRxGJa4oMyE+IbOYxFdogXGjVUjEJk/fQY21NWBvGB1ZrMrZtvrVV15ds7NA6Jm8dPvRk48/++LjJzMOh9MFaKrTyjhEVFFuemJSclJSSnoODE1icKt4Sm+P21pvC+7r4/Oqa63W/oH+vy+ebeFAQlcCpa3YnIDRDl7+6Ks///Hz9+5cPTvZY1MxMcAqHh8bmwApQGBILKFCpaoWsGlkAkPXHOgaPTIxrKyWMMuIHcG21r//z+LPD0fUxLzk2D27d0Wm0lynPvngt4/e+u2nf/jqw3unhwI2a4OzrdNp0iolfBa1rDgvIyU5FVJE1XTNHBlvrjGpBFQU0tPscDbf//3Su/vf987u81lUQoHec/D6O59/9P5Hf/jmh7/+9O2nb1+a6mm2aGtkdAwUAskAvtIzMnOgBENrsKVeWU7lCKvVRoVSD6zox0c87QOjRy69+9WPP37x4PhgT/fMzcdffPrh47tXT89NHTl25uLCjSuT7Q1yJg6DxBGoTK5AXG0Kdtdy8cWIYgyBXa0RicTaJqfTZ8zYsmb1htAkJJVSnp+Snl0GrARXfv/94j++vHuk1+cODk7MHT9+oNuhkXJ5Armh3uVva/M3yStLU4EAHFaqABIlq8fnqxfjC2K3rfr1ftgNUTBObffk+fuffPPjzz9///WHdy9Mj00dnZ0+ND42sm+wp91nr69VcalkIjR1z86Q3VyltQ4IpoGAvZqARRYXFQA5YNTuiMiYxJIqU+vktcdffPfXH7/75N65Q4M9Hd39A4N93a3NVo2UxyADET9PIQXy3sj6eo1IrjFarNaptrjwzRs2bN4Rvmt32I7NG7aGJSM41s5Dp6++8cbCqcmBFmDmNipF9DJ4dkZaRk5hMUXXiMxOjY+O2GW3N+kkCg3QuXXTvQXRW1a99mxX8lI0tzsdTqQCCQuZp27eOw1E3ffvL5zZ55ThC5Njo6Ji4xNjQzesfO215atVRrPFqNYZNXK54qPD0eE7Nq1+sWl+5dYkdEVZUWp8fHopQ213t00ufPSvX37507tneqxiWgU8LTYmNj4pLbNC3RIMmgXKWq1MKv1o+JWVG8OiYqI2/nrUxqtr9pSQqMjk3TujYZUcSV3r6Kl7X/zln1/ePT7YvbddX8Wm4dEYXFFugaRr36SVzBCJv1nIyszOLSjMTtm18dlpEa+sCsnIz4gL3RYJhH+J8bFRydlUy9i9R29MmKr4AgGfVUnly6pYXJF9pKtZTlj8u4JPq0AW5efnZyTs3LzyaQlb9iSnpsbtXA000etALL1xSzxWs/f0wslWo07JLaZKdUoxA88QtJybX1w86ORAE0LDd617vlf+tR3ppZi0nRtXrtmwHrB1V2opXW52tg0Od6fkYXhKHrkkD01TexcX/3K9m58TuwOSDcMw+DQCmaa0W5/O1TeHaqGwtCxEJY+KJzGNrb7mXy/I+WS6u6lWo6s1qquFXDoRDS/My8lMAV7QurVhmTiegE7AlMALC9BClYhFqqACU5RK//xynX98eXuqz9fs9re1t7X4vR6nmo1HlKDLyRRSBbq4CMPXGUjcKiYZWwKMpaX4fvGn57/6zcPTY51eu9VsMtWaDGq5VCwSsshlqDKaxFyvliCpNdVEWGpCag6qskr+0mVGf3n7ZL9dJySWlFOFWmfPwbOXr5+fGnDrgbXFLK4oSI5NykQQeYuL7V3djuoqPpdGQMKKikUkBAyBY0m1WhG9QsgH0q3oLauXvbZxZ/hmeJFI8J+fbNgeDwVy02J5dXW1lE/Ii966+rV1oUC4tDUmpxBTPjRxaHR0cnp64t5nj45W28ZOzmGJbKVWq5ZRYUMHpo/euTQ0oZ2tN139CYvGlItrDO99d3Zg+PpCgEsjlaNKDs5fvv/pZzIxn1O3953FxcuynBxg2ZZLjb+8LUyHcBwSiVRp1rKQ2SlJ8KSta9auXblqU3RGblEZ3+z2ueTtd+YPd9SKq4C6Tf3tzEyHqjBdwmYHXP+FJ0iCo+cO69Fo9PhZT7NXX2+tU9YZRUQCgXC422QaaLdRmWRm3fDZs0CU1BsQK4ZH3u6t7RsxkSkUCpAvGOs8B6avTLEYcauWLpTHA3J7J04eHxjaE5sCA5QCik4uzPToVbAS4pKcJW7b8YmLE3ZP5tOPiJAloxfOnzt6oNM+dnj2mbSnhq9PT8xPBFwj49Zn0p+aO3H4QgNHeG4g4ZmsZ+4cvXhXZ1Am73ym4FePfzszdaBJkvpc0XPv3+ofGJXjkOxfUZ+7cKw14JRnIWniX8FfGPI2IKJ25OEpuc+kvDA6NBbYuh5JJKKX5P3b8aPXxzXpCWgSZ6ls1EvmZm+cbyFXAh29Zqklyl8yO3Nsrr2qxKriVFYAzU0hvWT88IBLxcBTMEICCYdaulAZR/w3d7+DR6SJKAQxpFSiFT57gBfPXORmlbFVGpmaTDFVlDJ/fXLsC4NKntZp45ci+R5XUjJJ/xT7BW91jVZncLSZGqePWDiNwcFJQM0LGkEwaOQ3nB7pOzrTVOVuUvEAjc/VWq7cHqthKZ3BFl9DrSls+1Jeu9LzXNuBN98+7jNYbA06vVqhd1m3rHmq9YWpY1euznS1H++11nnthsbJ+6eftWP3czcuXbt0wGHZ3+dqaB/oHTp62sNb6oSlsy+8+eH9CZvK1NnrAvJNt7dRXBq/HXDj386eP3ZweLCvx240qFRSWnGJWEJ42m8fvWTo8Olj+1t9fZ1+u04jwcXtgrMlS8/Ku/Oykbn794/5jQ6Xvcnf767KT0dmJjx7C8dfduXuh58/WRgLyviu81Pi5NA0PIuOf2rkZZ98dv/W3fvnumqM41d0EcuWrdtTWtPx1MDLJjqcnbMLJwPdc+fdmdt2JKYnJJeqntK+rDw9BSo7cPPNWyeD+OToVERxcU5C5FO0l1no+TnCM19/f9zTbLUJ4Ikhu3eFRzxFfdnjt86Mzf7mmF+p6Tt9c6+SjBNozZZnKC+7dufLh7MeWoW+pUleZ21w6TQ8/NMOjPuPH+sZe3h7ysUTTj867t976NSpBnrijugl/1G3Wx9/9ODReweN9oO3n3x+c7xVyhQZbQDeyxYXr+8/9uRSLaqIXu1wt/TZ9ZIqvvBl3/9wd3JkVAfTdKkLYcSG0yfHLawXI/8pg8p+7f3JCph9tKn9/jVrYiic1EJ4GbKq7+rnP74pC5yam1148l+/HVcXv4Qobe+aePDzSXPDpU/P9LTuG8H8WycTL9BbArfdHEOrR1yS6aG/cFKBr2kJNh24MikuqbJ1YLnPzZyd2Dt5aaH3/LtvHGpxMn41fu3yaOfQ3L7+U1/9ZarseRuNdw5N7GvxzcwcPtQjUjwzeRVIJf73H//z08fnfE81TD56Y9xjd7eMXBlecmr2wkEbh640uvcv+ez2m797c6Zral/fko/fOH30yKFjC0NuwHj//v0Bm3e8Rb3k4zP9wb5jJ0VLHt152riiCWBKorC5MpPdYVGYemYn/Bqpw1Bj6T40ODb/7u3hgamLF3rNhu7b19//80cTfVN3ntw5bYAWFPL0Flu732LrHetv1qtbB81sXv+xYycvn2jvOjAzf22iSeG69PV3N/r2jY/tJWTGZ1FMda6WYNegz95x9exBj0zUNtZr5P+/P10GAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQP///i9j648DFboFAA==";

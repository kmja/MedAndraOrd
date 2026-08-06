import React, { useEffect, useRef, useState } from 'react';

// The real rule checks, not a copy of them. server/util.js is pure — no node
// imports — so the browser can run the same function the server does. That
// matters: a second implementation here would drift, and the one place it
// would show is a clue the client waves through and the server then rejects.
//
// The server still runs these; it stays authoritative. This is only so an
// obviously illegal clue never starts the reveal animation.
import { checkClueCode } from '../../server/util.js';

// A request that never settles leaves the reveal animation running forever,
// which reads as the game being broken rather than as a request being slow.
// The server has its own deadline; this is the backstop for everything below
// it — a dropped connection, a sleeping phone, a proxy that goes quiet.
const REQUEST_TIMEOUT_MS = 40_000;

// Both mean the same thing to a player: the request never came back, so no
// attempt was spent. Distinguished from an HTTP error, where the server did
// answer and its message is worth showing.
class UnreachableError extends Error {}

async function api(path, options) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), REQUEST_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      signal: abort.signal,
      ...options,
    });
  } catch (err) {
    // A timeout, a dropped connection, a sleeping phone, an offline tab — the
    // browser reports these as a bare TypeError, and "Failed to fetch" is not
    // something to show anyone.
    throw new UnreachableError(abort.signal.aborted ? 'timeout' : 'network');
  } finally {
    clearTimeout(timer);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || 'Något gick fel.');
  return body;
}

const chars = (s) => [...String(s ?? '')];

// Mirrors clueLength() on the server: whitespace is free, so spacing a clue
// out for readability never costs a point. The server is still authoritative.
const clueLength = (s) => chars(s).filter((c) => !/\s/u.test(c)).length;

// Only these cost an attempt, so only these become cards. Mirrors
// costsAttempt() in server/game.js.
const isAttempt = (entry) => entry?.type === 'correct' || entry?.type === 'wrong';

/**
 * How the player stands among today's solvers, in words.
 *
 * This sentence counts PLAYERS, while the board below it ranks CLUES —
 * identical clues share one row, so the two numbers legitimately differ. It
 * must therefore never print a bare place number: "Plats 6 av 7" sitting above
 * a row marked "4" reads as a bug. Beaten-players and percentile are both
 * player-based statements, and neither can contradict a row.
 *
 * The percentile is also only used where it means something: a percentage out
 * of three players is noise, and "bland de 86 % bästa" is flattery dressed as
 * a statistic. Small fields and bottom halves get the plain count instead.
 */
function standingText(standing) {
  if (!standing) return null;
  const { rank, total } = standing;
  if (total <= 1) return 'Först idag!';
  if (rank === 1) return `Bäst idag — av ${total} spelare`;

  const beaten = total - rank;
  const pct = Math.max(1, Math.round((rank / total) * 100));
  if (total >= 10 && pct <= 50) return `Du är bland de ${pct} % bästa idag`;
  if (beaten > 0) return `Bättre än ${beaten} av ${total} spelare idag`;
  return `Du klarade dagens ord — av ${total} spelare`;
}

/**
 * The length meter: one segment per character, with two live marks on it —
 * where the field is, and where the best clue of the day sits.
 *
 * Both are things to race. A fixed "par" mark used to sit here instead of the
 * record, but a constant is a weaker target than the actual score to beat, and
 * with the limit now set per word there is no single number that means the
 * same thing across the bank.
 *
 * The marks are labelled but not numbered: the exact figures are on the board
 * and in the counter, and repeating them here made a 10px strip carry three
 * numbers that had to be read to be understood.
 */
// What each round of the guesser loop did, for the one verdict that cannot
// explain itself. Collapsed by default: a player who just wants to try again
// should not have to read a log, but "the AI gave no valid answer" is otherwise
// indistinguishable from "the AI was asked once and we gave up".
const STEP_TEXT = {
  wrong_length: (s) => `gissade ”${s.guess}” — ${s.letters} bokstäver, skulle vara ${s.wanted}`,
  not_a_word: (s) => `gissade ”${s.guess}” — inte ett svenskt ord`,
  not_base_form: (s) => `gissade ”${s.guess}” — böjd form, inte grundform`,
  unreadable: (s) => `svarade ”${s.reply}” — gick inte att läsa som ett ord`,
  blank: () => 'inget svar från modellen',
  repeat: (s) => `föreslog ”${s.guess}” igen — redan prövat`,
  stuck: () => 'inga nya förslag kvar — samma ord om igen',
  deadline: (s) => `tiden tog slut (${(s.budgetMs / 1000).toFixed(0)} s)`,
};

function TraceDetails({ trace }) {
  if (!trace?.length) return null;
  return (
    <details className="trace">
      <summary>Vad hände?</summary>
      <ol>
        {trace.map((s, i) => (
          <li key={i}>
            <span className="trace-round">Försök {s.round + 1}</span>
            {' '}
            {(STEP_TEXT[s.event] ?? (() => s.event))(s)}
            {s.tookMs != null && <span className="trace-ms"> ({(s.tookMs / 1000).toFixed(1)} s)</span>}
          </li>
        ))}
      </ol>
      <p className="trace-foot">
        {/* Two different endings, and saying the wrong one is worse than
            saying nothing: "it tries again" under a list that stops early
            reads as the retry being broken. */}
        {trace.at(-1)?.event === 'stuck'
          ? 'AI:n upprepade ett redan avvisat ord, så vi slutade fråga i stället för att vänta i onödan.'
          : 'AI:n får en rättelse efter varje felaktig gissning och försöker igen.'}
      </p>
    </details>
  );
}

function LengthMeter({ length, max, average, record }) {
  const pctOf = (n) => `${Math.min(100, (n / max) * 100)}%`;
  const over = length > max;
  return (
    <div className="meter" aria-hidden="true">
      <div className={over ? 'meter-track is-over' : 'meter-track'}>
        {Array.from({ length: max }, (_, i) => (
          <span key={i} className={i < length ? 'seg on' : 'seg'} />
        ))}
        {record != null && record <= max && (
          <span className="mark mark-record" style={{ left: pctOf(record) }}>
            <b>rekord</b>
          </span>
        )}
        {average != null && average <= max && (
          <span className="mark mark-avg" style={{ left: pctOf(average) }}>
            <b>snitt</b>
          </span>
        )}
      </div>
    </div>
  );
}

const ALPHABET = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZÅÄÖ'];

/**
 * The answer row. While the guess is in flight every square cycles letters like
 * a reel; when it lands the reels stop left to right, one square at a time.
 *
 * `revealed` is how many squares have stopped. null means "not spinning" —
 * a settled row from an earlier attempt.
 */
function LetterRow({ word, tone = 'answer', length, size, spin = 0, revealed = null, rowRef }) {
  const target = word ? chars(word.toUpperCase()) : null;
  const n = target ? target.length : (length ?? 0);
  const spinning = (i) => revealed !== null && i >= revealed;
  // The square that stopped on this tick. Giving only that one a landing
  // animation is what makes the reveal read as one letter at a time rather
  // than as a row that resolves at once.
  const justLanded = (i) => revealed !== null && i === revealed - 1;

  return (
    <div
      ref={rowRef}
      className={`row row-${tone}${size ? ` row-${size}` : ''}`}
      style={{ '--n': n }}
      aria-label={word || `${n} bokstäver`}
    >
      {Array.from({ length: n }, (_, i) => (
        <span
          key={i}
          className={`box${spinning(i) ? ' is-spinning' : ''}${justLanded(i) ? ' is-landing' : ''}`}
          style={{ '--i': i }}
          aria-hidden="true"
        >
          {spinning(i)
            ? ALPHABET[(spin * 7 + i * 11) % ALPHABET.length]
            : (target ? target[i] : '')}
        </span>
      ))}
    </div>
  );
}

/** The AI's answer, centre stage, with the clue that produced it as an eyebrow. */
function ResponseCard({ entry, pending, clue, letterCount, latest, children, spin = 0, revealed = null, rowRef }) {
  const settling = revealed !== null && entry;
  const tone = pending || settling ? 'pending' : entry.type === 'correct' ? 'correct' : 'wrong';
  return (
    <article className={`response response-${tone}${latest ? ' is-latest' : ''}`}>
      <p className="eyebrow">
        <span className="eyebrow-label">Din ledtråd</span>
        <span className="eyebrow-clue">{pending ? clue : entry.clue}</span>
      </p>

      <div className="answer">
        <LetterRow
          word={pending ? undefined : entry.guess}
          length={letterCount}
          tone={tone}
          size={latest ? 'big' : undefined}
          spin={spin}
          revealed={pending ? 0 : revealed}
          rowRef={rowRef}
        />
        {tone === 'correct' && (
          <span className="sparkles" aria-hidden="true">
            {Array.from({ length: 10 }, (_, i) => <i key={i} style={{ '--s': i }} />)}
          </span>
        )}
      </div>

      {pending || settling ? (
        <p className="verdict thinking">AI:n gissar<i>.</i><i>.</i><i>.</i></p>
      ) : entry.type === 'correct' ? (
        <p className="verdict verdict-win">Rätt! <strong>{entry.score} tecken</strong></p>
      ) : (
        <p className="verdict verdict-miss">Inte rätt ord</p>
      )}

      {/* How the AI read the clue. Only after the reels have stopped — during
          the settle it would announce the answer the animation is still
          spelling out. Absent when the model didn't supply one. */}
      {!pending && !settling && entry.why && (
        <p className="reasoning">”{entry.why}”</p>
      )}

      {children}
    </article>
  );
}

/**
 * The footnote under a clue: who wrote it, and how many people did.
 *
 * Rows are grouped by clue, so several players can share one — and the best
 * clue of the day is the likeliest to be shared, which is exactly the row
 * where names are worth reading. Names are listed with the count still
 * carried, because a player who never set a name is on the row but not in
 * the list, and a count that disagreed with the names would look like a bug.
 */
function namesText(row) {
  const names = row.names ?? [];
  const missing = row.count - names.length;
  if (!names.length) return row.count > 1 ? `${row.count} spelare` : null;
  const listed = names.slice(0, 3).join(', ');
  const rest = names.length - Math.min(names.length, 3) + missing;
  if (rest > 0) return `${listed} +${rest}`;
  return listed;
}

function Leaderboard({ rows, standing, compact, capped = true }) {
  const text = standingText(standing);

  // On the win card the board is a reward, not a directory: show the top few
  // and the player's own row, even when that row is far down the list.
  let shown = rows;
  let appended = false; // true only when the player's row was pulled up
  if (compact && rows.length > 6) {
    const top = rows.slice(0, 5);
    const mine = rows.find((r) => r.you);
    appended = Boolean(mine) && !top.includes(mine);
    shown = appended ? [...top, mine] : top;
  }

  return (
    <div className={compact ? 'board board-compact' : 'board'}>
      {text && <p className="standing">{text}</p>}
      <h2>Topplista idag</h2>
      {rows.length === 0 ? (
        <p className="muted">Ingen har klarat dagens ord ännu.</p>
      ) : (
        <ol className="leaderboard">
          {shown.map((row, i) => (
            <li
              key={`${row.rank}-${i}`}
              className={`${row.you ? 'is-you' : ''}${appended && i === shown.length - 1 ? ' after-gap' : ''}`}
            >
              <span className="lb-rank">{row.rank}</span>
              <span className="lb-main">
                {/* The clue is the interesting part — how they did it. */}
                {'clue' in row ? (
                  <span className="lb-clue">{row.clue || <em className="muted">(okänd)</em>}</span>
                ) : (
                  <span className="lb-clue lb-hidden">••••••</span>
                )}
                {(row.count > 1 || row.you || row.names) && (
                  <span className="lb-by">
                    {[row.you && 'din ledtråd', namesText(row)].filter(Boolean).join(' · ')}
                  </span>
                )}
              </span>
              <span className="lb-score">{row.score}</span>
            </li>
          ))}
        </ol>
      )}
      {rows.length > 0 && !('clue' in rows[0]) && (
        <p className="lb-locked">
          {/* With no attempt cap the second half of this sentence is simply
              untrue — nobody ever runs out — and promising a reveal that
              cannot arrive is worse than the shorter line. */}
          {capped
            ? 'Ledtrådarna visas när du klarat ordet — eller när dina försök är slut.'
            : 'Ledtrådarna visas när du klarat ordet.'}
        </p>
      )}
    </div>
  );
}

/**
 * The win. A solve is the end of a round, not another card in a list, so it
 * takes over the screen: the clue-writing flow stops and this is the only
 * thing to respond to. Carrying on to shave a character is then a deliberate
 * choice rather than the default.
 */
// The server sends null for attemptsLeft when the game is uncapped (Infinity
// does not survive JSON). Everywhere that asks "may they play again?" has to
// treat null as yes — read as a number it is 0, which would lock the input and
// tell everyone they were out of attempts.
const canPlayOn = (attemptsLeft) => attemptsLeft == null || attemptsLeft > 0;
const attemptsPhrase = (attemptsLeft) =>
  (attemptsLeft == null ? 'obegränsat antal försök' : `${attemptsLeft} försök kvar`);

/**
 * Put your name on the board, from the moment it is worth putting there.
 *
 * The win is the only point where a name means anything — before it there is
 * no row to attach it to — so it is asked for here and nowhere else. Saving is
 * optimistic about nothing: the board only updates once the server has taken
 * the name, because the server sanitises it and may hand back something other
 * than what was typed.
 */
function NameForm({ name, maxLength, onSave }) {
  const [value, setValue] = useState(name ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);

  // A name set in an earlier round arrives after this component mounts.
  useEffect(() => { setValue(name ?? ''); }, [name]);

  async function submit(event) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await onSave(value);
      setSaved(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="name-form" onSubmit={submit}>
      <label htmlFor="player-name">
        {name ? 'Ditt namn på topplistan' : 'Skriv ditt namn på topplistan'}
      </label>
      <div className="name-row">
        <input
          id="player-name"
          value={value}
          maxLength={maxLength}
          placeholder="Valfritt"
          autoComplete="name"
          onChange={(e) => { setValue(e.target.value); setSaved(false); }}
        />
        <button type="submit" className="ghost" disabled={saving || value === (name ?? '')}>
          {saving ? 'Sparar…' : 'Spara'}
        </button>
      </div>
      {error && <p className="name-error">{error}</p>}
      {saved && !error && (
        <p className="name-ok">{value.trim() ? 'Sparat.' : 'Namnet är borttaget.'}</p>
      )}
    </form>
  );
}

function WinDialog({
  win, word, attemptsLeft, leaderboard, standing, name, maxNameLength, onSaveName,
  onImprove, onClose, dialogRef,
}) {
  return (
    <dialog ref={dialogRef} className="win-dialog" onClose={onClose} aria-labelledby="win-title">
      {win && (
        <div className="win-inner">
          <div className="win-burst">
            <span className="sparkles" aria-hidden="true">
              {Array.from({ length: 14 }, (_, i) => <i key={i} style={{ '--s': i }} />)}
            </span>
            <p className="win-kicker">{win.improved ? 'Nytt bästa idag' : 'Rätt!'}</p>
            <p className="win-score"><strong>{win.entry.score}</strong> tecken</p>
            {/* Solving it again with a longer clue is still a solve, but the
                score on the board is the shortest one — say so, or the big
                number here reads as their result. */}
            {!win.improved && win.prevBest != null && win.entry.score > win.prevBest && (
              <p className="win-note">Ditt resultat står kvar på {win.prevBest} tecken.</p>
            )}
          </div>

          <p className="win-clue">
            <span className="label">Din ledtråd</span>
            <span>{win.entry.clue}</span>
            <span className="win-arrow" aria-hidden="true">→</span>
            <span className="win-word">{word}</span>
          </p>

          <h2 id="win-title" className="visually-hidden">
            Rätt! {win.entry.score} tecken.
          </h2>

          <Leaderboard rows={leaderboard} standing={standing} compact />

          <NameForm name={name} maxLength={maxNameLength} onSave={onSaveName} />

          <div className="win-actions">
            {canPlayOn(attemptsLeft) ? (
              <>
                <button type="button" onClick={onImprove}>
                  Försök bli kortare
                </button>
                <button type="button" className="ghost" onClick={onClose}>
                  Klart för idag
                </button>
                {attemptsLeft != null && <p className="win-note">{attemptsLeft} försök kvar</p>}
              </>
            ) : (
              <>
                <button type="button" onClick={onClose}>Stäng</button>
                <p className="win-note">Inga försök kvar — nytt ord imorgon.</p>
              </>
            )}
          </div>
        </div>
      )}
    </dialog>
  );
}

// Shown once, on a first visit. The rules already live in the footer, but a
// rulebook is not how anyone learns a game — the worked example is, so it does
// the teaching and the prose stays out of its way.
//
// The example word is deliberately NOT from the bank. Teaching the game with a
// real target would hand the player a free answer the day it came round.
function IntroDialog({ dialogRef, onClose }) {
  return (
    <dialog ref={dialogRef} className="intro-dialog" onClose={onClose} aria-labelledby="intro-title">
      <div className="intro-inner">
        <h2 id="intro-title">Så funkar Ordknapp</h2>

        <ol className="intro-steps">
          <li>Du får ett ord. Skriv en ledtråd som får en AI att gissa det.</li>
          <li>AI:n har aldrig sett ordet. Den ser bara din ledtråd och hur många bokstäver ordet har.</li>
          <li><strong>Kortast vinner.</strong> Mellanslag räknas inte. Du har fem försök.</li>
        </ol>

        <div className="intro-example">
          <span className="label">Till exempel</span>
          <p className="intro-word">kompass</p>
          <p className="intro-clue">
            <span className="label">Din ledtråd</span>
            <span>visar norr</span>
          </p>
          <div className="row row-correct" style={{ '--n': 7 }} aria-hidden="true">
            {[...'KOMPASS'].map((c, i) => (
              <span key={i} className="box" style={{ '--i': i }}>{c}</span>
            ))}
          </div>
          <p className="intro-score">Rätt — <strong>9 tecken</strong></p>
        </div>

        <p className="intro-rules">
          Ledtråden ska gå att läsa som svenska — inte en uppräkning av lösa ord.
          Du får inte använda ordet självt, dess böjningar eller de spärrade orden,
          och inga rim- eller stavningstrick. Otillåtna ledtrådar kostar inget försök.
        </p>

        <button type="button" onClick={onClose}>Sätt igång</button>
      </div>
    </dialog>
  );
}

/**
 * Make the dialog appear to grow out of the letters it is about.
 *
 * A modal is positioned by the browser, so it cannot simply be anchored to
 * something on the page. Instead: measure where the answer row is, measure
 * where the dialog landed, and hand the difference to a keyframe as the
 * starting transform. The dialog then travels from the row to its own place
 * rather than arriving from nowhere.
 *
 * If the row is gone — reopened later from the solved panel — there is nothing
 * to grow from, and the plain entrance is the honest fallback.
 */
function growFrom(dialog, source) {
  dialog.classList.remove('is-growing');
  if (!source || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  // The row is a block element and stretches to its container, so its own rect
  // is far wider than the letters in it. Measure the squares instead, or the
  // dialog appears to grow from something the eye never identified as the
  // source.
  const boxes = source.querySelectorAll('.box');
  const first = boxes[0]?.getBoundingClientRect();
  const last = boxes[boxes.length - 1]?.getBoundingClientRect();
  if (!first || !last) return;
  const from = {
    left: first.left,
    top: first.top,
    width: last.right - first.left,
    height: first.height,
  };

  const to = dialog.getBoundingClientRect();
  if (!from.width || !to.width) return;

  dialog.style.setProperty('--grow-x', `${(from.left + from.width / 2) - (to.left + to.width / 2)}px`);
  dialog.style.setProperty('--grow-y', `${(from.top + from.height / 2) - (to.top + to.height / 2)}px`);
  // Scaled from the row's width, but capped well below 1. A wide, short row and
  // a tall dialog cannot both be matched by one uniform scale, and taking the
  // width literally gave ~0.85 — a grow too small to read as a grow. The cap
  // keeps the movement legible; the offset is what carries the "from here".
  dialog.style.setProperty('--grow-scale', String(Math.max(0.15, Math.min(0.6, from.width / to.width))));
  dialog.classList.add('is-growing');
}

// localStorage throws in some privacy modes, and a tutorial is not worth a
// blank page — treat any failure as "not seen yet" and carry on.
const INTRO_KEY = 'ordknapp_intro_seen';
const introSeen = () => {
  try { return localStorage.getItem(INTRO_KEY) === '1'; } catch { return false; }
};
const markIntroSeen = () => {
  try { localStorage.setItem(INTRO_KEY, '1'); } catch { /* nothing to do */ }
};

export default function App() {
  const [state, setState] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [clue, setClue] = useState('');
  const [pendingClue, setPendingClue] = useState(null);
  const [history, setHistory] = useState([]); // newest first
  const [notice, setNotice] = useState(null);
  const [practice, setPractice] = useState(null);
  const [spin, setSpin] = useState(0);
  const [settling, setSettling] = useState(null); // { entry, revealed }
  const [invalid, setInvalid] = useState(false);
  // The win is kept after the dialog closes, so it can be reopened from the
  // solved panel without replaying the round.
  const [win, setWin] = useState(null);
  const [winOpen, setWinOpen] = useState(false);
  const [introOpen, setIntroOpen] = useState(() => !introSeen());
  const [improving, setImproving] = useState(false);
  const inputRef = useRef(null);
  const dialogRef = useRef(null);
  const introRef = useRef(null);
  const solvedRef = useRef(null);

  // The reels turn for as long as anything is unresolved.
  const spinning = pendingClue !== null || settling !== null;
  useEffect(() => {
    if (!spinning) return undefined;
    const id = setInterval(() => setSpin((t) => t + 1), 70);
    return () => clearInterval(id);
  }, [spinning]);

  // Reels stop left to right, then the verdict lands.
  useEffect(() => {
    if (!settling) return undefined;
    const total = chars(settling.entry.guess ?? '').length;
    if (settling.revealed >= total) {
      const id = setTimeout(() => {
        setHistory((h) => [settling.entry, ...h]);
        // The celebration waits for the last reel: opening it earlier would
        // give away the answer the animation is still spelling out.
        if (settling.celebrate) {
          setWin({ entry: settling.entry, ...settling.celebrate });
          setWinOpen(true);
          setImproving(false);
        }
        setSettling(null);
      }, 180);
      return () => clearTimeout(id);
    }
    const id = setTimeout(() => setSettling((s2) => s2 && { ...s2, revealed: s2.revealed + 1 }), 200);
    return () => clearTimeout(id);
  }, [settling]);

  // The intro waits for the state to load, so it opens over a rendered page
  // rather than over "Laddar…".
  useEffect(() => {
    const d = introRef.current;
    if (!d) return;
    if (introOpen && !d.open) d.showModal();
    else if (!introOpen && d.open) d.close();
  }, [introOpen, state]);

  // Drive the native dialog from state, so Esc and the buttons agree.
  useEffect(() => {
    const d = dialogRef.current;
    if (!d) return;
    if (winOpen && !d.open) {
      d.showModal();
      // After showModal, so the dialog has a box to measure against.
      growFrom(d, document.querySelector('.response.is-latest .row'));
    } else if (!winOpen && d.open) {
      d.close();
      d.classList.remove('is-growing');
    }
  }, [winOpen]);

  // A refused clue buzzes the field, the way a form rejects a bad phone number.
  function buzz() {
    setInvalid(true);
    setTimeout(() => setInvalid(false), 520);
  }

  useEffect(() => {
    api('/api/state')
      .then(setState)
      .catch((e) => setLoadError(e.message));
  }, []);

  if (loadError) return <div className="shell"><p className="error">{loadError}</p></div>;
  if (!state) return <div className="shell"><p className="muted">Laddar…</p></div>;

  const active = practice ?? state;
  const busy = pendingClue !== null;
  const inFlight = busy || settling !== null;
  const outOfAttempts = !practice && !canPlayOn(state.attemptsLeft);
  const clueLen = clueLength(clue);
  const tooLong = clueLen > state.maxClueLength;
  const attempts = history.filter(isAttempt);
  const solved = attempts.some((h) => h.type === 'correct');
  // The score to beat. Row 1 is rank 1, so its score is the day's best. Scores
  // are public even while the clues are hidden — the board already prints them
  // — so marking it gives nothing away that isn't on screen already.
  const dayRecord = state.leaderboard?.[0]?.score ?? null;
  const canPlay = !outOfAttempts && !busy && settling === null;
  // Once the word is solved the round is over. Writing another clue is opt-in,
  // via the dialog or the solved panel.
  const showForm = Boolean(practice) || !solved || (improving && !outOfAttempts);

  async function submit(e) {
    e.preventDefault();
    const text = clue.trim();
    if (!text || tooLong || busy || outOfAttempts) return;

    // Checked here as well as on the server, purely so the reveal does not
    // start for a clue that cannot possibly reach the model. Building
    // suspense and then throwing it away is worse than an immediate no.
    const refused = checkClueCode(text, active.word, active.forbidden, state.maxClueLength);
    if (refused) {
      setNotice({ kind: 'rejected', text: refused.reason });
      buzz();
      inputRef.current?.focus();
      return;
    }

    setPendingClue(text);
    setNotice(null);
    setClue('');
    try {
      const body = practice
        ? { clue: text, practice: true, wordIndex: practice.wordIndex }
        : { clue: text };
      const res = await api('/api/clue', { method: 'POST', body: JSON.stringify(body) });
      const entry = { clue: text, ...res.result };
      // Read against the score before this submission, so "nytt bästa" means
      // they actually beat themselves rather than merely solved it again.
      const celebrate = entry.type === 'correct' && !res.practice
        ? { improved: state.best != null && entry.score < state.best, prevBest: state.best }
        : null;
      // A guess gets the reel-stop treatment; everything else resolves at once.
      if (isAttempt(entry) && entry.guess) setSettling({ entry, revealed: 0, celebrate });
      else setHistory((h) => [entry, ...h]);
      if (!res.practice) {
        setState((s) => ({
          ...s,
          attemptsLeft: res.attemptsLeft,
          best: res.best,
          leaderboard: res.leaderboard,
          standing: res.standing ?? s.standing,
          dayAverage: res.dayAverage ?? s.dayAverage,
          solvers: res.solvers ?? s.solvers,
        }));
      }
      // Free outcomes never become cards — they are notices by the input.
      if (entry.type === 'rejected') {
        setNotice({ kind: 'rejected', text: entry.reason });
        setClue(text); // let them edit rather than retype
        buzz();
      } else if (entry.type === 'ai_failure') {
        setNotice({ kind: 'ai_failure', guess: entry.guess, trace: entry.trace });
        buzz();
      }
    } catch (err) {
      // A timeout is not the same as an error, and saying so matters: the
      // player needs to know whether that attempt was spent. It was not — the
      // server only counts an attempt once it has a verdict to return.
      setNotice(err instanceof UnreachableError
        ? { kind: 'timeout', text: err.message }
        : { kind: 'error', text: err.message });
      setClue(text);
      // Only here. In `finally` this ran the moment the request returned —
      // which on the happy path is the moment the reveal STARTS — so it
      // cancelled the animation and threw the answer away before it was ever
      // committed to history.
      setSettling(null);
      buzz();
    } finally {
      // Always, on every path. This is what stops the reels when a request
      // fails; on success the settle effect owns the rest of the sequence.
      setPendingClue(null);
      // After the re-render, not before: the field is still disabled at this
      // point (canPlay is false while a request is in flight) and focusing a
      // disabled input silently does nothing. On a failure the clue is left in
      // the box, so this is the difference between retrying with one keypress
      // and having to click first.
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }

  /**
   * Save the display name and refresh the board so the change is visible where
   * it matters. The server sanitises, so what comes back is what gets stored —
   * showing the typed text instead would be a lie the next reload corrects.
   */
  async function saveName(raw) {
    const { name } = await api('/api/name', {
      method: 'POST',
      body: JSON.stringify({ name: raw }),
    });
    const fresh = await api('/api/state');
    setState((prev) => ({ ...prev, ...fresh, name }));
  }

  // Reopening the round: close the celebration and put the cursor back where
  // the next clue goes.
  function startImproving() {
    setWinOpen(false);
    setImproving(true);
    setNotice(null);
    setTimeout(() => inputRef.current?.focus(), 0);
  }

  // The dialog's opener is inside a form that unmounts on a win, so the native
  // focus restore has nowhere to go and drops to <body>. Hand focus to the
  // panel that replaced it instead. Fires for Esc and the buttons alike.
  function closeIntro() {
    setIntroOpen(false);
    markIntroSeen();
    setTimeout(() => inputRef.current?.focus(), 0);
  }

  function closeWin() {
    setWinOpen(false);
    setTimeout(() => solvedRef.current?.focus(), 0);
  }

  async function randomize() {
    setNotice(null);
    try {
      const w = await api('/api/random');
      setPractice(w);
      setHistory([]);
      setClue('');
      inputRef.current?.focus();
    } catch (err) {
      setNotice({ kind: 'error', text: err.message });
    }
  }

  function backToToday() {
    setPractice(null);
    setHistory([]);
    setClue('');
    setNotice(null);
  }

  const attemptsLabel = practice
    ? 'Övningsläge — inga försök räknas'
    : outOfAttempts
      ? 'Inga försök kvar idag'
      : solved
        ? `Går det kortare? ${attemptsPhrase(state.attemptsLeft)}`
        : attemptsPhrase(state.attemptsLeft).replace(/^o/, 'O');

  return (
    <div className="shell">
      <header>
        <h1>Ordknapp</h1>
        <div className="subhead">
          <p className="tagline">Skriv en ledtråd. AI:n gissar. Kortast vinner.</p>
          <button type="button" className="how-to" onClick={() => setIntroOpen(true)}>
            Hur funkar det?
          </button>
        </div>
      </header>

      <main className="card">
        <div className="puzzle">
          <span className="label">{practice ? 'Övningsord' : 'Dagens ord'}</span>
          <p className="target">
            {active.word}
            {/* Always shown, nouns included. It is the same fact the guesser
                is given, so putting it on screen keeps the two in step — and
                labelling only the unusual classes made their absence the
                signal, which is a worse way to say "noun". */}
            {active.wordClass && <span className="word-class">{active.wordClass}</span>}
          </p>
          <div className="forbidden">
            <span className="label">Får inte användas</span>
            <span className="chips">
              {active.forbidden.map((f) => <span key={f} className="chip">{f}</span>)}
            </span>
          </div>
        </div>

        {/* The round is over — nothing to write until they choose to. */}
        {!showForm && (
          <div className="solved-panel">
            <p className="solved-line">
              Klarat på <strong>{state.best} tecken</strong>.
            </p>
            {canPlayOn(state.attemptsLeft) ? (
              <button type="button" ref={solvedRef} onClick={startImproving}>
                Försök bli kortare{state.attemptsLeft != null && ` · ${state.attemptsLeft} försök kvar`}
              </button>
            ) : (
              <p className="muted">Inga försök kvar. Nytt ord imorgon.</p>
            )}
            {win && (
              <button type="button" className="ghost" onClick={() => setWinOpen(true)}>
                Visa resultatet
              </button>
            )}
          </div>
        )}

        {/* The input lives at the top: each answer is pushed down beneath it. */}
        {showForm && (
        <form onSubmit={submit} className={inFlight ? 'clue-form is-away' : 'clue-form'} aria-hidden={inFlight}>
          <p className={outOfAttempts ? 'attempts attempts-out' : 'attempts'}>{attemptsLabel}</p>
          <div className="input-row">
            <input
              ref={inputRef}
              value={clue}
              onChange={(e) => setClue(e.target.value)}
              placeholder={outOfAttempts ? 'Nytt ord imorgon' : 'Din ledtråd…'}
              className={invalid ? 'is-invalid' : undefined}
              disabled={!canPlay}
              autoFocus
              maxLength={60}
              aria-label="Din ledtråd"
            />
            <button type="submit" disabled={!canPlay || !clue.trim() || tooLong}>
              {busy ? 'Skickar…' : 'Testa'}
            </button>
          </div>
          <div className="meta-row">
            <span className={tooLong ? 'counter over' : 'counter'}>
              <strong>{clueLen}</strong> / {state.maxClueLength} tecken
            </span>
            {/* The player's own score, not the day's best — the board below
                shows that. Labelling this one "Bäst idag" put two different
                numbers under the same word and read as a bug. */}
            {!practice && state.best != null && (
              <span className="best">Ditt bästa: {state.best}</span>
            )}
          </div>
          <LengthMeter
            length={clueLen}
            max={state.maxClueLength}
            average={practice ? null : state.dayAverage}
            record={practice ? null : dayRecord}
          />
        </form>
        )}

        {notice && (
          <div className={`notice notice-${notice.kind}`} role="status">
            {notice.kind === 'rejected' && (
              <><strong>Otillåten ledtråd.</strong> {notice.text} <em>Kostade inget försök.</em></>
            )}
            {notice.kind === 'ai_failure' && (
              <>
                <strong>AI:n gav inget giltigt svar</strong>
                {notice.guess ? <> (<s>{notice.guess}</s>)</> : null}.{' '}
                <em>Kostade inget försök — prova igen.</em>
                <TraceDetails trace={notice.trace} />
              </>
            )}
            {notice.kind === 'timeout' && (
              <>
                <strong>
                  {notice.text === 'timeout'
                    ? 'Det tog för lång tid.'
                    : 'Ingen kontakt med servern.'}
                </strong>{' '}
                <em>Kostade inget försök — prova igen.</em>
              </>
            )}
            {notice.kind === 'error' && notice.text}
          </div>
        )}

        <div className="responses" aria-live="polite">
          {busy && (
            <ResponseCard
              pending
              clue={pendingClue}
              letterCount={active.letterCount}
              latest
              spin={spin}
            />
          )}
          {settling && (
            <ResponseCard
              entry={settling.entry}
              clue={settling.entry.clue}
              letterCount={active.letterCount}
              latest
              spin={spin}
              revealed={settling.revealed}
            />
          )}
          {/* The board is no longer nested here: a win opens the dialog, and
              the page keeps one board, in one place, below. */}
          {attempts.map((entry, i) => (
            <ResponseCard
              key={attempts.length - i}
              entry={entry}
              letterCount={active.letterCount}
              latest={!busy && i === 0}
            />
          ))}
        </div>

        {state.practiceEnabled && (
          <div className="practice-controls">
            {practice ? (
              <button type="button" className="ghost" onClick={backToToday}>
                Tillbaka till dagens ord
              </button>
            ) : (
              <button type="button" className="ghost" onClick={randomize}>
                Öva på ett slumpat ord
              </button>
            )}
          </div>
        )}
      </main>

      {/* One board, always in the same place — locked before the solve,
          revealed after it. The dialog shows a copy for the moment itself. */}
      {!practice && (
        <section className="card">
          {state.durable === false && (
            <p className="warn">Ingen databas är kopplad — resultaten försvinner när servern startar om.</p>
          )}
          <Leaderboard rows={state.leaderboard} standing={state.standing} capped={state.maxAttempts != null} />
        </section>
      )}

      <IntroDialog dialogRef={introRef} onClose={closeIntro} />

      <WinDialog
        dialogRef={dialogRef}
        open={winOpen}
        win={win}
        word={state.word}
        attemptsLeft={state.attemptsLeft}
        leaderboard={state.leaderboard}
        standing={state.standing}
        name={state.name}
        maxNameLength={state.maxNameLength}
        onSaveName={saveName}
        onImprove={startImproving}
        onClose={closeWin}
      />

      <footer>
        <details>
          <summary>Regler</summary>
          <ul>
            <li>
              Högst <strong>{state.maxClueLength} tecken</strong>. Gränsen sätts per ord —
              svårare ord får mer utrymme — och mellanslag räknas inte.
            </li>
            <li>Kortast vinner. Sikta under dagens snitt, och gå på rekordet om du kan.</li>
            <li>Svenska ord. Inga bokstaverings- eller rimtrick.</li>
            <li>
              Ledtråden ska hänga ihop språkligt — ett ord, en sammansättning
              eller en fras. En uppräkning av fristående ord (”rep gnista damm”)
              räknas inte. Antalet ord spelar ingen roll: ”blött plask” är en fras
              och går bra.
            </li>
            <li>
              Beskriv ordet — peka inte bara ut det. Ett ordled som ska fyllas i
              till en sammansättning (”skit…”) räknas inte. Sammansättningar som
              faktiskt beskriver saken är däremot fina.
            </li>
            <li>Inte ordet självt, dess böjningar eller de spärrade orden.</li>
            <li>Inga översättningar av ordet till andra språk. Kända exempel går bra — ”etna” för vulkan.</li>
            <li>Otillåtna ledtrådar och AI-missar kostar inget försök.</li>
            <li>Poäng = antal tecken i din kortaste lyckade ledtråd. Lägre är bättre.</li>
            <li>Andras ledtrådar visas först när du klarat ordet eller gjort slut på försöken.</li>
          </ul>
        </details>
        <p className="fineprint">AI:n ser bara din ledtråd och hur många bokstäver ordet har — aldrig ordet.</p>
      </footer>
    </div>
  );
}

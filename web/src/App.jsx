import React, { useEffect, useRef, useState } from 'react';

async function api(path, options) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    ...options,
  });
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
function LetterRow({ word, tone = 'answer', length, size, spin = 0, revealed = null }) {
  const target = word ? chars(word.toUpperCase()) : null;
  const n = target ? target.length : (length ?? 0);
  const spinning = (i) => revealed !== null && i >= revealed;

  return (
    <div
      className={`row row-${tone}${size ? ` row-${size}` : ''}`}
      style={{ '--n': n }}
      aria-label={word || `${n} bokstäver`}
    >
      {Array.from({ length: n }, (_, i) => (
        <span
          key={i}
          className={spinning(i) ? 'box is-spinning' : 'box'}
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
function ResponseCard({ entry, pending, clue, letterCount, latest, children, spin = 0, revealed = null }) {
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

      {children}
    </article>
  );
}

function Leaderboard({ rows, standing, compact }) {
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
                {(row.count > 1 || row.you) && (
                  <span className="lb-by">
                    {[row.you && 'din ledtråd', row.count > 1 && `${row.count} spelare`]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                )}
              </span>
              <span className="lb-score">{row.score}</span>
            </li>
          ))}
        </ol>
      )}
      {rows.length > 0 && !('clue' in rows[0]) && (
        <p className="lb-locked">Ledtrådarna visas när du klarat ordet — eller när dina försök är slut.</p>
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
function WinDialog({ win, word, attemptsLeft, leaderboard, standing, onImprove, onClose, dialogRef }) {
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

          <div className="win-actions">
            {attemptsLeft > 0 ? (
              <>
                <button type="button" onClick={onImprove}>
                  Försök bli kortare
                </button>
                <button type="button" className="ghost" onClick={onClose}>
                  Klart för idag
                </button>
                <p className="win-note">{attemptsLeft} försök kvar</p>
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
          Du får inte använda ordet självt, dess böjningar eller de spärrade orden.
          Inga rim- eller stavningstrick. Otillåtna ledtrådar kostar inget försök.
        </p>

        <button type="button" onClick={onClose}>Sätt igång</button>
      </div>
    </dialog>
  );
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
    const id = setTimeout(() => setSettling((s2) => s2 && { ...s2, revealed: s2.revealed + 1 }), 130);
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
    if (winOpen && !d.open) d.showModal();
    else if (!winOpen && d.open) d.close();
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
  const outOfAttempts = !practice && state.attemptsLeft <= 0;
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
        setNotice({ kind: 'ai_failure', guess: entry.guess });
        buzz();
      }
    } catch (err) {
      setNotice({ kind: 'error', text: err.message });
      setClue(text);
      buzz();
    } finally {
      setPendingClue(null);
      inputRef.current?.focus();
    }
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
        ? `Går det kortare? ${state.attemptsLeft} försök kvar`
        : `${state.attemptsLeft} försök kvar`;

  return (
    <div className="shell">
      <header>
        <h1>Ordknapp</h1>
        <p className="tagline">Skriv en ledtråd. AI:n gissar. Kortast vinner.</p>
        <button type="button" className="how-to" onClick={() => setIntroOpen(true)}>
          Hur funkar det?
        </button>
      </header>

      <main className="card">
        <div className="puzzle">
          <span className="label">{practice ? 'Övningsord' : 'Dagens ord'}</span>
          <p className="target">
            {active.word}
            {/* Only for verbs and adjectives. The bank is mostly nouns, so
                labelling those too would be noise — and "springa" being both a
                verb and a noun is exactly when the player needs to be told. */}
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
            {state.attemptsLeft > 0 ? (
              <button type="button" ref={solvedRef} onClick={startImproving}>
                Försök bli kortare · {state.attemptsLeft} försök kvar
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
          <Leaderboard rows={state.leaderboard} standing={state.standing} />
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

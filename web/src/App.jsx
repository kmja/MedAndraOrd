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

// Only these cost an attempt, so only these take a slot. Mirrors
// costsAttempt() in server/game.js.
const takesSlot = (entry) => entry?.type === 'correct' || entry?.type === 'wrong';

/**
 * A row of crossword squares. Each box carries its index so CSS can stagger
 * the reveal — the letters land one after another rather than all at once.
 */
function LetterRow({ word, tone = 'answer', length }) {
  const letters = word ? chars(word.toUpperCase()) : Array.from({ length: length ?? 0 }, () => '');
  return (
    <div
      className={`row row-${tone}`}
      style={{ '--n': letters.length }}
      aria-label={word || `${length} bokstäver`}
    >
      {letters.map((letter, i) => (
        <span key={i} className="box" style={{ '--i': i }} aria-hidden="true">{letter}</span>
      ))}
    </div>
  );
}

/** The two halves of one exchange: what you said, what the AI answered. */
function Exchange({ clue, entry, pending, letterCount }) {
  return (
    <div className="exchange">
      <div className="turn turn-you">
        <span className="turn-label">Din ledtråd</span>
        <span className="turn-body clue-text">{clue}</span>
      </div>

      <div className={pending ? 'turn turn-ai is-pending' : 'turn turn-ai'}>
        <span className="turn-label">AI:ns gissning</span>
        <span className="turn-body">
          {pending ? (
            <>
              <LetterRow length={letterCount} tone="pending" />
              <span className="thinking">Tänker<i>.</i><i>.</i><i>.</i></span>
            </>
          ) : (
            <>
              <LetterRow
                word={entry.guess}
                tone={entry.type === 'correct' ? 'correct' : 'wrong'}
                length={letterCount}
              />
              {entry.type === 'correct' ? (
                <span className="verdict verdict-win">
                  Rätt! <strong>{entry.score} tecken</strong>
                </span>
              ) : (
                <span className="verdict verdict-miss">Inte rätt ord</span>
              )}
            </>
          )}
        </span>

        {/* Burst from the centre of the guess row, once it has landed. */}
        {entry?.type === 'correct' && (
          <span className="sparkles" aria-hidden="true">
            {Array.from({ length: 10 }, (_, i) => (
              <i key={i} style={{ '--s': i }} />
            ))}
          </span>
        )}
      </div>
    </div>
  );
}

function Slot({ number, entry, pendingClue, letterCount, used }) {
  const state = pendingClue ? 'pending' : entry ? entry.type : used ? 'used' : 'empty';
  return (
    <li className={`slot slot-${state}`}>
      <span className="slot-num" aria-hidden="true">{number}</span>
      <div className="slot-body">
        {pendingClue ? (
          <Exchange clue={pendingClue} pending letterCount={letterCount} />
        ) : entry ? (
          <Exchange clue={entry.clue} entry={entry} letterCount={letterCount} />
        ) : used ? (
          <span className="slot-placeholder">Använt försök</span>
        ) : (
          <span className="slot-placeholder">Ledigt försök</span>
        )}
      </div>
    </li>
  );
}

export default function App() {
  const [state, setState] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [clue, setClue] = useState('');
  const [pendingClue, setPendingClue] = useState(null);
  const [history, setHistory] = useState([]); // newest first
  const [notice, setNotice] = useState(null); // free outcomes + errors
  const [nameInput, setNameInput] = useState('');
  const [practice, setPractice] = useState(null);
  const inputRef = useRef(null);

  useEffect(() => {
    api('/api/state')
      .then((s) => {
        setState(s);
        setNameInput(s.name || '');
      })
      .catch((e) => setLoadError(e.message));
  }, []);

  if (loadError) return <div className="shell"><p className="error">{loadError}</p></div>;
  if (!state) return <div className="shell"><p className="muted">Laddar…</p></div>;

  const active = practice ?? state;
  const busy = pendingClue !== null;
  const outOfAttempts = !practice && state.attemptsLeft <= 0;
  const clueLen = clueLength(clue);
  const tooLong = clueLen > state.maxClueLength;
  const solved = history.some((h) => h.type === 'correct');

  // Slots are the page's spine: every attempt the player has, in order.
  // Scoring entries fill them oldest-first; the server's attemptsLeft is
  // authoritative, so attempts made in an earlier session show as "used"
  // even though this session has no transcript for them.
  const scoring = history.filter(takesSlot).slice().reverse();
  const maxSlots = practice ? Math.max(scoring.length + 1, 1) : state.maxAttempts;
  const used = practice ? scoring.length : state.maxAttempts - state.attemptsLeft;
  const offset = Math.max(0, used - scoring.length);

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
      setHistory((h) => [entry, ...h]);
      if (!res.practice) {
        setState((s) => ({
          ...s,
          attemptsLeft: res.attemptsLeft,
          best: res.best,
          leaderboard: res.leaderboard,
        }));
      }
      // Outcomes that cost nothing never take a slot — they are notices.
      if (entry.type === 'rejected') {
        setNotice({ kind: 'rejected', text: entry.reason, clue: text });
      } else if (entry.type === 'ai_failure') {
        setNotice({ kind: 'ai_failure', guess: entry.guess, clue: text });
      }
      if (entry.type === 'rejected') setClue(text); // let them edit it
    } catch (err) {
      setNotice({ kind: 'error', text: err.message });
      setClue(text);
    } finally {
      setPendingClue(null);
      inputRef.current?.focus();
    }
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

  async function saveName(e) {
    e.preventDefault();
    const name = nameInput.trim();
    if (!name) return;
    try {
      const res = await api('/api/name', { method: 'POST', body: JSON.stringify({ name }) });
      setState((s) => ({ ...s, name: res.name, leaderboard: res.leaderboard }));
    } catch (err) {
      setNotice({ kind: 'error', text: err.message });
    }
  }

  return (
    <div className="shell">
      <header>
        <h1>Ordknapp</h1>
        <p className="tagline">Skriv en ledtråd så att AI:n gissar ordet. Kortast vinner.</p>
      </header>

      <main className="card">
        <div className="puzzle">
          <div className="puzzle-head">
            <span className="label">{practice ? 'Övningsord' : 'Dagens ord'}</span>
            {!practice && (
              <span className="attempts-count">
                {state.attemptsLeft} av {state.maxAttempts} försök kvar
              </span>
            )}
          </div>
          <LetterRow word={active.word} tone="answer" />
          <div className="forbidden">
            <span className="label">Får inte användas</span>
            <span className="chips">
              {active.forbidden.map((f) => (
                <span key={f} className="chip">{f}</span>
              ))}
            </span>
          </div>
        </div>

        <ol className="slots" aria-live="polite">
          {Array.from({ length: maxSlots }, (_, i) => {
            const entry = i >= offset ? scoring[i - offset] : undefined;
            const isPending = busy && i === used;
            return (
              <Slot
                key={i}
                number={i + 1}
                entry={entry}
                pendingClue={isPending ? pendingClue : null}
                letterCount={active.letterCount}
                used={i < used}
              />
            );
          })}
        </ol>

        {notice && (
          <div className={`notice notice-${notice.kind}`} role="status">
            {notice.kind === 'rejected' && (
              <>
                <strong>Otillåten ledtråd.</strong> {notice.text}{' '}
                <em>Kostade inget försök.</em>
              </>
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

        <form onSubmit={submit} className="clue-form">
          <div className="input-row">
            <input
              ref={inputRef}
              value={clue}
              onChange={(e) => setClue(e.target.value)}
              placeholder={outOfAttempts ? 'Inga försök kvar idag' : 'Din ledtråd…'}
              disabled={busy || outOfAttempts}
              autoFocus
              maxLength={60}
              aria-label="Din ledtråd"
            />
            <button type="submit" disabled={busy || outOfAttempts || !clue.trim() || tooLong}>
              {busy ? 'Skickar…' : 'Testa'}
            </button>
          </div>
          <div className="meta-row">
            <span className={tooLong ? 'counter over' : 'counter'}>
              {clueLen} / {state.maxClueLength}
            </span>
            {!practice && state.best != null && (
              <span className="best">Bäst idag: {state.best} tecken</span>
            )}
          </div>
        </form>

        {solved && !outOfAttempts && <p className="muted note">Klarat! Går det med färre tecken?</p>}
        {outOfAttempts && <p className="muted note">Nytt ord imorgon.</p>}

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

      {!practice && (
        <section className="card">
          <h2>Topplista</h2>
          {state.durable === false && (
            <p className="warn">Ingen databas är kopplad — resultaten försvinner när servern startar om.</p>
          )}
          {state.leaderboard.length === 0 ? (
            <p className="muted">Ingen har klarat dagens ord ännu.</p>
          ) : (
            <ol className="leaderboard">
              {state.leaderboard.map((row) => (
                <li key={row.rank}>
                  <span className="lb-rank">{row.rank}</span>
                  <span className="lb-name">{row.name}</span>
                  <span className="lb-score">{row.score}</span>
                </li>
              ))}
            </ol>
          )}
          <form onSubmit={saveName} className="name-form">
            <input
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              placeholder="Ditt namn på topplistan"
              maxLength={20}
              aria-label="Ditt namn på topplistan"
            />
            <button type="submit" className="ghost" disabled={!nameInput.trim()}>Spara</button>
          </form>
        </section>
      )}

      <footer>
        <details>
          <summary>Regler</summary>
          <ul>
            <li>Högst {state.maxClueLength} tecken. Mellanslag räknas inte.</li>
            <li>Svenska ord. Inga förkortningar eller bokstaveringstrick.</li>
            <li>Inte ordet självt, dess böjningar eller de spärrade orden.</li>
            <li>Inga översättningar av ordet till andra språk.</li>
            <li>Otillåtna ledtrådar och AI-missar kostar inget försök.</li>
            <li>Poäng = antal tecken i din kortaste lyckade ledtråd. Lägre är bättre.</li>
          </ul>
        </details>
        <p className="fineprint">AI:n ser bara din ledtråd och hur många bokstäver ordet har — aldrig ordet.</p>
      </footer>
    </div>
  );
}

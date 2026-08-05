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

/**
 * A row of crossword squares. The answer is shown filled — the player already
 * knows it; it's the AI that's blind — and each guess lands in its own row
 * below, so right and wrong read as two rows to compare rather than as prose.
 */
function LetterRow({ word, tone = 'answer', length }) {
  const letters = word ? chars(word.toUpperCase()) : Array.from({ length: length ?? 0 }, () => '');
  return (
    // --n drives the grid track count so squares shrink to fit rather than
    // wrapping onto a second line — the bank goes up to 9 letters.
    <div
      className={`row row-${tone}`}
      style={{ '--n': letters.length }}
      aria-label={word || `${length} bokstäver`}
    >
      {letters.map((letter, i) => (
        <span key={i} className="box" aria-hidden="true">{letter}</span>
      ))}
    </div>
  );
}

export default function App() {
  const [state, setState] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [clue, setClue] = useState('');
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState([]);
  const [flash, setFlash] = useState(null);
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
  const outOfAttempts = !practice && state.attemptsLeft <= 0;
  const clueLen = chars(clue.trim()).length;
  const tooLong = clueLen > state.maxClueLength;
  const solved = history.some((h) => h.type === 'correct');

  async function submit(e) {
    e.preventDefault();
    const text = clue.trim();
    if (!text || tooLong || busy || outOfAttempts) return;
    setBusy(true);
    setFlash(null);
    try {
      const body = practice
        ? { clue: text, practice: true, wordIndex: practice.wordIndex }
        : { clue: text };
      const res = await api('/api/clue', { method: 'POST', body: JSON.stringify(body) });
      setHistory((h) => [{ clue: text, ...res.result }, ...h]);
      if (!res.practice) {
        setState((s) => ({
          ...s,
          attemptsLeft: res.attemptsLeft,
          best: res.best,
          leaderboard: res.leaderboard,
        }));
      }
      if (res.result.type !== 'rejected') setClue('');
      inputRef.current?.focus();
    } catch (err) {
      setFlash(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function randomize() {
    setFlash(null);
    try {
      const w = await api('/api/random');
      setPractice(w);
      setHistory([]);
      setClue('');
      inputRef.current?.focus();
    } catch (err) {
      setFlash(err.message);
    }
  }

  function backToToday() {
    setPractice(null);
    setHistory([]);
    setClue('');
    setFlash(null);
  }

  async function saveName(e) {
    e.preventDefault();
    const name = nameInput.trim();
    if (!name) return;
    try {
      const res = await api('/api/name', { method: 'POST', body: JSON.stringify({ name }) });
      setState((s) => ({ ...s, name: res.name, leaderboard: res.leaderboard }));
      setFlash(null);
    } catch (err) {
      setFlash(err.message);
    }
  }

  return (
    <div className="shell">
      <header>
        <h1>Ordknapp</h1>
        <p className="tagline">
          Skriv en ledtråd så att AI:n gissar ordet. Kortast ledtråd vinner.
        </p>
      </header>

      <main className="card">
        <div className="puzzle">
          <div className="puzzle-head">
            <span className="label">{practice ? 'Övningsord' : 'Dagens ord'}</span>
            {!practice && (
              <span className="attempts" title="Försök kvar idag">
                {Array.from({ length: state.maxAttempts }, (_, i) => (
                  <span key={i} className={i < state.attemptsLeft ? 'dot on' : 'dot'} />
                ))}
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
              {busy ? 'Gissar…' : 'Testa'}
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

        {flash && <p className="error">{flash}</p>}
        {/* The golf loop only happens if players know to keep going. */}
        {solved && !outOfAttempts && (
          <p className="muted note">Klarat! Går det med färre tecken?</p>
        )}
        {outOfAttempts && <p className="muted note">Nytt ord imorgon.</p>}

        <ul className="history">
          {busy && (
            <li className="entry thinking">
              <LetterRow length={active.letterCount} tone="pending" />
            </li>
          )}
          {history.map((h, i) => (
            <HistoryEntry key={history.length - i} entry={h} letterCount={active.letterCount} />
          ))}
        </ul>

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
            <p className="warn">
              Ingen databas är kopplad — resultaten försvinner när servern startar om.
            </p>
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
            <button type="submit" className="ghost" disabled={!nameInput.trim()}>
              Spara
            </button>
          </form>
        </section>
      )}

      <footer>
        <details>
          <summary>Regler</summary>
          <ul>
            <li>Högst {state.maxClueLength} tecken.</li>
            <li>Svenska ord. Inga förkortningar eller bokstaveringstrick.</li>
            <li>Inte ordet självt, dess böjningar eller de spärrade orden.</li>
            <li>Inga översättningar av ordet till andra språk.</li>
            <li>Ledtrådar som bryter mot reglerna kostar inget försök.</li>
            <li>Poäng = antal tecken i din kortaste lyckade ledtråd. Lägre är bättre.</li>
          </ul>
        </details>
        <p className="fineprint">AI:n ser bara din ledtråd och hur många bokstäver ordet har — aldrig ordet.</p>
      </footer>
    </div>
  );
}

function HistoryEntry({ entry, letterCount }) {
  if (entry.type === 'rejected') {
    return (
      <li className="entry rejected">
        <span className="clue-line"><s>{entry.clue}</s></span>
        <span className="verdict">{entry.reason} <em>Kostade inget försök.</em></span>
      </li>
    );
  }

  if (entry.type === 'ai_failure') {
    return (
      <li className="entry failure">
        <span className="clue-line">{entry.clue}</span>
        {/* The loop exhausts on wrong length as well as on unreal words, so
            this copy must cover both without claiming which one it was. */}
        <span className="verdict">
          {entry.guess ? <><s>{entry.guess}</s> — inget giltigt svar.</> : 'AI:n gav inget giltigt svar.'}{' '}
          <em>Räknas som miss.</em>
        </span>
      </li>
    );
  }

  const correct = entry.type === 'correct';
  return (
    <li className={correct ? 'entry correct' : 'entry wrong'}>
      <span className="clue-line">{entry.clue}</span>
      <LetterRow word={entry.guess} tone={correct ? 'correct' : 'wrong'} length={letterCount} />
      {correct && <span className="verdict">Rätt! {entry.score} tecken.</span>}
    </li>
  );
}

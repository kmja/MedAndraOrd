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

function charCount(s) {
  return [...s].length;
}

/** Mullvaden — blind, blyg och förvånansvärt bra på ord. */
function Mole({ size = 96 }) {
  return (
    <svg width={size} height={size * 0.85} viewBox="0 0 120 102" aria-hidden="true">
      {/* jordhög */}
      <ellipse cx="60" cy="94" rx="52" ry="8" fill="#d9c9a8" />
      {/* kropp */}
      <ellipse cx="60" cy="58" rx="42" ry="36" fill="#7a6a5c" />
      <ellipse cx="60" cy="66" rx="30" ry="24" fill="#8d7d6e" />
      {/* nos */}
      <ellipse cx="60" cy="46" rx="10" ry="8" fill="#e8a1a1" />
      <circle cx="57" cy="44" r="1.6" fill="#5c4f44" />
      <circle cx="63" cy="44" r="1.6" fill="#5c4f44" />
      {/* blunda-ögon */}
      <path d="M38 38 q6 5 12 0" stroke="#3f362e" strokeWidth="2.5" fill="none" strokeLinecap="round" />
      <path d="M70 38 q6 5 12 0" stroke="#3f362e" strokeWidth="2.5" fill="none" strokeLinecap="round" />
      {/* morrhår */}
      <g stroke="#c9bfb4" strokeWidth="1.4" strokeLinecap="round">
        <path d="M46 48 L28 44" /> <path d="M46 52 L28 54" />
        <path d="M74 48 L92 44" /> <path d="M74 52 L92 54" />
      </g>
      {/* leende */}
      <path d="M54 58 q6 6 12 0" stroke="#3f362e" strokeWidth="2.2" fill="none" strokeLinecap="round" />
      {/* tassar */}
      <ellipse cx="34" cy="80" rx="10" ry="7" fill="#e8a1a1" transform="rotate(-20 34 80)" />
      <ellipse cx="86" cy="80" rx="10" ry="7" fill="#e8a1a1" transform="rotate(20 86 80)" />
    </svg>
  );
}

export default function App() {
  const [state, setState] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [clue, setClue] = useState('');
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState([]); // this session's submissions
  const [flash, setFlash] = useState(null);
  const [nameInput, setNameInput] = useState('');
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
  if (!state) return <div className="shell"><p className="muted">Gräver fram dagens ord…</p></div>;

  const outOfAttempts = state.attemptsLeft <= 0;
  const clueLen = charCount(clue.trim());
  const tooLong = clueLen > state.maxClueLength;

  async function submit(e) {
    e.preventDefault();
    const text = clue.trim();
    if (!text || tooLong || busy || outOfAttempts) return;
    setBusy(true);
    setFlash(null);
    try {
      const res = await api('/api/clue', {
        method: 'POST',
        body: JSON.stringify({ clue: text }),
      });
      setHistory((h) => [{ clue: text, ...res.result, cached: res.cached }, ...h]);
      setState((s) => ({
        ...s,
        attemptsLeft: res.attemptsLeft,
        best: res.best,
        leaderboard: res.leaderboard,
      }));
      if (res.result.type !== 'rejected') setClue('');
      inputRef.current?.focus();
    } catch (err) {
      setFlash(err.message);
    } finally {
      setBusy(false);
    }
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
        <Mole />
        <h1>Ledtråden</h1>
        <p className="tagline">
          Mullvaden bor i mörkret och har aldrig sett dagens ord.
          <br />
          Viska en ledtråd — kortast viskning vinner.
        </p>
        <p
          className="badge"
          title="Mullvaden spelas av en AI som bara får din ledtråd och ordets antal bokstäver — aldrig ordet eller de förbjudna orden."
        >
          🕳️ Mullvaden har aldrig sett ordet
        </p>
      </header>

      <section className="card word-card">
        <div className="word-row">
          <div>
            <div className="label">Dagens ord · {state.date}</div>
            <div className="secret-word">{state.word.toUpperCase()}</div>
            <div className="muted">{state.letterCount} bokstäver</div>
          </div>
          <div className="attempts">
            <div className="label">Viskningar kvar</div>
            <div className="attempt-dots">
              {Array.from({ length: state.maxAttempts }, (_, i) => (
                <span key={i} className={i < state.attemptsLeft ? 'dot on' : 'dot'} />
              ))}
            </div>
          </div>
        </div>
        <div className="forbidden">
          <div className="label">🦉 Ugglans förbjudna ord</div>
          <div className="chips">
            {state.forbidden.map((f) => (
              <span key={f} className="chip">{f}</span>
            ))}
          </div>
        </div>
      </section>

      <section className="card">
        {state.best != null && (
          <p className="best">Din kortaste viskning idag: <strong>{state.best} tecken</strong> 🌱</p>
        )}
        <form onSubmit={submit} className="clue-form">
          <div className="input-row">
            <input
              ref={inputRef}
              value={clue}
              onChange={(e) => setClue(e.target.value)}
              placeholder={outOfAttempts ? 'Mullvaden sover till imorgon' : 'Viska till Mullvaden…'}
              disabled={busy || outOfAttempts}
              autoFocus
              maxLength={60}
            />
            <button type="submit" disabled={busy || outOfAttempts || !clue.trim() || tooLong}>
              {busy ? 'Gräver…' : 'Viska'}
            </button>
          </div>
          <div className={tooLong ? 'counter over' : 'counter'}>
            {clueLen} / {state.maxClueLength} tecken
          </div>
        </form>
        {flash && <p className="error">{flash}</p>}

        <ul className="history">
          {busy && <li className="entry thinking">Mullvaden funderar nere i hålan…</li>}
          {history.map((h, i) => (
            <HistoryEntry key={history.length - i} entry={h} />
          ))}
        </ul>
      </section>

      <section className="card">
        <h2>Dagens grävlista</h2>
        {state.leaderboard.length === 0 ? (
          <p className="muted">Ingen har fått Mullvaden att gissa rätt ännu. Bli först!</p>
        ) : (
          <ol className="leaderboard">
            {state.leaderboard.map((row) => (
              <li key={row.rank}>
                <span className="lb-name">{row.name}</span>
                <span className="lb-score">{row.score} tecken</span>
              </li>
            ))}
          </ol>
        )}
        <form onSubmit={saveName} className="name-form">
          <input
            value={nameInput}
            onChange={(e) => setNameInput(e.target.value)}
            placeholder="Ditt namn på grävlistan"
            maxLength={20}
          />
          <button type="submit" disabled={!nameInput.trim()}>Spara namn</button>
        </form>
      </section>

      <footer className="muted">
        <p>
          Ugglan vakar över reglerna: max {state.maxClueLength} tecken, svenska ord, inga förbjudna
          ord, inga översättningar av målordet, inga förkortningar eller bokstaverings­trick.
          Underkända viskningar kostar inget försök. Poäng = antal tecken i din kortaste lyckade
          ledtråd — lägre är bättre.
        </p>
        <p className="fineprint">
          Mullvaden spelas av en AI som bara får din ledtråd och antalet bokstäver — aldrig ordet.
        </p>
      </footer>
    </div>
  );
}

function HistoryEntry({ entry }) {
  if (entry.type === 'rejected') {
    return (
      <li className="entry rejected">
        <span className="clue-text">”{entry.clue}”</span>
        <span className="verdict">🦉 Ugglan säger nej: {entry.reason} <em>(kostade inget försök)</em></span>
      </li>
    );
  }
  if (entry.type === 'correct') {
    return (
      <li className="entry correct">
        <span className="clue-text">”{entry.clue}”</span>
        <span className="verdict">
          Mullvaden ropar: <strong>{entry.guess?.toUpperCase()}</strong> — 🎉 Rätt! {entry.score} tecken
        </span>
      </li>
    );
  }
  if (entry.type === 'ai_failure') {
    return (
      <li className="entry failure">
        <span className="clue-text">”{entry.clue}”</span>
        <span className="verdict">
          Mullvaden kom inte på något riktigt ord
          {entry.guess ? <> — <s>{entry.guess}</s></> : null} <em>(räknas som miss)</em>
        </span>
      </li>
    );
  }
  return (
    <li className="entry wrong">
      <span className="clue-text">”{entry.clue}”</span>
      <span className="verdict">Mullvaden gissar <strong>{entry.guess}</strong> — inte rätt 🌫️</span>
    </li>
  );
}

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
  if (!state) return <div className="shell"><p className="muted">Laddar…</p></div>;

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
        <h1>Ledtråden</h1>
        <p className="tagline">
          Skriv en ledtråd — en blind AI gissar ordet. Kortast ledtråd vinner.
        </p>
        <p className="badge" title="Gissar-AI:n får bara se din ledtråd och antalet bokstäver — aldrig ordet eller de förbjudna orden.">
          🙈 AI:n ser aldrig ordet
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
            <div className="label">Försök kvar</div>
            <div className="attempt-dots">
              {Array.from({ length: state.maxAttempts }, (_, i) => (
                <span key={i} className={i < state.attemptsLeft ? 'dot on' : 'dot'} />
              ))}
            </div>
          </div>
        </div>
        <div className="forbidden">
          <div className="label">Förbjudna ord</div>
          <div className="chips">
            {state.forbidden.map((f) => (
              <span key={f} className="chip">{f}</span>
            ))}
          </div>
        </div>
      </section>

      <section className="card">
        {state.best != null && (
          <p className="best">Ditt bästa idag: <strong>{state.best} tecken</strong> 🏌️</p>
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
            />
            <button type="submit" disabled={busy || outOfAttempts || !clue.trim() || tooLong}>
              {busy ? 'AI:n gissar…' : 'Skicka'}
            </button>
          </div>
          <div className={tooLong ? 'counter over' : 'counter'}>
            {clueLen} / {state.maxClueLength} tecken
          </div>
        </form>
        {flash && <p className="error">{flash}</p>}

        <ul className="history">
          {busy && <li className="entry thinking">AI:n funderar…</li>}
          {history.map((h, i) => (
            <HistoryEntry key={history.length - i} entry={h} />
          ))}
        </ul>
      </section>

      <section className="card">
        <h2>Topplista — dagens ord</h2>
        {state.leaderboard.length === 0 ? (
          <p className="muted">Ingen har klarat dagens ord ännu. Bli först!</p>
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
            placeholder="Ditt namn på topplistan"
            maxLength={20}
          />
          <button type="submit" disabled={!nameInput.trim()}>Spara namn</button>
        </form>
      </section>

      <footer className="muted">
        <p>
          Regler: max {state.maxClueLength} tecken, svenska ord, inga förbjudna ord, inga
          översättningar av målordet, inga förkortningar eller bokstaverings­trick. Domaren avgör.
          Poäng = antal tecken i din kortaste lyckade ledtråd — lägre är bättre.
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
        <span className="verdict">⛔ Otillåten: {entry.reason} <em>(kostade inget försök)</em></span>
      </li>
    );
  }
  if (entry.type === 'correct') {
    return (
      <li className="entry correct">
        <span className="clue-text">”{entry.clue}”</span>
        <span className="verdict">
          AI:n gissade <strong>{entry.guess}</strong> — ✅ RÄTT! {entry.score} tecken
        </span>
      </li>
    );
  }
  if (entry.type === 'ai_failure') {
    return (
      <li className="entry failure">
        <span className="clue-text">”{entry.clue}”</span>
        <span className="verdict">
          AI:n hittade inget giltigt ord{entry.guess ? <> — <s>{entry.guess}</s></> : null}{' '}
          <em>(räknas som miss)</em>
        </span>
      </li>
    );
  }
  return (
    <li className="entry wrong">
      <span className="clue-text">”{entry.clue}”</span>
      <span className="verdict">AI:n gissade <strong>{entry.guess}</strong> — ❌ fel</span>
    </li>
  );
}

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
  const [practice, setPractice] = useState(null); // { wordIndex, word, forbidden, letterCount }
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
  if (!state) return <div className="shell"><p className="muted">Öppnar linjen…</p></div>;

  // In practice mode the shown word comes from /api/random and nothing is scored.
  const active = practice ?? state;
  const outOfAttempts = !practice && state.attemptsLeft <= 0;
  const clueLen = charCount(clue.trim());
  const tooLong = clueLen > state.maxClueLength;

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
      setHistory((h) => [
        { clue: text, ...res.result, cached: res.cached, practice: !!res.practice },
        ...h,
      ]);
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
        <div className="masthead">Rikstelegrafen · Daglig förbindelse · Nr {state.date}</div>
        <h1>Ledtråden</h1>
        <p className="tagline">
          Er korrespondent i fjärran har aldrig sett dagens ord.
          <br />
          Telegrafera en ledtråd. Varje tecken kostar — billigast vinner.
        </p>
        <p
          className="badge"
          title="Mottagaren spelas av en AI som endast erhåller telegrammets text samt ordets antal bokstäver — aldrig ordet eller de spärrade orden."
        >
          Mottagaren har aldrig sett ordet
        </p>
      </header>

      <section className={practice ? 'card word-card practice' : 'card word-card'}>
        {practice && (
          <div className="practice-banner">
            Övningsläge — ej dagens ord, ingen taxa, ingen liggare
          </div>
        )}
        <div className="word-row">
          <div>
            <div className="label">{practice ? 'Övningsord' : 'Dagens ord'}</div>
            <div className="secret-word">{active.word.toUpperCase()}</div>
            <div className="muted">{active.letterCount} bokstäver</div>
          </div>
          {practice ? (
            <div className="attempts">
              <div className="label">Sändningar</div>
              <div className="unlimited">fritt</div>
            </div>
          ) : (
            <div className="attempts">
              <div className="label">Sändningar kvar</div>
              <div className="attempt-dots">
                {Array.from({ length: state.maxAttempts }, (_, i) => (
                  <span key={i} className={i < state.attemptsLeft ? 'dot on' : 'dot'} />
                ))}
              </div>
            </div>
          )}
        </div>
        <div className="forbidden">
          <div className="label">Spärrade ord — sänds ej</div>
          <div className="chips">
            {active.forbidden.map((f) => (
              <span key={f} className="chip">{f}</span>
            ))}
          </div>
        </div>
        {state.practiceEnabled && (
          <div className="practice-controls">
            <button type="button" className="ghost" onClick={randomize}>
              Slumpa ord
            </button>
            {practice && (
              <button type="button" className="ghost" onClick={backToToday}>
                Åter till dagens ord
              </button>
            )}
            <span className="bank-note">{state.bankSize} ord i banken</span>
          </div>
        )}
      </section>

      <section className="card">
        {state.best != null && !practice && (
          <p className="best">Ert billigaste telegram idag: <strong>{state.best} tecken</strong></p>
        )}
        <form onSubmit={submit} className="clue-form">
          <div className="input-row">
            <input
              ref={inputRef}
              value={clue}
              onChange={(e) => setClue(e.target.value)}
              placeholder={outOfAttempts ? 'Stationen har stängt för idag' : 'Avfatta ert telegram…'}
              disabled={busy || outOfAttempts}
              autoFocus
              maxLength={60}
              className="wire-input"
            />
            <button type="submit" disabled={busy || outOfAttempts || !clue.trim() || tooLong}>
              {busy ? 'Sänder…' : 'Sänd'}
            </button>
          </div>
          <div className={tooLong ? 'counter over' : 'counter'}>
            Taxa: {clueLen} / {state.maxClueLength} tecken
          </div>
        </form>
        {flash && <p className="error">{flash}</p>}

        <ul className="history">
          {busy && <li className="entry thinking">— · — ·&ensp;Inväntar svar från mottagaren…</li>}
          {history.map((h, i) => (
            <HistoryEntry key={history.length - i} entry={h} />
          ))}
        </ul>
      </section>

      <section className="card" hidden={!!practice}>
        <h2>Dagens billigaste telegram</h2>
        {state.leaderboard.length === 0 ? (
          <p className="muted">Inget lyckat telegram har sänts idag. Linjen är er.</p>
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
            placeholder="Ert namn i liggaren"
            maxLength={20}
          />
          <button type="submit" disabled={!nameInput.trim()}>Anteckna</button>
        </form>
      </section>

      <footer className="muted">
        <p>
          Telegrafistens reglemente: högst {state.maxClueLength} tecken, svenska ord, inga spärrade
          ord, inga översättningar av målordet, inga förkortningar eller bokstaverings­trick.
          Avvisade telegram sänds ej och debiteras ej. Taxa = antal tecken i ert kortaste lyckade
          telegram — lägre är bättre.
        </p>
        <p className="fineprint">
          Mottagaren spelas av en AI som endast erhåller telegrammets text och ordets antal
          bokstäver — aldrig ordet.
        </p>
      </footer>
    </div>
  );
}

function HistoryEntry({ entry }) {
  const sent = <span className="wire sent">SÄNT: {entry.clue.toUpperCase()}</span>;

  if (entry.type === 'rejected') {
    return (
      <li className="entry rejected">
        <span className="wire refused">EJ SÄNT: {entry.clue.toUpperCase()}</span>
        <span className="verdict">Telegrafisten vägrar sända: {entry.reason} <em>(ingen taxa — inget försök förbrukat)</em></span>
      </li>
    );
  }
  if (entry.type === 'correct') {
    return (
      <li className="entry correct">
        {sent}
        <span className="wire reply">SVAR: {entry.guess?.toUpperCase()} STOP</span>
        <span className="verdict">Rätt ord. Taxa: {entry.score} tecken.</span>
      </li>
    );
  }
  if (entry.type === 'ai_failure') {
    return (
      <li className="entry failure">
        {sent}
        {entry.guess && <span className="wire reply"><s>SVAR: {entry.guess.toUpperCase()}</s> STOP</span>}
        <span className="verdict">
          Mottagaren svarade med ett ord som inte finns — sändningen ogiltig. <em>(räknas som miss)</em>
        </span>
      </li>
    );
  }
  return (
    <li className="entry wrong">
      {sent}
      <span className="wire reply">SVAR: {entry.guess?.toUpperCase()} STOP</span>
      <span className="verdict">Fel ord.</span>
    </li>
  );
}

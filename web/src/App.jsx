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
 * A percentile from three players is noise, so small fields get a plain
 * placing instead of a made-up-sounding percentage.
 */
function standingText(standing) {
  if (!standing) return null;
  const { rank, total } = standing;
  if (total <= 1) return 'Först idag!';
  if (rank === 1) return `Bäst idag — av ${total} spelare`;
  if (total < 10) return `Plats ${rank} av ${total} idag`;
  const pct = Math.max(1, Math.round((rank / total) * 100));
  return `Du är bland de ${pct} % bästa idag`;
}

/**
 * The length meter: one segment per character, with the day's average and par
 * marked on it. The point is that you are racing the field and the target,
 * not the hard cap — the cap is just the end of the track.
 */
function LengthMeter({ length, max, par, average }) {
  const pctOf = (n) => `${Math.min(100, (n / max) * 100)}%`;
  const over = length > max;
  return (
    <div className="meter" aria-hidden="true">
      <div className={over ? 'meter-track is-over' : 'meter-track'}>
        {Array.from({ length: max }, (_, i) => (
          <span
            key={i}
            className={`seg${i < length ? ' on' : ''}${i + 1 === par ? ' at-par' : ''}`}
          />
        ))}
        {par > 0 && par <= max && (
          <span className="mark mark-par" style={{ left: pctOf(par) }}>
            <b>par {par}</b>
          </span>
        )}
        {average != null && average <= max && (
          <span className="mark mark-avg" style={{ left: pctOf(average) }}>
            <b>snitt {Math.round(average)}</b>
          </span>
        )}
      </div>
    </div>
  );
}

function LetterRow({ word, tone = 'answer', length, size }) {
  const letters = word ? chars(word.toUpperCase()) : Array.from({ length: length ?? 0 }, () => '');
  return (
    <div
      className={`row row-${tone}${size ? ` row-${size}` : ''}`}
      style={{ '--n': letters.length }}
      aria-label={word || `${length} bokstäver`}
    >
      {letters.map((letter, i) => (
        <span key={i} className="box" style={{ '--i': i }} aria-hidden="true">{letter}</span>
      ))}
    </div>
  );
}

/** The AI's answer, centre stage, with the clue that produced it as an eyebrow. */
function ResponseCard({ entry, pending, clue, letterCount, latest, children }) {
  const tone = pending ? 'pending' : entry.type === 'correct' ? 'correct' : 'wrong';
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
        />
        {tone === 'correct' && (
          <span className="sparkles" aria-hidden="true">
            {Array.from({ length: 10 }, (_, i) => <i key={i} style={{ '--s': i }} />)}
          </span>
        )}
      </div>

      {pending ? (
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
              key={`${row.rank}-${row.name}-${i}`}
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
                <span className="lb-by">
                  {row.count > 1
                    ? `${row.count} spelare skrev samma sak`
                    : row.name || 'Anonym'}
                </span>
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

export default function App() {
  const [state, setState] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [clue, setClue] = useState('');
  const [pendingClue, setPendingClue] = useState(null);
  const [history, setHistory] = useState([]); // newest first
  const [notice, setNotice] = useState(null);
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
  const attempts = history.filter(isAttempt);
  const solved = attempts.some((h) => h.type === 'correct');
  const canPlay = !outOfAttempts && !busy;

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
          standing: res.standing ?? s.standing,
          dayAverage: res.dayAverage ?? s.dayAverage,
          solvers: res.solvers ?? s.solvers,
        }));
      }
      // Free outcomes never become cards — they are notices by the input.
      if (entry.type === 'rejected') {
        setNotice({ kind: 'rejected', text: entry.reason });
        setClue(text); // let them edit rather than retype
      } else if (entry.type === 'ai_failure') {
        setNotice({ kind: 'ai_failure', guess: entry.guess });
      }
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
        <p className="tagline">Skriv en ledtråd så att AI:n gissar ordet. Kortast vinner.</p>
      </header>

      <main className="card">
        <div className="puzzle">
          <span className="label">{practice ? 'Övningsord' : 'Dagens ord'}</span>
          <LetterRow word={active.word} tone="answer" size="big" />
          <div className="forbidden">
            <span className="label">Får inte användas</span>
            <span className="chips">
              {active.forbidden.map((f) => <span key={f} className="chip">{f}</span>)}
            </span>
          </div>
        </div>

        {/* The input lives at the top: each answer is pushed down beneath it. */}
        <form onSubmit={submit} className="clue-form">
          <p className={outOfAttempts ? 'attempts attempts-out' : 'attempts'}>{attemptsLabel}</p>
          <div className="input-row">
            <input
              ref={inputRef}
              value={clue}
              onChange={(e) => setClue(e.target.value)}
              placeholder={outOfAttempts ? 'Nytt ord imorgon' : 'Din ledtråd…'}
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
            {!practice && state.best != null && (
              <span className="best">Bäst idag: {state.best}</span>
            )}
          </div>
          <LengthMeter
            length={clueLen}
            max={state.maxClueLength}
            par={state.par}
            average={practice ? null : state.dayAverage}
          />
        </form>

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
            <ResponseCard pending clue={pendingClue} letterCount={active.letterCount} latest />
          )}
          {attempts.map((entry, i) => (
            <ResponseCard
              key={attempts.length - i}
              entry={entry}
              letterCount={active.letterCount}
              latest={!busy && i === 0}
            >
              {/* The win shows the day's board and where you landed on it. */}
              {entry.type === 'correct' && !busy && i === 0 && !practice && (
                <Leaderboard rows={state.leaderboard} standing={state.standing} compact />
              )}
            </ResponseCard>
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

      {/* The standalone board stays for players who haven't solved it yet. */}
      {!practice && !solved && (
        <section className="card">
          {state.durable === false && (
            <p className="warn">Ingen databas är kopplad — resultaten försvinner när servern startar om.</p>
          )}
          <Leaderboard rows={state.leaderboard} standing={state.standing} />
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

      {!practice && solved && (
        <section className="card">
          <form onSubmit={saveName} className="name-form">
            <input
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              placeholder="Ditt namn på topplistan"
              maxLength={20}
              aria-label="Ditt namn på topplistan"
            />
            <button type="submit" className="ghost" disabled={!nameInput.trim()}>Spara namn</button>
          </form>
        </section>
      )}

      <footer>
        <details>
          <summary>Regler</summary>
          <ul>
            <li>
              Sikta på <strong>par {state.par} tecken</strong>. Längre ledtrådar är tillåtna
              upp till {state.maxClueLength} tecken — de räknas fullt ut, men hamnar längre
              ner på topplistan. Mellanslag räknas inte.
            </li>
            <li>Svenska ord. Inga förkortningar eller bokstaveringstrick.</li>
            <li>Inte ordet självt, dess böjningar eller de spärrade orden.</li>
            <li>Inga översättningar av ordet till andra språk.</li>
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

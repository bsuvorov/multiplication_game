"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

type Fact = { a: number; b: number; correct: boolean; heard: string };

declare global {
  interface Window {
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
    SpeechRecognition?: new () => SpeechRecognitionLike;
  }
}

type SpeechResultLike = ArrayLike<{ transcript: string }> & { isFinal: boolean };

type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  lang: string;
  start: () => void;
  stop: () => void;
  onresult: ((event: { results: ArrayLike<SpeechResultLike> }) => void) | null;
  onerror: ((event?: { error?: string }) => void) | null;
  onend: (() => void) | null;
};

const WORD_NUMBERS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11,
  twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30,
  forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
  hundred: 100,
};

const ANSWER_LIMIT_CHOICES = [3, 5, 8, 12];
const ANSWER_LIMIT_DEFAULT = 3;
const ANSWER_LIMIT_KEY = "times-table-trail:answer-seconds";

// The saved answer time lives outside React so the prerendered HTML always
// renders the default and only the browser reads back the child's choice.
const answerLimitListeners = new Set<() => void>();
let answerLimitCache: number | null = null;

function readAnswerLimit() {
  if (answerLimitCache === null) {
    let stored = NaN;
    try {
      stored = Number(window.localStorage.getItem(ANSWER_LIMIT_KEY));
    } catch {
      // Storage can be blocked (private browsing); fall back to the default.
    }
    answerLimitCache = ANSWER_LIMIT_CHOICES.includes(stored) ? stored : ANSWER_LIMIT_DEFAULT;
  }
  return answerLimitCache;
}

function writeAnswerLimit(limit: number) {
  answerLimitCache = limit;
  try {
    window.localStorage.setItem(ANSWER_LIMIT_KEY, String(limit));
  } catch {
    // Storage can be blocked; the choice still applies for this session.
  }
  answerLimitListeners.forEach((notify) => notify());
}

function subscribeAnswerLimit(notify: () => void) {
  answerLimitListeners.add(notify);
  return () => { answerLimitListeners.delete(notify); };
}

function spokenNumbers(text: string) {
  const candidates = (text.match(/\d+/g) ?? []).map(Number);
  const words: string[] = text.toLowerCase().replace(/-/g, " ").match(/[a-z]+/g) ?? [];
  let total = 0;
  const digits: number[] = [];
  for (const word of words) {
    const n = WORD_NUMBERS[word];
    if (n === undefined) continue;
    if (n >= 0 && n <= 9) digits.push(n);
    if (n === 100) total = Math.max(1, total) * 100;
    else total += n;
  }
  if (total || words.includes("zero")) candidates.push(total);
  if (digits.length > 1) candidates.push(Number(digits.join("")));
  return [...new Set(candidates)];
}

function isSkipResponse(text: string) {
  return /\b(i\s*(do\s*)?not\s*know|i\s*don'?t\s*know|dont\s*know|do\s*not\s*know)\b/i.test(text);
}

let speechId = 0;

function say(text: string, afterSpeaking?: () => void) {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) {
    afterSpeaking?.();
    return;
  }
  const currentSpeechId = ++speechId;
  window.speechSynthesis.cancel();
  const voice = new SpeechSynthesisUtterance(text);
  voice.rate = 0.82;
  voice.pitch = 1.12;
  voice.onend = () => {
    if (currentSpeechId === speechId) afterSpeaking?.();
  };
  window.speechSynthesis.speak(voice);
}

export default function Home() {
  const [minutes, setMinutes] = useState(5);
  const [tables, setTables] = useState<number[]>([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  const [stage, setStage] = useState<"welcome" | "playing" | "result">("welcome");
  const [timeLeft, setTimeLeft] = useState(0);
  const [question, setQuestion] = useState({ a: 5, b: 7 });
  const [facts, setFacts] = useState<Fact[]>([]);
  const [message, setMessage] = useState("Pick a practice time, then press Start!");
  const [listening, setListening] = useState(false);
  const [answerSeconds, setAnswerSeconds] = useState(ANSWER_LIMIT_DEFAULT);
  const answerLimit = useSyncExternalStore(subscribeAnswerLimit, readAnswerLimit, () => ANSWER_LIMIT_DEFAULT);
  const recognition = useRef<SpeechRecognitionLike | null>(null);
  const questionRef = useRef(question);
  const answerTimer = useRef<number | null>(null);
  const nextQuestionRef = useRef<() => void>(() => {});
  const listenRef = useRef<() => void>(() => {});
  const resolvingAnswer = useRef(false);
  const reviewQueue = useRef<Array<{ a: number; b: number; due: number }>>([]);
  const askedCount = useRef(0);

  const clearAnswerTimer = useCallback(() => {
    if (answerTimer.current !== null) window.clearTimeout(answerTimer.current);
    answerTimer.current = null;
  }, []);

  const submitAnswer = useCallback((heard: string) => {
    if (resolvingAnswer.current) return;
    resolvingAnswer.current = true;
    clearAnswerTimer();
    const { a, b } = questionRef.current;
    const skipped = isSkipResponse(heard);
    const correct = !skipped && spokenNumbers(heard).includes(a * b);
    setFacts((old) => [...old, { a, b, correct, heard }]);
    if (!correct) reviewQueue.current.push({ a, b, due: askedCount.current + 3 });
    setListening(false);
    let feedback = "";
    if (correct) {
      feedback = "Amazing! You got it!";
    } else if (!heard) {
      feedback = `Time's up! ${a} times ${b} is ${a * b}.`;
    } else if (skipped) {
      feedback = `That one needs practice. ${a} times ${b} is ${a * b}.`;
    } else {
      feedback = `Nice try! ${a} times ${b} is ${a * b}.`;
    }
    setMessage(heard ? `I heard “${heard}.” ${feedback}` : feedback);
    say(feedback, () => window.setTimeout(() => nextQuestionRef.current(), 700));
  }, [clearAnswerTimer]);

  const listen = useCallback(() => {
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Recognition) {
      setMessage("Voice listening is not available here. Try Chrome or Safari.");
      return;
    }
    clearAnswerTimer();
    recognition.current?.stop();
    const instance = new Recognition();
    recognition.current = instance;
    instance.continuous = false;
    instance.interimResults = true;
    instance.maxAlternatives = 4;
    instance.lang = "en-US";
    let heardSoFar = "";
    const settle = (heard: string) => {
      instance.onresult = null;
      instance.onerror = null;
      instance.stop();
      submitAnswer(heard);
    };
    instance.onresult = (event) => {
      const { a, b } = questionRef.current;
      let transcript = "";
      let hasFinal = false;
      let match = "";
      for (let i = 0; i < event.results.length; i += 1) {
        const result = event.results[i];
        transcript += `${result[0].transcript} `;
        if (result.isFinal) hasFinal = true;
        for (let j = 0; j < result.length && !match; j += 1) {
          const alternative = result[j].transcript;
          if (spokenNumbers(alternative).includes(a * b) || isSkipResponse(alternative)) match = alternative;
        }
      }
      heardSoFar = transcript.trim();
      if (match) settle(match);
      else if (hasFinal) settle(heardSoFar);
    };
    instance.onerror = (event) => {
      if (resolvingAnswer.current) return;
      if (event?.error === "not-allowed") {
        clearAnswerTimer();
        setListening(false);
        setMessage("Please allow microphone access, then try again.");
        return;
      }
      settle(heardSoFar);
    };
    instance.onend = () => setListening(false);
    setAnswerSeconds(answerLimit);
    setListening(true);
    setMessage(`I’m listening… you have ${answerLimit} seconds!`);
    instance.start();
    answerTimer.current = window.setTimeout(() => {
      instance.stop();
      answerTimer.current = window.setTimeout(() => settle(heardSoFar), 500);
    }, answerLimit * 1000);
  }, [answerLimit, clearAnswerTimer, submitAnswer]);

  listenRef.current = listen;

  const nextQuestion = useCallback(() => {
    resolvingAnswer.current = false;
    askedCount.current += 1;
    const randomFact = () => ({
      a: tables[Math.floor(Math.random() * tables.length)],
      b: Math.floor(Math.random() * 10) + 1,
    });
    const review = reviewQueue.current[0];
    let next: { a: number; b: number };
    if (review && review.due <= askedCount.current) {
      reviewQueue.current.shift();
      next = { a: review.a, b: review.b };
    } else {
      const previous = questionRef.current;
      next = randomFact();
      for (let tries = 0; tries < 8 && next.a === previous.a && next.b === previous.b; tries += 1) {
        next = randomFact();
      }
    }
    questionRef.current = next;
    setQuestion(next);
    setMessage("Listen carefully…");
    window.setTimeout(() => say(`${next.a} multiplied by ${next.b}. What is the answer?`, () => listenRef.current()), 100);
  }, [tables]);

  nextQuestionRef.current = nextQuestion;

  const finish = useCallback(() => {
    speechId += 1;
    clearAnswerTimer();
    recognition.current?.stop();
    window.speechSynthesis?.cancel();
    setListening(false);
    setStage("result");
  }, [clearAnswerTimer]);

  useEffect(() => {
    if (stage !== "playing" || timeLeft <= 0) return;
    const clock = window.setInterval(() => setTimeLeft((t) => t - 1), 1000);
    return () => window.clearInterval(clock);
  }, [stage, timeLeft]);

  useEffect(() => {
    if (stage === "playing" && timeLeft === 0) finish();
  }, [timeLeft, stage, finish]);

  useEffect(() => {
    if (!listening) return;
    const clock = window.setInterval(() => setAnswerSeconds((seconds) => Math.max(0, seconds - 1)), 1000);
    return () => window.clearInterval(clock);
  }, [listening]);

  function start() {
    setFacts([]);
    reviewQueue.current = [];
    askedCount.current = 0;
    setTimeLeft(minutes * 60);
    setStage("playing");
    window.setTimeout(nextQuestion, 100);
  }

  function toggleTable(table: number) {
    setTables((current) => current.length === 10 ? [table] : current.includes(table)
      ? current.length === 1 ? current : current.filter((value) => value !== table)
      : [...current, table].sort((a, b) => a - b));
  }

  const total = facts.length;
  const correct = facts.filter((fact) => fact.correct).length;
  const missed = facts.filter((fact) => !fact.correct);
  const mistakeTotal = missed.length;
  const needsPractice = [...new Set(missed.map((fact) => `${fact.a} × ${fact.b}`))].slice(0, 5);
  const seconds = String(timeLeft % 60).padStart(2, "0");

  return (
    <main>
      <section className="app-shell">
        <header><div className="brand"><span>✦</span> Times Table Trail</div><div className="badge">1–10 practice</div></header>
        {stage === "welcome" && <div className="welcome card">
          <div className="mascot" aria-hidden="true">🦊</div>
          <p className="eyebrow">VOICE PRACTICE ADVENTURE</p>
          <h1>Ready to become a multiplication wizard?</h1>
          <p className="lead">I’ll ask questions out loud. You say the answer, and I’ll help you learn what to practise next.</p>
          <div className="time-picker" aria-label="Choose practice time">
            {[5, 10].map((time) => <button key={time} className={minutes === time ? "selected" : ""} onClick={() => setMinutes(time)}>{time} minutes</button>)}
          </div>
          <div className="table-picker">
            <div className="table-picker-title"><strong>Choose your tables</strong><button onClick={() => setTables([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])}>All tables</button></div>
            <p>Tap a table to focus on it, then tap another to add it. For example: 2s and 5s.</p>
            <div className="table-grid" aria-label="Choose multiplication tables">
              {Array.from({ length: 10 }, (_, index) => index + 1).map((table) => <button key={table} className={tables.includes(table) ? "selected" : ""} onClick={() => toggleTable(table)} aria-pressed={tables.includes(table)}>{table}×</button>)}
            </div>
          </div>
          <div className="answer-picker">
            <div className="answer-picker-title"><strong>Thinking time</strong><span>{answerLimit} seconds</span></div>
            <p>How long do you get to say each answer? Pick more seconds if you need extra time to think.</p>
            <div className="answer-grid" aria-label="Choose how many seconds you get to answer">
              {ANSWER_LIMIT_CHOICES.map((limit) => <button key={limit} className={answerLimit === limit ? "selected" : ""} onClick={() => writeAnswerLimit(limit)} aria-pressed={answerLimit === limit}>{limit}s</button>)}
            </div>
          </div>
          <button className="start" onClick={start}>Start my adventure <span>→</span></button>
          <p className="tiny">Best with your sound on. The microphone will switch on after every question.</p>
        </div>}
        {stage === "playing" && <div className="practice card">
          <div className="practice-top"><div><p className="eyebrow">QUESTION {total + 1}</p><p className="cheer">Keep going, star!</p></div><div className="timer">⏱ {Math.floor(timeLeft / 60)}:{seconds}</div></div>
          <div className="problem"><span>{question.a}</span><b>×</b><span>{question.b}</span><b>=</b><i>?</i></div>
          <p className="prompt">{message}{listening && <span className="answer-countdown"> {answerSeconds}</span>}</p>
          {listening && <div className="answer-progress" aria-label={`${answerSeconds} seconds remaining`}><span style={{ width: `${(answerSeconds / answerLimit) * 100}%` }} /></div>}
          <button className={`mic ${listening ? "listening" : ""}`} onClick={listen} aria-label="Answer with your voice">{listening ? "◉" : "🎙"}</button>
          <button className="repeat" onClick={() => say(`${question.a} multiplied by ${question.b}. What is the answer?`, listen)}>🔊 Hear it again</button>
          <button className="finish" onClick={finish}>Finish early</button>
        </div>}
        {stage === "result" && <div className="results card">
          <div className="mascot" aria-hidden="true">🏆</div><p className="eyebrow">ADVENTURE COMPLETE</p>
          <h1>Wonderful work!</h1><p className="lead">You answered {total} question{total === 1 ? "" : "s"}, got <strong>{correct}</strong> right, and made <strong>{mistakeTotal}</strong> mistake{mistakeTotal === 1 ? "" : "s"}. Missed facts were queued to practise again.</p>
          <div className="score"><span>{total ? Math.round((correct / total) * 100) : 0}%</span><small>correct</small></div>
          {needsPractice.length ? <div className="study"><h2>Your next superpower</h2><p>Practise these facts a little more:</p><div>{needsPractice.map((fact) => <span key={fact}>{fact}</span>)}</div></div> : <div className="study all-good"><h2>You’re on a roll!</h2><p>Every answer was correct. Try a longer adventure next time!</p></div>}
          {missed.length > 0 && <div className="mistakes"><h2>Your {mistakeTotal} mistake{mistakeTotal === 1 ? "" : "s"}</h2><div className="mistake-list">{missed.map((fact, index) => <div className="mistake" key={`${fact.a}-${fact.b}-${index}`}><span>{fact.a} × {fact.b}</span><span>{fact.heard ? `You said: “${fact.heard}”` : "No answer"}</span><strong>Answer: {fact.a * fact.b}</strong></div>)}</div></div>}
          <button className="start" onClick={() => setStage("welcome")}>Play again <span>↻</span></button>
        </div>}
      </section>
    </main>
  );
}

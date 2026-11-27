"use client";
// The signed-out home page (after the ClipFlow 2.0 Phase 15 design): who Clipflow is for, what it does, and the way
// in. Signing in goes to `signIn`, the link the server gives a signed-out visitor (one provider's start, or the chooser
// when more than one is set up), so this page never decides which providers exist. The artwork is decorative and
// hidden from screen readers; nothing moves.
import { ArrowUpRight, Captions, Radio, Scissors, ShieldCheck } from "lucide-react";

export function Landing({ signIn, error, onTry }: { signIn: string; error?: string; onTry: () => void }) {
  return <div className="lp">
    <a className="lp-skip" href="#lp-main">Skip to main content</a>
    <header className="lp-header">
      <a className="lp-wordmark" href="#lp-main" aria-label="Clipflow, main content"><span aria-hidden><Scissors size={18} /></span><span>clipflow<span className="lp-dot">.</span></span></a>
      <a className="lp-signin-small" href={signIn} target="_top">Sign in</a>
    </header>
    <main id="lp-main" tabIndex={-1}>
      <section className="lp-hero" aria-labelledby="lp-title">
        <div className="lp-copy">
          <p className="lp-kicker">A creative workspace for every streamer</p>
          <h1 id="lp-title">Every voice.<br />Every moment.<br /><em>Make it yours.</em></h1>
          <p className="lp-lead">Clipflow watches your streams, finds the moments that matter and turns them into vertical clips. Shape each one your way, then post it or keep it.</p>
          {error && <p className="lp-error" role="alert">Sign-in didn&apos;t work: {error}. Please try again.</p>}
          <div className="lp-actions">
            <a className="primary lp-cta" href={signIn} target="_top">Open your workspace <ArrowUpRight size={17} aria-hidden /></a>
            <button type="button" className="secondary" onClick={onTry}><Captions size={16} aria-hidden />Try the caption generator</button>
          </div>
          <p className="lp-note"><ShieldCheck size={14} aria-hidden />Your workspace is private. Nothing posts unless you say so.</p>
        </div>
        <Process />
      </section>
      <section className="lp-community" aria-labelledby="lp-community-title">
        <p className="lp-kicker">Different stories. Same creative freedom.</p>
        <h2 id="lp-community-title">Made for the way you create.</h2>
        <p className="lp-sub">Whether you&apos;re just starting out or streaming every night, alone or with a crew, your moments belong here.</p>
        <div className="lp-cards">
          <article><span aria-hidden>01</span><h3>Stream &amp; play</h3><p>Gamers and community streamers on Twitch, Kick, YouTube and TikTok: the reactions, clutches and chat moments.</p></article>
          <article><span aria-hidden>02</span><h3>Talk &amp; teach</h3><p>Podcasters, educators and interviewers: upload a recording and pull out the explanations and conversations worth sharing.</p></article>
          <article><span aria-hidden>03</span><h3>Make &amp; tell</h3><p>Artists, filmmakers and storytellers: subtitles, opening titles and layouts that tell the story your way.</p></article>
        </div>
      </section>
      <section className="lp-steps" aria-labelledby="lp-steps-title">
        <h2 id="lp-steps-title" className="lp-visually-hidden">How it works</h2>
        <ol>
          <li><Radio size={18} aria-hidden /><div><strong>Find</strong><p>Add your channels. A worker on your PC records them and spots the moments chat and your voice light up.</p></div></li>
          <li><Scissors size={18} aria-hidden /><div><strong>Refine</strong><p>Trim, pick a layout, style the subtitles and title, all in one editor.</p></div></li>
          <li><ShieldCheck size={18} aria-hidden /><div><strong>Review</strong><p>Watch the finished clip and approve it. You decide what goes out, and where.</p></div></li>
        </ol>
      </section>
    </main>
    <footer className="lp-footer"><span>Clipflow · Greatness in motion</span><a href={signIn} target="_top">Sign in</a></footer>
  </div>;
}

// Find, refine, review: a landscape stream frame, the same moment as a vertical clip with a title, and the decision.
function Process() {
  return <div className="lp-art" aria-hidden>
    <div className="lp-art-top"><span>THE CREATIVE PROCESS</span><span>01 — 03</span></div>
    <div className="lp-art-board">
      <div className="lp-film lp-film-source"><small>01 / FIND</small>
        <svg viewBox="0 0 180 105" preserveAspectRatio="xMidYMid slice"><rect width="180" height="105" fill="#34483a" /><circle cx="133" cy="25" r="14" fill="#e7d29e" /><path d="M0 83 39 37 73 69 119 29 180 91V105H0" fill="#778d72" /><path d="M0 85 52 69 94 95 143 62 180 82V105H0" fill="#243a2d" /></svg>
        <div className="lp-wave">▂▃▅▂▆▃▇▂▅▇▅▂▃▆▂</div></div>
      <div className="lp-film lp-film-output"><small>02 / REFINE</small>
        <svg viewBox="0 0 90 130" preserveAspectRatio="xMidYMid slice"><rect width="90" height="130" fill="#34483a" /><circle cx="68" cy="25" r="14" fill="#e7d29e" /><path d="M0 83 24 37 47 69 72 29 90 91V130H0" fill="#778d72" /><path d="M0 85 26 69 47 95 72 62 90 82V130H0" fill="#243a2d" /><rect x="7" y="96" width="76" height="22" rx="2" fill="#101210" /><text x="45" y="105" textAnchor="middle" fill="#fff" fontSize="7" fontWeight="700">YOUR STORY.</text><text x="45" y="114" textAnchor="middle" fill="#bcfa76" fontSize="7" fontWeight="700">YOUR WAY.</text></svg></div>
    </div>
    <div className="lp-art-bottom"><span>03 / REVIEW</span><span className="lp-check">✓ Your decision</span></div>
  </div>;
}

import Logo from './Logo.jsx'

/* ===================== LINE ICONS ===================== */
const IconMic = () => (
  <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="9" y="2" width="6" height="12" rx="3" />
    <path d="M5 10v2a7 7 0 0 0 14 0v-2" />
    <path d="M12 19v3" />
  </svg>
)
const IconBrain = () => (
  <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 4.5C11 3.3 9.6 2.5 8 2.5 5.5 2.5 3.5 4.5 3.5 7c0 1.3.5 2.5 1.4 3.4-.5.6-.9 1.4-.9 2.3 0 1.7 1.3 3 3 3h5a2 2 0 0 0 2-2V6a2 2 0 0 0-2-1.5z" />
    <path d="M12 4.5C13 3.3 14.4 2.5 16 2.5c2.5 0 4.5 2 4.5 4.5 0 1.3-.5 2.5-1.4 3.4.5.6.9 1.4.9 2.3 0 1.7-1.3 3-3 3h-5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-1.5z" />
    <path d="M13 19.5c-.5 1-.9 1.5-1 2 0 .5.5 1 1 .5 1 0 2-.9 2-2.5" />
    <path d="M11 19.5c.5 1 .9 1.5 1 2 0 .5-.5 1-1 .5-1 0-2-.9-2-2.5" />
  </svg>
)
const IconLink = () => (
  <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" />
    <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" />
  </svg>
)
const IconTimeline = () => (
  <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="5" cy="6" r="2.5" />
    <circle cx="12" cy="17" r="2.5" />
    <circle cx="19" cy="7" r="2.5" />
    <path d="M7.5 6H16a3 3 0 0 1 0 6H9a3 3 0 0 0 0 6h8.5" />
  </svg>
)
const IconWarning = () => (
  <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
    <path d="M12 9v4" />
    <path d="M12 17h.01" />
  </svg>
)
const IconLock = () => (
  <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="11" width="18" height="11" rx="2" />
    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
  </svg>
)
const IconUpload = () => (
  <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 14.9A7 7 0 1 1 15.7 8h1.8a4.5 4.5 0 0 1 2.5 8.2" />
    <path d="M12 12v9" />
    <path d="M8 16l4-4 4 4" />
  </svg>
)
const IconSearch = () => (
  <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="11" cy="11" r="7" />
    <path d="m21 21-4.3-4.3" />
  </svg>
)
const IconTrend = () => (
  <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 17l6-6 4 4 8-8" />
    <path d="M14 7h7v7" />
  </svg>
)
const IconSpark = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M12 2l1.9 5.7a2 2 0 0 0 1.2 1.2L21 11l-5.9 2.1a2 2 0 0 0-1.2 1.2L12 20l-1.9-5.7a2 2 0 0 0-1.2-1.2L3 11l5.9-2.1a2 2 0 0 0 1.2-1.2L12 2z" />
  </svg>
)

/* ===================== IMAGE SCENES ===================== */
function SceneSunset({ className }) {
  return (
    <svg className={className} viewBox="0 0 640 400" fill="none" aria-label="A warm sunset over rolling hills">
      <defs>
        <linearGradient id="sunSky" x1="0" y1="0" x2="0" y2="1">
          <stop stopColor="#fffbeb" />
          <stop offset="0.55" stopColor="#ffedd5" />
          <stop offset="1" stopColor="#fed7aa" />
        </linearGradient>
        <radialGradient id="sunGlow" cx="0.5" cy="0.5" r="0.5">
          <stop stopColor="#fb923c" stopOpacity="0.5" />
          <stop offset="1" stopColor="#fb923c" stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect width="640" height="400" fill="url(#sunSky)" />
      <circle cx="470" cy="150" r="120" fill="url(#sunGlow)" />
      <circle cx="470" cy="150" r="52" fill="#fb923c" />
      <circle cx="470" cy="168" r="52" fill="url(#sunSky)" />
      <path d="M0 268 C120 216 240 300 360 258 S560 200 640 240 V400 H0 Z" fill="#fdba74" opacity="0.7" />
      <path d="M0 306 C140 258 280 344 420 304 S580 266 640 292 V400 H0 Z" fill="#fb923c" opacity="0.9" />
      <path d="M0 350 C160 312 320 388 480 348 S600 336 640 346 V400 H0 Z" fill="#c2410c" opacity="0.75" />
      <path d="M60 70 l4 12 12 4-12 4-4 12-4-12-12-4 12-4z" fill="#fbbf24" opacity="0.9" />
      <path d="M560 70 l3 9 9 3-9 3-3 9-3-9-9-3 9-3z" fill="#fbbf24" opacity="0.7" />
      <g stroke="#ea580c" strokeWidth="2" strokeLinecap="round" fill="none" opacity="0.85">
        <path d="M120 120 c8-12 20-12 28 0 c8 12 20 12 28 0" />
        <path d="M180 150 c6-9 15-9 21 0" />
      </g>
      <g fill="#7c2d12">
        <circle cx="330" cy="260" r="7" />
        <path d="M323 260 c0-30 14-46 44-46 c2 0 4 0 5 1 c-4 6 1 12 8 12 c0 0 1 8 1 14 l-4 20-20 4z" />
        <circle cx="392" cy="268" r="9" />
        <path d="M382 268 c0-36 12-54 40-54 c2 0 4 0 6 1 c-3 7 4 13 10 11 c1 4 1 9 1 14 l-3 22-22 6z" />
        <circle cx="228" cy="252" r="6" />
        <path d="M221 252 c1-26 13-40 40-40 c2 0 4 0 5 1 c-3 6 2 11 8 11 l1 13-2 18-18 3z" />
      </g>
      <path d="M430 300 q15 -8 14 -26 q0 18 14 26 q-14 3-14 16 q0 -13 -14 -16z" fill="#fff" opacity="0.7" />
    </svg>
  )
}

function SceneJournal() {
  return (
    <svg viewBox="0 0 240 180" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id="bookGrad" x1="0" y1="0" x2="1" y2="1">
          <stop stopColor="#fb923c" />
          <stop offset="1" stopColor="#fbbf24" />
        </linearGradient>
      </defs>
      <path d="M30 58 H110 V150 H30 Z" rx="6" fill="#ffedd5" stroke="#fdba74" strokeWidth="3" />
      <path d="M130 58 H210 V150 H130 Z" rx="6" fill="#fff7ed" stroke="#fdba74" strokeWidth="3" />
      <line x1="118" y1="58" x2="118" y2="150" stroke="#fb923c" strokeWidth="3" />
      <g stroke="#f97316" strokeWidth="3" strokeLinecap="round" opacity="0.65">
        <line x1="46" y1="82" x2="94" y2="82" />
        <line x1="46" y1="100" x2="88" y2="100" />
        <line x1="46" y1="118" x2="78" y2="118" />
        <line x1="146" y1="82" x2="194" y2="82" />
        <line x1="146" y1="100" x2="188" y2="100" />
        <line x1="146" y1="118" x2="178" y2="118" />
      </g>
      <path d="M186 118 h26 v30 l-8 -6 -8 6 -10 -8z" fill="url(#bookGrad)" />
    </svg>
  )
}

function SceneVoice() {
  return (
    <svg viewBox="0 0 240 180" fill="none" aria-hidden="true">
      <circle cx="120" cy="92" r="34" fill="url(#voiceGrad)" />
      <defs>
        <radialGradient id="voiceGrad">
          <stop stopColor="#fbbf24" stopOpacity="0.35" />
          <stop offset="1" stopColor="#fb923c" stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect x="112" y="58" width="16" height="38" rx="8" fill="#ea580c" />
      <path d="M104 96 v4 a16 16 0 0 0 32 0 v-4" stroke="#ea580c" strokeWidth="5" strokeLinecap="round" />
      <path d="M120 132 v14" stroke="#ea580c" strokeWidth="5" strokeLinecap="round" />
      <g fill="#fb923c">
        <rect x="30" y="100" width="10" height="34" rx="5" />
        <rect x="48" y="90" width="10" height="44" rx="5" />
        <rect x="66" y="104" width="10" height="30" rx="5" />
        <rect x="164" y="104" width="10" height="30" rx="5" />
        <rect x="182" y="90" width="10" height="44" rx="5" />
        <rect x="200" y="100" width="10" height="34" rx="5" />
      </g>
    </svg>
  )
}

function ScenePhotos() {
  return (
    <svg viewBox="0 0 240 180" fill="none" aria-hidden="true">
      <g transform="rotate(-8 120 90)">
        <rect x="96" y="34" width="92" height="100" rx="8" fill="#fff" stroke="#fdba74" strokeWidth="3" />
        <rect x="104" y="42" width="76" height="62" rx="4" fill="url(#photo1Grad)" />
        <circle cx="120" cy="56" r="7" fill="#fff" opacity="0.9" />
        <path d="M104 100 l22 -18 20 14 14 -10 20 18v4h-76z" fill="#c2410c" />
        <rect x="140" y="110" width="8" height="6" rx="2" fill="#c2410c" />
      </g>
      <g transform="rotate(7 150 90)">
        <rect x="116" y="34" width="92" height="100" rx="8" fill="#fff" stroke="#fdba74" strokeWidth="3" />
        <rect x="124" y="42" width="76" height="62" rx="4" fill="url(#photo2Grad)" />
        <circle cx="140" cy="56" r="7" fill="#fff" opacity="0.9" />
        <path d="M124 100 l22 -18 20 14 14 -10 20 18v4h-76z" fill="#fb923c" />
      </g>
      <defs>
        <linearGradient id="photo1Grad" x1="0" y1="0" x2="1" y2="1">
          <stop stopColor="#fff7ed" />
          <stop offset="1" stopColor="#fed7aa" />
        </linearGradient>
        <linearGradient id="photo2Grad" x1="0" y1="0" x2="1" y2="1">
          <stop stopColor="#ffedd5" />
          <stop offset="1" stopColor="#fdba74" />
        </linearGradient>
      </defs>
    </svg>
  )
}

function SceneEmail() {
  return (
    <svg viewBox="0 0 240 180" fill="none" aria-hidden="true">
      <rect x="52" y="52" width="136" height="86" rx="10" fill="#fff" stroke="#fdba74" strokeWidth="3" />
      <path d="M52 62 l68 46 68-46" stroke="#f97316" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <circle cx="148" cy="104" r="18" fill="#fff" />
      <path d="M148 104 l10 10" stroke="#fb923c" strokeWidth="4" strokeLinecap="round" />
      <circle cx="120" cy="140" r="6" fill="#fbbf24" />
      <circle cx="90" cy="150" r="4" fill="#fb923c" />
    </svg>
  )
}

function SceneDocs() {
  return (
    <svg viewBox="0 0 240 180" fill="none" aria-hidden="true">
      <path d="M86 30 h52 l24 24 v96 a4 4 0 0 1-4 4 H86 a4 4 0 0 1-4-4 V34 a4 4 0 0 1 4-4z" fill="#fff" stroke="#fdba74" strokeWidth="3" />
      <path d="M138 30 l24 24 h-24z" fill="#fed7aa" />
      <g stroke="#f97316" strokeWidth="4" strokeLinecap="round" opacity="0.6">
        <line x1="104" y1="76" x2="152" y2="76" />
        <line x1="104" y1="96" x2="146" y2="96" />
        <line x1="104" y1="116" x2="140" y2="116" />
      </g>
      <circle cx="162" cy="120" r="26" fill="#ea580c" />
      <path d="M153 120 l6 7 11 -12" stroke="#fff" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  )
}

function SceneStories() {
  return (
    <svg viewBox="0 0 240 180" fill="none" aria-hidden="true">
      <path d="M52 46 h104 v56 H96 l-26 22 v-22 h-18 a7 7 0 0 1-7-7 V53 a7 7 0 0 1 7-7z" fill="#fff" stroke="#fdba74" strokeWidth="3" />
      <path d="M120 70 a30 30 0 1 1 60 0 a30 30 0 0 1-60 0z" fill="url(#storyGrad)" opacity="0.9" />
      <circle cx="132" cy="66" r="5" fill="#7c2d12" />
      <circle cx="168" cy="66" r="5" fill="#7c2d12" />
      <path d="M130 80 q15 10 30 0" stroke="#7c2d12" strokeWidth="3" strokeLinecap="round" fill="none" />
      <path d="M140 52 l6 -14 m8 14 l-6 -14z" fill="#fbbf24" />
      <defs>
        <linearGradient id="storyGrad" x1="0" y1="0" x2="1" y2="1">
          <stop stopColor="#fed7aa" />
          <stop offset="1" stopColor="#fb923c" />
        </linearGradient>
      </defs>
    </svg>
  )
}

/* ===================== MEMORY GALLERY ===================== */
const memoryItems = [
  { title: 'Journals', count: '24 entries', scene: <SceneJournal /> },
  { title: 'Voice Notes', count: '38 recordings', scene: <SceneVoice /> },
  { title: 'Photo Albums', count: '12 collections', scene: <ScenePhotos /> },
  { title: 'Emails & Letters', count: '1,200 saved', scene: <SceneEmail /> },
  { title: 'Documents', count: '96 files', scene: <SceneDocs /> },
  { title: 'Stories', count: '52 told', scene: <SceneStories /> },
]

function HeroVisual() {
  return (
    <div className="hero-visual" aria-label="Photo frame of a sunset, with floating memory chips">
      <div className="hero-photo-frame reveal">
        <span className="photo-kicker">
          <IconSpark />
          A memory, preserved
        </span>
        <SceneSunset className="hero-photo" />
      </div>
      <div className="float-chip chip-voice reveal">
        <span className="chip-icon">🎙️</span>
        <span className="chip-text">
          <strong>Voice memo</strong>
          <span>Grandma's stories · 1994</span>
        </span>
      </div>
      <div className="float-chip chip-journal reveal">
        <span className="chip-icon">📖</span>
        <span className="chip-text">
          <strong>Journal entry</strong>
          <span>First day of college</span>
        </span>
      </div>
      <div className="float-chip chip-photo reveal">
        <span className="chip-icon">📸</span>
        <span className="chip-text">
          <strong>Family photo</strong>
          <span>Beach trip · Aug 2001</span>
        </span>
      </div>
    </div>
  )
}

function Home({ go }) {
  return (
    <>
      {/* ===================== HERO ===================== */}
      <section className="hero-section" id="home">
        <div className="hero-glow glow-a" aria-hidden="true"></div>
        <div className="hero-glow glow-b" aria-hidden="true"></div>
        <div className="hero-container reveal">
          <span className="hero-badge">✨ AI memory capsule · now in beta</span>
          <h1 className="hero-title">
            Your Memories. Your Mind.
            <br />
            <span className="gradient-text">Preserved Forever.</span>
          </h1>
          <p className="hero-subtitle">
            EchoMind is an AI-powered digital memory capsule that preserves not just your photos
            and videos — but your knowledge, experiences, and the way you think.
          </p>
          <div className="hero-cta-buttons">
            <button type="button" className="btn-primary-large" onClick={() => go('signup')}>
              Start Your Archive
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 12h14" />
                <path d="m12 5 7 7-7 7" />
              </svg>
            </button>
            <a href="#how-it-works" className="btn-outline">See How It Works</a>
          </div>
        </div>
        <HeroVisual />
      </section>

      {/* ===================== WHAT IS ECHOMIND ===================== */}
      <section className="about-section" id="about">
        <div className="section-container">
          <div className="about-wrap">
            <div className="about-text reveal">
              <span className="section-tag">What is EchoMind</span>
              <h2 className="section-h2">
                More Than a Memory. <span className="gradient-text">A Mind, Remembered.</span>
              </h2>
              <p className="body-large">
                Most digital archives store moments. EchoMind stores <em>you</em> — your stories,
                your decisions, your voice.
              </p>
              <p className="about-body">
                Upload journals, voice recordings, emails, and documents, and let AI transform them
                into an interactive knowledge model that the people you love can explore, question,
                and learn from — long after the moment has passed.
              </p>
              <div className="about-stats">
                <div className="stat">
                  <strong>3 min</strong>
                  <span>to upload your first memory</span>
                </div>
                <div className="stat">
                  <strong>100%</strong>
                  <span>of answers cite your own words</span>
                </div>
              </div>
            </div>
            <div className="about-visual reveal">
              <div className="about-photo">
                <ScenePhotos />
              </div>
              <div className="about-photo-card">
<span className="card-badge">
                <Logo size={26} wordmark={false} />
              </span>
              <p className="card-text">Connected 12 memories</p>
                <p className="card-sub">"A mind, remembered."</p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ===================== MEMORY GALLERY ===================== */}
      <section className="gallery-section" id="gallery">
        <div className="section-container">
          <div className="section-header reveal">
            <span className="section-tag">The Archive</span>
            <h2 className="section-h2">Every Kind of Memory, in One Place</h2>
            <p className="section-sub">Photos and flat files become searchable, connected stories.</p>
          </div>
          <div className="gallery-grid">
            {memoryItems.map((item, i) => (
              <div className="gallery-card reveal" key={item.title}>
                <div className="gallery-img">{item.scene}</div>
                <div className="gallery-caption">
                  <div>
                    <h3>{item.title}</h3>
                    <span>{item.count}</span>
                  </div>
                  <span className="gallery-count">0{i + 1}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ===================== HOW IT WORKS ===================== */}
      <section className="steps-section" id="how-it-works">
        <div className="section-container">
          <div className="section-header reveal">
            <span className="section-tag">How It Works</span>
            <h2 className="section-h2">From Upload to Living Memory</h2>
            <p className="section-sub">Four steps to a searchable, interactive legacy.</p>
          </div>
          <div className="steps-grid">
            <div className="step-card reveal">
              <div className="step-icon icon-upload">
                <IconUpload />
                <span className="pulse-ring"></span>
              </div>
              <div className="step-num">01</div>
              <h3>Upload</h3>
              <p>Voice notes, journals, emails, documents — everything that makes your story yours.</p>
            </div>
            <div className="step-card reveal">
              <div className="step-icon icon-organize">
                <IconBrain />
              </div>
              <div className="step-num">02</div>
              <h3>AI Organizes</h3>
              <p>Becomes a structured, searchable knowledge model, not a folder of files.</p>
            </div>
            <div className="step-card reveal">
              <div className="step-icon icon-query">
                <IconSearch />
              </div>
              <div className="step-num">03</div>
              <h3>Query & Explore</h3>
              <p>Get cited answers rooted in your real memories — authentic, never generic.</p>
            </div>
            <div className="step-card reveal">
              <div className="step-icon icon-grow">
                <IconTrend />
              </div>
              <div className="step-num">04</div>
              <h3>Grow Over Time</h3>
              <p>AI flags gaps and contradictions to keep enriching the archive — even later.</p>
            </div>
          </div>
        </div>
      </section>

      {/* ===================== KEY FEATURES ===================== */}
      <section className="features-section" id="features">
        <div className="section-container">
          <div className="section-header reveal">
            <span className="section-tag">Key Features</span>
            <h2 className="section-h2">Built to Preserve the Whole Person</h2>
            <p className="section-sub">Six ways EchoMind turns raw material into an authentic legacy.</p>
          </div>
          <div className="features-grid">
            <div className="feature-card reveal">
              <div className="feature-icon fc-mic"><IconMic /></div>
              <h3>Multi-format Ingestion</h3>
              <p>Recordings, journals, emails, documents, photos — ingested and understood together.</p>
            </div>
            <div className="feature-card reveal">
              <div className="feature-icon fc-brain"><IconBrain /></div>
              <h3>AI Knowledge Model</h3>
              <p>An interactive model of how you thought, what you knew, and how you decided.</p>
            </div>
            <div className="feature-card reveal">
              <div className="feature-icon fc-link"><IconLink /></div>
              <h3>Cited, Authentic Answers</h3>
              <p>Every response traces back to your own memories — transparent and explainable.</p>
            </div>
            <div className="feature-card reveal">
              <div className="feature-icon fc-timeline"><IconTimeline /></div>
              <h3>Timeline Memory Map</h3>
              <p>Your life visualized as an explorable, interactive timeline of connected events.</p>
            </div>
            <div className="feature-card reveal">
              <div className="feature-icon fc-warning"><IconWarning /></div>
              <h3>Contradiction Detection</h3>
              <p>AI gently flags inconsistencies and suggests missing life events to enrich the record.</p>
            </div>
            <div className="feature-card reveal">
              <div className="feature-icon fc-lock"><IconLock /></div>
              <h3>Private by Design</h3>
              <p>Encrypted storage, permission-based access, and on-device processing for sensitive data.</p>
            </div>
          </div>
        </div>
      </section>

      {/* ===================== WHO IT'S FOR ===================== */}
      <section className="who-section" id="who">
        <div className="section-container">
          <div className="section-header reveal">
            <span className="section-tag">Who It's For</span>
            <h2 className="section-h2">A Legacy Everyone Can Learn From</h2>
            <p className="section-sub">EchoMind serves anyone who wants their experience to outlive them.</p>
          </div>
          <div className="who-grid">
            <div className="who-card reveal">
              <span className="who-emoji" role="img" aria-label="Family">👨‍👩‍👧</span>
              <h3>Families</h3>
              <p>Keep loved ones present — their stories reachable on demand.</p>
            </div>
            <div className="who-card reveal">
              <span className="who-emoji" role="img" aria-label="Organizations">🏢</span>
              <h3>Organizations</h3>
              <p>Preserve institutional knowledge before it walks out the door.</p>
            </div>
            <div className="who-card reveal">
              <span className="who-emoji" role="img" aria-label="Educators and mentors">🎓</span>
              <h3>Educators & Mentors</h3>
              <p>Give students direct access to the reasoning behind the advice.</p>
            </div>
            <div className="who-card reveal">
              <span className="who-emoji" role="img" aria-label="Yourself">🪞</span>
              <h3>Yourself</h3>
              <p>Rediscover who you've been — and who you're becoming.</p>
            </div>
          </div>
        </div>
      </section>

      {/* ===================== PRIVACY ===================== */}
      <section className="privacy-section" id="privacy">
        <div className="section-container">
          <div className="privacy-grid">
            <div className="privacy-visual reveal" aria-hidden="true">
              <div className="privacy-shield">
                <div className="shield-core">
                  <IconLock />
                </div>
                <div className="shield-ring ring-1"></div>
                <div className="shield-ring ring-2"></div>
                <div className="shield-ring ring-3"></div>
              </div>
            </div>
            <div className="privacy-content reveal">
              <span className="section-tag">Trust / Privacy</span>
              <h2 className="section-h2">Your Story. Your Rules.</h2>
              <p className="body-large">
                EchoMind gives you full control over who can access what — down to the topic level.
              </p>
              <ul className="privacy-list">
                <li>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#0d9488" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
                  End-to-end encrypted storage
                </li>
                <li>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#0d9488" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
                  Permission-based access, down to specific topics
                </li>
                <li>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#0d9488" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
                  Sensitive memories processed entirely on-device
                </li>
                <li>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#0d9488" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
                  Nothing ever shared without your consent
                </li>
              </ul>
            </div>
          </div>
        </div>
      </section>

      {/* ===================== FINAL CTA ===================== */}
      <section className="cta-section" id="cta">
        <div className="section-container">
          <div className="cta-content reveal">
            <span className="cta-emoji" role="img" aria-hidden="true">🌅</span>
            <h2 className="cta-title">Don't Let Your Story Fade.</h2>
            <p className="cta-sub">
              Begin today. The memories you protect now become the wisdom someone discovers later.
            </p>
            <button type="button" className="btn-cta" onClick={() => go('signup')}>
              Create My EchoMind
            </button>
          </div>
        </div>
      </section>
    </>
  )
}

export default Home

/* EchoMind brand mark — abstract "E" of sound bars + echo ripples, orange→red gradient */
function Logo({ size = 34, wordmark = true }) {
  const mark = (
    <svg
      className="logo-badge"
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="logoEcho" x1="8" y1="10" x2="40" y2="38" gradientUnits="userSpaceOnUse">
          <stop stopColor="#fb923c" />
          <stop offset="0.5" stopColor="#f97316" />
          <stop offset="1" stopColor="#dc2626" />
        </linearGradient>
      </defs>
      <g stroke="url(#logoEcho)" strokeWidth="5" strokeLinecap="round">
        <path d="M9 13v22" />
        <path d="M16 15h20" />
        <path d="M16 24h10" />
        <path d="M16 33h20" />
      </g>
      <g stroke="url(#logoEcho)" fill="none" strokeLinecap="round">
        <path d="M30 20.5a4.5 4.5 0 0 1 0 7" strokeWidth="3" opacity="0.55" />
        <path d="M30 17a8 8 0 0 1 0 14" strokeWidth="3" opacity="0.25" />
      </g>
    </svg>
  )

  if (!wordmark) return mark

  return (
    <span className="logo-lockup">
      {mark}
      <span className="logo-wordmark">
        <span className="wm-echo">echo</span>
        <span className="wm-mind">mind</span>
      </span>
    </span>
  )
}

export default Logo
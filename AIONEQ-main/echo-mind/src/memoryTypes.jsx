const iconProps = {
  width: 26,
  height: 26,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
}

const IconMic = () => (
  <svg {...iconProps}>
    <rect x="9" y="2" width="6" height="12" rx="3" />
    <path d="M5 10v2a7 7 0 0 0 14 0v-2" />
    <path d="M12 19v3" />
  </svg>
)

const IconNotebook = () => (
  <svg {...iconProps}>
    <path d="M4 4h13a2 2 0 0 1 2 2v14H6a2 2 0 0 1-2-2z" />
    <path d="M4 6a2 2 0 0 1 2-2" />
    <path d="M9 8h6" />
    <path d="M9 12h6" />
  </svg>
)

const IconMail = () => (
  <svg {...iconProps}>
    <rect x="2" y="4" width="20" height="16" rx="2" />
    <path d="m22 6-10 7L2 6" />
  </svg>
)

const IconFile = () => (
  <svg {...iconProps}>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <path d="M14 2v6h6" />
    <path d="M9 13h6" />
    <path d="M9 17h6" />
  </svg>
)

const IconBook = () => (
  <svg {...iconProps}>
    <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
    <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
  </svg>
)

export const MEMORY_TYPES = [
  { type: 'voice', title: 'Voice Recording', desc: 'Preserve a spoken memory or recording.', Eyebrow: 'VOICE RECORDING', Icon: IconMic, fileBased: true },
  { type: 'journal', title: 'Journal Entry', desc: 'Capture thoughts, entries, and reflections.', Eyebrow: 'JOURNAL ENTRY', Icon: IconNotebook, fileBased: false },
  { type: 'email', title: 'Email / Letter', desc: 'Save important messages and letters.', Eyebrow: 'EMAIL / LETTER', Icon: IconMail, fileBased: false },
  { type: 'document', title: 'Document', desc: 'Upload files, certificates, or notes.', Eyebrow: 'DOCUMENT', Icon: IconFile, fileBased: true },
  { type: 'story', title: 'Story / Note', desc: 'Write a memory in your own words.', Eyebrow: 'STORY / NOTE', Icon: IconBook, fileBased: false },
]

export function getMemoryType(type) {
  return MEMORY_TYPES.find((m) => m.type === type)
}
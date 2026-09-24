const SUGGESTIONS = [
  'What did I do last summer?',
  'What have I written about my grandmother?',
  'Where was my favorite vacation and why?',
  'What were my biggest goals last year?',
]

function SuggestedQuestions({ onPick, disabled }) {
  return (
    <div className="suggestions">
      <p className="suggestions-label">Start with a question, like:</p>
      <div className="suggestions-row">
        {SUGGESTIONS.map((q) => (
          <button type="button" key={q} className="suggestion-chip" disabled={disabled} onClick={() => onPick(q)}>
            {q}
          </button>
        ))}
      </div>
    </div>
  )
}

export default SuggestedQuestions
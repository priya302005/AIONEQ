// Minimal SSE probe for the local llama server: confirms the chat endpoint
// really emits incremental data frames rather than one buffered blob.
const url = 'http://127.0.0.1:4891/v1/chat/completions'

const res = await fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: 'qwen2.5-3b-instruct',
    messages: [{ role: 'user', content: 'Say hi in one short sentence.' }],
    stream: true,
    max_tokens: 24,
  }),
})

console.log('status', res.status, '| content-type:', res.headers.get('content-type'))
if (!res.ok || !res.body) {
  console.log('body:', await res.text())
  process.exit(1)
}

const reader = res.body.getReader()
const dec = new TextDecoder()
let frames = 0
let text = ''
let done = false
const started = Date.now()

while (!done) {
  const { value, done: finished } = await reader.read()
  if (finished) break
  for (const line of dec.decode(value, { stream: true }).split('\n')) {
    if (!line.startsWith('data:')) continue
    const payload = line.slice(5).trim()
    if (payload === '[DONE]') { done = true; break }
    try {
      const json = JSON.parse(payload)
      const delta = json.choices?.[0]?.delta?.content
      if (delta) { frames++; text += delta }
    } catch { /* keep-alive comment */ }
  }
}

console.log('frames:', frames, '| elapsed ms:', Date.now() - started)
console.log('text:', JSON.stringify(text))
console.log(frames > 1 ? 'PASS: incremental streaming works' : 'FAIL: single frame, not a stream')

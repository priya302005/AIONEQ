function groupKey(iso) {
  const d = iso ? new Date(iso) : null
  if (!d || Number.isNaN(d.getTime())) return 'Older'
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const day = Math.floor((today - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) / 86400000)
  if (day <= 0) return 'Today'
  if (day === 1) return 'Yesterday'
  if (day <= 7) return 'Previous 7 days'
  if (day <= 30) return 'Previous 30 days'
  return 'Older'
}

const GROUP_ORDER = ['Today', 'Yesterday', 'Previous 7 days', 'Previous 30 days', 'Older']

export function groupConversations(list) {
  const buckets = { Today: [], Yesterday: [], 'Previous 7 days': [], 'Previous 30 days': [], Older: [] }
  for (const c of list || []) {
    const key = groupKey(c.updatedAt)
    buckets[key].push(c)
  }
  return GROUP_ORDER.map((label) => ({ label, items: buckets[label] })).filter((g) => g.items.length > 0)
}
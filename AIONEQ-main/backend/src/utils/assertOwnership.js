export function assertMemoryOwnership(memory, userId) {
  if (!memory || memory.user_id !== userId) {
    const err = new Error('Not authorized to edit this memory.')
    err.status = 403
    throw err
  }
}
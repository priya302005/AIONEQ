/*
 * Memory relationship ("link") endpoints.
 *
 * A link records how two memories relate: the same event said twice, a
 * follow-up, an update that supersedes an older memory, or simply the same
 * subject. Automatic detection only ever creates PROPOSALS.
 *
 * This controller is where the USER makes any of it real. Approving a
 * 'supersedes' link tells the assistant that the newer memory is the current
 * state of that subject. It does not delete, merge, or rewrite anything: the
 * older memory stays stored, stays readable, stays citable, and the link can be
 * rejected at any time to undo the decision.
 */

import { asyncHandler } from '../utils/asyncHandler.js'
import { audit } from '../utils/audit.js'
import { assertMemoryOwnership } from '../utils/assertOwnership.js'
import { findMemoryById } from '../models/memory.model.js'
import {
  linksForMemory,
  getMemoryLink,
  resolveMemoryLink,
  removeMemoryLink,
  proposeMemoryLink,
} from '../models/memoryLink.model.js'

/** Loads the other memory in a link and proves the caller owns both. */
async function loadOwnedMemory(token, id, userId) {
  const { data, error } = await findMemoryById(token, id)
  if (error) return { memory: null, error: error.message }
  if (!data) return { memory: null, error: 'Memory not found.' }
  assertMemoryOwnership(data, userId)
  return { memory: data, error: null }
}

/** GET /api/memory-links?memoryId=... - proposals + decisions for a memory. */
export const listLinksController = asyncHandler(async (req, res) => {
  const { memoryId, status } = req.query // zod-validated

  const owned = await loadOwnedMemory(req.accessToken, memoryId, req.user.id)
  if (owned.error) {
    return res.status(owned.memory ? 403 : 404).json({ success: false, message: owned.error })
  }

  const links = await linksForMemory(req.accessToken, memoryId)

  // Resolve each linked memory so the UI can show a title instead of an id.
  const related = await Promise.all(
    links.map(async (link) => {
      const otherId = link.source_memory_id === memoryId ? link.related_memory_id : link.source_memory_id
      const other = await findMemoryById(req.accessToken, otherId)
      return {
        ...link,
        direction: link.source_memory_id === memoryId ? 'outgoing' : 'incoming',
        relatedMemory: other.data
          ? {
              id: other.data.id,
              title: other.data.title,
              type: other.data.type,
              eventDate: other.data.event_date,
              preview: String(other.data.content || other.data.transcript || other.data.ai_summary || '').slice(0, 160),
            }
          : null,
      }
    })
  )

  res.json({
    success: true,
    data: status ? related.filter((l) => l.status === status) : related,
  })
})

/**
 * POST /api/memory-links - the user links two memories themselves, e.g. to
 * record that a newer note adds detail to an older event. Created as APPROVED
 * because the user is stating it directly, not asking for a suggestion.
 */
export const createLinkController = asyncHandler(async (req, res) => {
  const { relatedMemoryId, relation } = req.body // zod-validated

  const source = await loadOwnedMemory(req.accessToken, req.params.id, req.user.id)
  if (source.error) return res.status(403).json({ success: false, message: source.error })

  const related = await loadOwnedMemory(req.accessToken, relatedMemoryId, req.user.id)
  if (related.error) {
    return res.status(403).json({ success: false, message: related.error })
  }
  if (relatedMemoryId === req.params.id) {
    return res.status(400).json({ success: false, message: 'A memory cannot be linked to itself.' })
  }

  const { data, error } = await proposeMemoryLink(req.accessToken, {
    user_id: req.user.id,
    source_memory_id: req.params.id,
    related_memory_id: relatedMemoryId,
    relation,
    confidence: 1,
    detail: 'Linked by you.',
  })

  if (error) return res.status(400).json({ success: false, message: error.message })

  audit({ action: 'memory.link_create', userId: req.user.id, ip: req.ip, detail: { memoryId: req.params.id, relation } })
  res.status(201).json({ success: true, message: 'Memories linked.', data })
})

/**
 * PATCH /api/memory-links/:id - approve or reject a proposal.
 * This is the only path by which an automatic finding takes effect.
 */
export const resolveLinkController = asyncHandler(async (req, res) => {
  const { id } = req.params
  const { status } = req.body // zod-validated

  const existing = await getMemoryLink(req.accessToken, id)
  if (existing.error) return res.status(400).json({ success: false, message: existing.error.message })
  if (!existing.data) {
    return res.status(404).json({ success: false, message: 'That suggestion no longer exists.' })
  }
  // Defense in depth: RLS already scopes this, but a link must never be
  // resolved by anyone but its owner.
  if (existing.data.user_id !== req.user.id) {
    audit({ action: 'memory.link_denied', userId: req.user.id, ip: req.ip, detail: { linkId: id } })
    return res.status(403).json({ success: false, message: 'You do not have access to this suggestion.' })
  }

  const { data, error } = await resolveMemoryLink(req.accessToken, id, status)
  if (error) return res.status(400).json({ success: false, message: error.message })
  if (!data) return res.status(404).json({ success: false, message: 'That suggestion no longer exists.' })

  audit({
    action: status === 'approved' ? 'memory.link_approved' : 'memory.link_rejected',
    userId: req.user.id,
    ip: req.ip,
    detail: { linkId: id, relation: data.relation },
  })
  res.json({ success: true, message: status === 'approved' ? 'Suggestion accepted.' : 'Suggestion dismissed.', data })
})

/** DELETE /api/memory-links/:id - remove a link entirely. */
export const deleteLinkController = asyncHandler(async (req, res) => {
  const { id } = req.params

  const existing = await getMemoryLink(req.accessToken, id)
  if (existing.error) return res.status(400).json({ success: false, message: existing.error.message })
  if (!existing.data) return res.status(404).json({ success: false, message: 'That suggestion no longer exists.' })
  if (existing.data.user_id !== req.user.id) {
    return res.status(403).json({ success: false, message: 'You do not have access to this suggestion.' })
  }

  const { error } = await removeMemoryLink(req.accessToken, id)
  if (error) return res.status(400).json({ success: false, message: error.message })

  audit({ action: 'memory.link_delete', userId: req.user.id, ip: req.ip, detail: { linkId: id } })
  res.json({ success: true, message: 'Link removed.' })
})
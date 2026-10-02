import crypto from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { config } from '../config/config.js'
import { asyncHandler } from '../utils/asyncHandler.js'
import { audit } from '../utils/audit.js'
import {
  hashSha256,
  generateClaimToken,
  createGrant,
  listGrants,
  getGrantById,
  findPendingGrantByEmail,
  revokeGrantRow,
  activateGrant,
  listActiveGrantsForRecipient,
  listPendingGrantsForEmail,
  findMemoriesByOwner,
} from '../models/legacy.model.js'
import { findMemories } from '../models/memory.model.js'

function safeGrant(grant) {
  if (!grant) return grant
  return {
    id: grant.id,
    recipientEmail: grant.recipient_email,
    grantType: grant.grant_type,
    status: grant.status,
    createdAt: grant.created_at,
    activatedAt: grant.activated_at,
    revokedAt: grant.revoked_at,
  }
}

/**
 * Legacy access. The owner designates recipients who - after the owner passes
 * away - can read their archive. Activation happens while the owner is still
 * alive (they pre-share a one-time claim token + optional access code), so
 * the grant is verifiable and revocable. Verification mode is configurable
 * via LEGACY_VERIFICATION (none | access-code | trusted-contact).
 */
export const createGrantController = asyncHandler(async (req, res) => {
  const { recipientEmail, accessCode, grantType } = req.body // zod-validated

  if (recipientEmail.toLowerCase() === (req.user.email || '').toLowerCase()) {
    return res.status(400).json({ success: false, message: 'You cannot grant access to yourself.' })
  }

  const verification = config.legacyVerification
  if (verification !== 'none' && !accessCode) {
    return res.status(400).json({
      success: false,
      message: `Current policy (LEGACY_VERIFICATION=${verification}) requires you to set a shared access code for this grant.`,
    })
  }
  if (!accessCode && verification === 'none') {
    // still allow, but a code strengthens the grant
  }

  const claimToken = generateClaimToken()
  const payload = {
    owner_id: req.user.id,
    recipient_email: recipientEmail.toLowerCase(),
    grant_type: grantType,
    status: 'pending',
    claim_token_hash: hashSha256(claimToken),
    access_code_hash: accessCode ? hashSha256(accessCode) : null,
  }

  // REUSE rule: a duplicate pending grant is refused (least privilege).
  const existing = await findPendingGrantByEmail(req.accessToken, recipientEmail.toLowerCase())
  if (existing.data && existing.data.owner_id === req.user.id && existing.data.status === 'pending') {
    return res.status(409).json({
      success: false,
      message: 'A pending grant already exists for that recipient. Revoke it first or share its new claim token.',
    })
  }

  const { data, error } = await createGrant(req.accessToken, payload)
  if (error) {
    return res.status(400).json({ success: false, message: error.message })
  }

  audit({ action: 'legacy.grant_created', userId: req.user.id, ip: req.ip, detail: { grantId: data.id, grantType } })
  res.status(201).json({ success: true, data: safeGrant(data), claimToken })
})

export const listGrantsController = asyncHandler(async (req, res) => {
  const { data, error } = await listGrants(req.accessToken, req.user.id)
  if (error) return res.status(400).json({ success: false, message: error.message })
  res.json({ success: true, data: (data || []).map(safeGrant) })
})

export const revokeGrantController = asyncHandler(async (req, res) => {
  const { id } = req.params
  const existing = await getGrantById(req.accessToken, id)
  if (existing.error) return res.status(400).json({ success: false, message: existing.error.message })
  if (!existing.data) return res.status(404).json({ success: false, message: 'Grant not found.' })
  if (existing.data.owner_id !== req.user.id) {
    audit({ action: 'legacy.revoke_denied', userId: req.user.id, ip: req.ip, detail: { grantId: id } })
    return res.status(403).json({ success: false, message: 'You cannot revoke this grant.' })
  }

  const { data, error } = await revokeGrantRow(req.accessToken, id)
  if (error) return res.status(400).json({ success: false, message: error.message })
  if (!data) return res.status(404).json({ success: false, message: 'Grant not found.' })

  audit({ action: 'legacy.grant_revoked', userId: req.user.id, ip: req.ip, detail: { grantId: data.id } })
  res.json({ success: true, data: safeGrant(data) })
})

export const claimGrantController = asyncHandler(async (req, res) => {
  const { id } = req.params
  const { claimToken, accessCode } = req.body // zod-validated

  const existing = await getGrantById(req.accessToken, id)
  if (existing.error) return res.status(400).json({ success: false, message: existing.error.message })
  if (!existing.data) return res.status(404).json({ success: false, message: 'Grant not found.' })

  const grant = existing.data
  // The callers' email must match the designated recipient (verified by RLS too).
  if ((req.user.email || '').toLowerCase() !== grant.recipient_email) {
    audit({ action: 'legacy.claim_email_mismatch', userId: req.user.id, ip: req.ip, detail: { grantId: id } })
    return res.status(403).json({ success: false, message: 'This grant was not issued to your email address.' })
  }
  if (grant.status === 'revoked') {
    return res.status(403).json({ success: false, message: 'This grant has been revoked by the owner.' })
  }
  if (grant.status === 'active') {
    return res.status(409).json({ success: false, message: 'This grant is already active.' })
  }

  if (!crypto.timingSafeEqual(Buffer.from(grant.claim_token_hash), Buffer.from(hashSha256(claimToken)))) {
    audit({ action: 'legacy.claim_bad_token', userId: req.user.id, ip: req.ip, detail: { grantId: id } })
    return res.status(403).json({ success: false, message: 'The claim token is invalid.' })
  }

  if (grant.access_code_hash) {
    if (!accessCode || !crypto.timingSafeEqual(Buffer.from(grant.access_code_hash), Buffer.from(hashSha256(accessCode)))) {
      audit({ action: 'legacy.claim_bad_code', userId: req.user.id, ip: req.ip, detail: { grantId: id } })
      return res.status(403).json({ success: false, message: 'The access code is invalid.' })
    }
  } else if (config.legacyVerification !== 'none') {
    return res.status(403).json({
      success: false,
      message: 'This grant requires an access code that the owner did not set; ask the owner to re-create it.',
    })
  }

  const { data, error } = await activateGrant(req.accessToken, id, req.user.id)
  if (error || !data) {
    return res.status(400).json({ success: false, message: error?.message || 'Unable to activate this grant.' })
  }

  audit({ action: 'legacy.grant_activated', userId: req.user.id, ip: req.ip, detail: { grantId: data.id, ownerId: data.owner_id } })
  res.json({ success: true, message: 'Legacy access activated.', data: safeGrant(data) })
})

export const legacyAccessOverviewController = asyncHandler(async (req, res) => {
  const { data: grants, error } = await listActiveGrantsForRecipient(req.accessToken, req.user.id)
  if (error) return res.status(400).json({ success: false, message: error.message })

  const archives = await Promise.all(
    (grants || []).map(async (g) => {
      const { data: memories, error: memError } = await findMemoriesByOwner(req.accessToken, g.owner_id)
      return {
        grantId: g.id,
        ownerId: g.owner_id,
        grantType: g.grant_type,
        activatedAt: g.activated_at,
        memoryCount: memError ? 0 : (memories || []).length,
      }
    })
  )

  res.json({ success: true, data: archives })
})

/** Pending grants awaiting claim by the signed-in user's email. */
export const pendingGrantsController = asyncHandler(async (req, res) => {
  const { data, error } = await listPendingGrantsForEmail(req.accessToken, (req.user.email || '').toLowerCase())
  if (error) return res.status(400).json({ success: false, message: error.message })
  res.json({ success: true, data: (data || []).map(safeGrant) })
})

/**
 * Read-only listing of one owner's archive, for recipients with an ACTIVE
 * grant. RLS (memories_select_legacy) enforces the authorization; this
 * controller verifies the grant exists as a second layer and hides nothing
 * RLS already allows (text or full scope).
 */
export const archiveController = asyncHandler(async (req, res) => {
  const { ownerId } = req.params
  const grants = await listActiveGrantsForRecipient(req.accessToken, req.user.id)
  const grant = (grants.data || []).find((g) => g.owner_id === ownerId)
  if (!grant) {
    audit({ action: 'legacy.archive_denied', userId: req.user.id, ip: req.ip, detail: { ownerId } })
    return res.status(403).json({ success: false, message: 'You do not have legacy access to this archive.' })
  }

  const { data, error } = await findMemoriesByOwner(req.accessToken, ownerId)
  if (error) return res.status(400).json({ success: false, message: error.message })

  audit({ action: 'legacy.archive_viewed', userId: req.user.id, ip: req.ip, detail: { ownerId, grantId: grant.id, count: (data || []).length } })
  // Remove raw files from text-only grants at the app layer too (defense in depth).
  const safe = (data || []).map((m) =>
    grant.grant_type === 'text' ? { ...m, file_url: null, mime_type: null } : m
  )
  res.json({ success: true, data: safe })
})
import { z } from 'zod'

/**
 * Request validation schemas (Zod). Applied via `validate` middleware on every
 * route. If a payload cannot be validated it is rejected outright (fail
 * closed) - EchoMind never trusts frontend input.
 */

const EMAIL = z.email().max(254).transform((v) => v.trim().toLowerCase())
const PASSWORD = z
  .string()
  .min(8, 'Password must be at least 8 characters.')
  .max(128)
  .regex(/[A-Za-z]/, 'Password must contain a letter.')
  .regex(/[0-9]/, 'Password must contain a number.')

// --------------------------------------------------------------- auth ------
export const signupSchema = z.object({
  fullName: z.string().trim().min(1).max(80).optional().default(''),
  email: EMAIL,
  password: PASSWORD,
})

export const loginSchema = z.object({
  email: EMAIL,
  password: z.string().min(1).max(128),
})

export const resetPasswordSchema = z.object({
  email: EMAIL,
})

export const updatePasswordSchema = z.object({
  password: PASSWORD,
})

// ----------------------------------------------------------- memories ------
export const createMemorySchema = z.object({
  type: z.enum(['voice', 'journal', 'email', 'document', 'story']),
  title: z.string().trim().min(1, 'Title is required.').max(200),
  content: z.string().max(200_000).optional().default(''),
  tags: z.union([z.array(z.string().trim().max(60)), z.string().max(500)]).optional().default([]),
  eventDate: z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).optional(),
  duration: z.coerce.number().int().positive().optional(),
})

export const updateMemorySchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    content: z.string().max(200_000).optional(),
    tags: z.union([z.array(z.string().trim().max(60)), z.string().max(500)]).optional(),
    eventDate: z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update.' })

export const listMemoriesQuerySchema = z.object({
  type: z.enum(['voice', 'journal', 'email', 'document', 'story']).optional(),
  sort: z
    .string()
    .regex(/^-?[a-z_]+$/)
    .optional(),
})

export const idParamSchema = z.object({
  id: z.uuid('Invalid id.'),
})

// -------------------------------------------------------------- query ------
export const askSchema = z.object({
  question: z.string().trim().min(1, 'Question is required.').max(4_000),
  conversationId: z.uuid().optional().nullable(),
})

export const renameConversationSchema = z.object({
  title: z.string().trim().min(1, 'Title is required.').max(80),
})

// -------------------------------------------------------------- export ------
export const exportSchema = z.object({
  scope: z.enum(['all', 'text']).optional().default('all'),
})

// ------------------------------------------------------------- legacy ------
export const createGrantSchema = z.object({
  recipientEmail: EMAIL,
  accessCode: z.string().trim().min(6).max(128).optional(),
  grantType: z.enum(['full', 'text']).optional().default('full'),
})

export const claimGrantSchema = z.object({
  claimToken: z.string().trim().min(8).max(256),
  accessCode: z.string().trim().max(128).optional(),
})

// ---------------------------------------------------------------- mfa ------
export const mfaVerifySchema = z.object({
  factorId: z.string().min(1).max(128),
  code: z.string().regex(/^\d{6}$/, 'Code must be a 6-digit number.'),
  challengeId: z.string().min(1).max(128).optional(),
})

// --------------------------------------------------------------- misc ------
/**
 * Express middleware factory. `schema.partial()` bodies are allowed for PUT.
 */
export function validate(schema, source = 'body') {
  return (req, res, next) => {
    const result = schema.safeParse(req[source])
    if (!result.success) {
      const first = result.error.issues[0]
      const message = first ? first.message : 'Invalid request.'
      return res.status(400).json({ success: false, message })
    }
    req[source] = result.data
    next()
  }
}
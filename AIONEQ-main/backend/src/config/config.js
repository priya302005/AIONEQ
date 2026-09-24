import dotenv from 'dotenv'

dotenv.config()

export const config = {
  port: process.env.PORT || 4000,
  supabaseUrl: process.env.SUPABASE_URL,
  supabaseAnonKey: process.env.SUPABASE_ANON_KEY,
  resetRedirectUrl: process.env.RESET_REDIRECT_URL || 'http://localhost:5173',
  localAiBaseUrl: process.env.LOCAL_AI_BASE_URL || 'http://localhost:4891',
  localAiModel: process.env.LOCAL_AI_MODEL || 'Llama 3.2 3B Instruct',
  queryMaxMemories: Number(process.env.QUERY_MAX_MEMORIES) || 6,
}
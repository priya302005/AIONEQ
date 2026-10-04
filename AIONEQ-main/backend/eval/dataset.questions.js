/*
 * EchoMind retrieval evaluation - question set with ground truth.
 *
 * Each question names the memories that genuinely answer it. The gold sets are
 * deliberately strict: for a "which rent do I pay" question, a memory that merely
 * mentions the word rent is NOT gold. Precision is measured against this.
 *
 * Ten scenarios, as required:
 *   exact          the question reuses the memory's own words
 *   paraphrase     same event, deliberately different words
 *   indirect       the question refers to something without naming it
 *   multi          several memories are genuinely needed
 *   temporal       the answer depends on WHEN
 *   changed_goal   the answer changed, and the old answer is now wrong
 *   distractors    near-identical memories that do NOT answer the question
 *   no_answer      the archive genuinely does not contain this
 *   ambiguous      two or more memories equally plausibly answer it
 *
 * `difficulty` is my own annotation of how much lexical overlap exists between
 * question and gold memories:
 *   high  - strong word overlap, any decent keyword search finds it
 *   low   - almost no word overlap, semantic understanding is required
 *   mixed - some overlap but the decisive words are absent
 */

import { byIndex as I } from './dataset.memories.js'

const q = (scenario, difficulty, question, gold = [], note, adjacent = false) => ({
  scenario,
  difficulty,
  question,
  gold: gold.map(I),
  expectNoAnswer: scenario === 'no_answer' || gold.length === 0,
  adjacent,
  note,
})

/** Shorthand for a no-answer question, with a note and an adjacency flag. */
const na = (question, note, adjacent) => q('no_answer', 'high', question, [], note, adjacent)

export const QUESTIONS = [
  // ------------------------------------------------------ 1. exact keyword --
  q('exact', 'high', 'When did I sign the tenancy agreement for Elm Road?', [6]),
  q('exact', 'high', 'What did the doctor say about my vitamin D?', [9]),
  q('exact', 'high', 'How much did the Honda Activa cost?', [20]),
  q('exact', 'high', 'What is the passport renewal paperwork I need?', [29]),
  q('exact', 'high', 'When did I join the book club?', [42]),
  q('exact', 'high', 'What happened in the power cut at the building?', [41]),

  // --------------------------------------------------------- 2. paraphrase --
  q('paraphrase', 'low', 'Why am I nervous about my next interview?', [43], '"panel interview" -> "next interview"'),
  q('paraphrase', 'low', 'Why did I give up on learning to program?', [3], '"stopped the Python course"'),
  q('paraphrase', 'mixed', 'How is my health doing these days?', [10, 11]),
  q('paraphrase', 'low', 'When did the lease on the flat start and end?', [6], 'document text vs plain words'),
  q('paraphrase', 'mixed', 'What did my manager say about the late report?', [33]),
  q('paraphrase', 'low', 'Who gave me her old handwritten recipe cards?', [31]),

  // ---------------------------------------------------------- 3. indirect --
  q('indirect', 'low', 'How much am I paying for the place I live in now?', [8]),
  q('indirect', 'low', 'What did I decide about the account charges?', [23]),
  q('indirect', 'low', 'Did the thing with my grandmother ever get better?', [36]),
  q('indirect', 'low', 'Is my blood work still a problem?', [11]),
  q('indirect', 'low', 'What was the deposit for the new place?', [24]),
  q('indirect', 'low', 'What did I end up paying for getting to work?', [20]),

  // ------------------------------------------------------------- 4. multi --
  q('multi', 'mixed', 'What have I said about my career direction over the years?', [1, 2, 3, 4, 5]),
  q('multi', 'mixed', 'Tell me everything about my grandmother health problem.', [35, 36]),
  q('multi', 'mixed', 'What have I bought to get around the city?', [20, 26]),
  q('multi', 'mixed', 'What happened with the bicycle over time?', [26, 46, 48]),
  q('multi', 'mixed', 'What have I borrowed and repaid?', [47, 24]),

  // ---------------------------------------------------------- 5. temporal --
  q('temporal', 'mixed', 'Did I go to Ooty or Coorg first?', [12, 13]),
  q('temporal', 'mixed', 'What was I doing with my evenings a year ago compared to now?', [16, 17]),
  q('temporal', 'mixed', 'How has my health test result changed since 2024?', [9, 10, 11]),
  q('temporal', 'high', 'When did I sign the renewal for the flat?', [8]),
  q('temporal', 'mixed', 'How long between starting the analytics course and finishing it?', [4, 5]),

  // -------------------------------------------------------- 6. changed goal --
  q('changed_goal', 'mixed', 'What do I actually want to do for a career now?', [3, 4]),
  q('changed_goal', 'low', 'Did I ever stick with learning to code?', [2, 3]),
  q('changed_goal', 'low', 'Have I changed my mind about my career plan?', [1, 3]),
  q('changed_goal', 'mixed', 'Should I still be learning Python?', [3], 'current answer is the one that says stop'),
  q('changed_goal', 'low', 'What did I turn down a job offer for?', [39]),

  // --------------------------------------------------------- 7. distractors --
  // Each of these has 2-3 near-identical memories that must NOT be returned.
  q('distractors', 'mixed', 'What happened with my car?', [25], 'scooter + bicycle are decoys'),
  q('distractors', 'mixed', 'Did I renew my insurance?', [28], 'passport renewal + flat renewal are decoys'),
  q('distractors', 'low', 'What is wrong with my bicycle?', [46, 48], 'car service is a decoy'),
  q('distractors', 'mixed', 'What did my cousin lend me money for?', [47]),

  // ---------------------------------------------------------- 8. no answer --
  // adjacent=true : the archive discusses the TOPIC but never this fact, so
  //   retrieving something is fine - the model must then say it is not there.
  na('What is my blood group?', 'archive has blood tests, never a blood group', true),
  na('How much do I earn per month?', 'archive mentions amounts but never salary', true),
  na('What is my passport number?', 'passport paperwork exists, no number', true),
  na('Who is my dentist?', 'one dentist appointment, never a name', true),
  na('Which gym do I go to?', 'archive mentions a lapsed gym, never a gym', true),
  na('Which bank do I have my salary account with?', 'HDFC savings, never the salary one', true),
  na('Which running shoes did I buy?', 'running is discussed, shoes never are', true),
  na("What is my mother's maiden name?", 'a grandmother exists, no genealogy', true),
  na('What is my home address?', 'street names exist, an address is never given', true),
  // The only genuinely disjoint questions: no vocabulary overlap whatsoever.
  na('Do I have any pets?', 'nothing in the archive is about animals', false),
  na('What was my childhood school called?', 'no school anywhere in the archive', false),

  // ---------------------------------------------------------- 9. ambiguous --
  q('ambiguous', 'mixed', 'What is my rent?', [7, 8], 'proposed vs actual'),
  q('ambiguous', 'mixed', 'What did the letter say?', [22, 23], 'received vs acted on'),
  q('ambiguous', 'mixed', 'How much did the vehicle cost?', [20, 26], 'scooter vs bicycle'),
  q('ambiguous', 'mixed', 'What did I do about the rent increase?', [7, 8]),
  q('ambiguous', 'low', 'Did I keep my grandmother recipe?', [31], 'only one grandmother memory is about the box'),

  // ---------------------------------------------- 10. wrong-user resistance --
  // Textually near-identical to the primary user's archive but owned by another
  // user. Nothing from OTHER_USER_MEMORIES may ever appear.
  q('paraphrase', 'low', 'Which flat did I sign the lease for?', [6], 'memory says "tenancy agreement", never "lease"; a second user owns a near-identical lease'),
]

/** Scenario labels in report order. */
export const SCENARIOS = [
  'exact',
  'paraphrase',
  'indirect',
  'multi',
  'temporal',
  'changed_goal',
  'distractors',
  'no_answer',
  'ambiguous',
]

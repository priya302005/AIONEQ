/*
 * EchoMind retrieval evaluation - synthetic memory corpus.
 *
 * WHY SYNTHETIC: an evaluation needs ground truth ("this question is answered by
 * exactly these memories"), and real user archives do not come with labels. Every
 * memory below is invented. Nothing here is copied from, or derived from, any
 * real person's data, and none of this text appears in production code paths.
 *
 * WHAT IT IS FOR: measuring whether the hybrid retriever finds the memory a
 * person means when they describe an event in their own words. The corpus is
 * built to be ADVERSARIAL to keyword matching, because that is what the previous
 * generation of this system did:
 *
 *   - near-duplicate topics where only one memory actually answers the question
 *     (the scooter/bicycle/car-service cluster, the grandmother cluster)
 *   - a topic that genuinely CHANGES over time (coding -> analytics), where the
 *     old answer is now wrong and must not be presented as current
 *   - memories with no corresponding question at all, so a retriever that always
 *     returns its "best" guess instead of admitting absence is caught
 *   - questions about things the archive genuinely never mentions, so
 *     "no-answer correctness" is measurable
 *
 * The archive is one coherent person: a working professional in Chennai, 2024
 * through late 2026. Ids are stable synthetic uuids so results are reproducible.
 */

const id = (n) => `11111111-0000-4000-8000-${String(n).padStart(12, '0')}`

/** Shorthand: one memory row. `day` is the event date (what a person means by "when"). */
function m(n, type, title, content, day, extra = {}) {
  return {
    id: id(n),
    // `extra.user_id` must win: the second user's decoy rows are only a real
    // cross-user test if they are genuinely owned by somebody else.
    user_id: extra.user_id ?? 'user-eval-primary',
    type,
    title,
    content,
    transcript: extra.transcript ?? '',
    extracted_text: extra.extracted_text ?? '',
    tags: extra.tags ?? [],
    topics: extra.topics ?? [],
    keywords: extra.keywords ?? [],
    entities: extra.entities ?? [],
    ai_summary: extra.ai_summary ?? null,
    file_url: extra.file_url ?? null,
    mime_type: extra.mime_type ?? null,
    source_kind: extra.source_kind ?? 'typed',
    processing_status: 'ready',
    processing_stage: 'complete',
    event_date: `${day}T09:00:00.000Z`,
    created_at: `${day}T09:05:00.000Z`,
    updated_at: `${day}T09:05:00.000Z`,
  }
}

export const PRIMARY_USER_ID = 'user-eval-primary'

/**
 * A second user's archive, present ONLY to prove the retriever cannot reach it.
 * Every question below must score zero results from these rows even though the
 * texts are deliberately near-identical to the primary user's.
 */
export const OTHER_USER_MEMORIES = [
  m(900, 'journal', 'Lease for the Pune flat', 'Signed the lease for a flat in Kothrud, Pune. Move is in December.', '2025-02-01', {
    user_id: 'user-eval-secondary',
  }),
  m(901, 'journal', 'Amma sixty', 'Amma turned sixty today and we went out for lunch.', '2024-02-14', {
    user_id: 'user-eval-secondary',
  }),
  m(902, 'journal', 'Python course', 'Enrolled in a beginner Python course in the evenings after work.', '2024-11-03', {
    user_id: 'user-eval-secondary',
  }),
]

export const MEMORIES = [
  // ---------------------------------------------------------------- career --
  // A goal that changes. m01/m02 are the OLD answer; m03 onward is the current
  // one. A good retriever must find both, and the context layer must not let the
  // old one win.
  m(1, 'journal', 'Wanting to learn to code', 'I keep telling myself I will learn Python properly this year. I am interested in becoming a software developer one day.', '2024-03-12', {
    topics: ['career', 'learning'],
    keywords: ['python', 'developer'],
    entities: ['Python'],
  }),
  m(2, 'journal', 'Started a Python course', 'Enrolled in a beginner Python course at a local institute. Two hours every evening after work. Tired but enjoying it.', '2024-11-03', {
    topics: ['career', 'learning'],
    keywords: ['python', 'course'],
    entities: ['Python'],
  }),
  m(3, 'voice', 'Why I stopped the coding course', 'I have decided to stop the Python course. Spreadsheets all day left me no energy to study in the evenings. I am switching to Business Analytics, which is much closer to the work I already do.', '2025-06-20', {
    topics: ['career', 'decision'],
    keywords: ['python', 'analytics', 'gave up'],
    entities: ['Python', 'Business Analytics'],
    source_kind: 'transcribed',
  }),
  m(4, 'journal', 'Enrolled in Business Analytics', 'Signed up for a six month Business Analytics certificate programme. It covers SQL, Power BI and statistics. This feels far more doable than learning to program from scratch.', '2025-07-05', {
    topics: ['career', 'learning'],
    keywords: ['analytics', 'certificate', 'sql'],
    entities: ['Business Analytics', 'SQL', 'Power BI'],
  }),
  m(5, 'journal', 'Finished the analytics certificate', 'Completed the Business Analytics certificate. My capstone was a churn dashboard for a telecom client. I am genuinely proud of this one.', '2026-08-19', {
    topics: ['career', 'achievement'],
    keywords: ['analytics', 'capstone'],
    entities: ['Business Analytics'],
  }),

  // ------------------------------------------------------------------ home --
  m(6, 'document', 'Tenancy agreement, 14 Elm Road', '', '2025-02-14', {
    extracted_text:
      'This tenancy agreement is for the flat at 14 Elm Road. The tenancy runs from 1 March 2025 to 30 September 2025. The rent is 24000 per month, payable in advance.',
    topics: ['home', 'legal'],
    source_kind: 'extracted',
    mime_type: 'application/pdf',
    file_url: 'eval-tenancy.pdf',
  }),
  m(7, 'journal', 'Flat renewal decision', 'The Elm Road landlord wants to raise the rent to 28000. I am deciding whether to stay or find somewhere cheaper closer to work.', '2025-09-28', {
    topics: ['home', 'money'],
    keywords: ['rent', 'elm road'],
    entities: ['Elm Road'],
  }),
  m(8, 'journal', 'Signed the renewal at Elm Road', 'Agreed to stay at 14 Elm Road. Rent goes up to 27000 from December. The landlord repaired the geyser as part of the deal.', '2025-10-30', {
    topics: ['home', 'money'],
    keywords: ['rent', 'renewal', 'elm road'],
    entities: ['Elm Road'],
  }),

  // ---------------------------------------------------------------- health --
  m(9, 'voice', 'Blood test results', 'The doctor said my vitamin D is low and my cholesterol is slightly high. Prescribed vitamin D supplements and told me to walk thirty minutes every day.', '2024-07-21', {
    topics: ['health'],
    keywords: ['vitamin d', 'cholesterol'],
    entities: ['vitamin D'],
    source_kind: 'transcribed',
  }),
  m(10, 'journal', 'Six month checkup', 'Blood work done again. Vitamin D is back to normal. Cholesterol is still a bit high. The doctor said keep walking and cut down on late night snacks.', '2025-05-02', {
    topics: ['health'],
    keywords: ['vitamin d', 'cholesterol', 'checkup'],
  }),
  m(11, 'journal', 'Stopped the supplements', 'The doctor said I can stop the vitamin D supplements now. My levels have been stable for a year and there is no reason to keep taking them.', '2026-01-08', {
    topics: ['health'],
    keywords: ['vitamin d', 'supplements'],
  }),

  // --------------------------------------------------------------- travel --
  m(12, 'journal', 'Trip to Ooty', 'Spent four days in Ooty with my cousins. Walked through the tea gardens early in the morning before the crowds arrived. Cold but beautiful.', '2024-12-15', {
    topics: ['travel'],
    keywords: ['ooty', 'tea gardens'],
    entities: ['Ooty'],
  }),
  m(13, 'journal', 'Coorg trip with Ritu', 'Three days in Coorg with Ritu. We stayed at a plantation homestay and went rafting on the Kaveri. Ritu wants to go back next year.', '2025-08-11', {
    topics: ['travel'],
    keywords: ['coorg', 'rafting'],
    entities: ['Coorg', 'Kaveri', 'Ritu'],
  }),
  m(14, 'journal', 'Kenya safari booked', 'Booked a ten day safari trip to Kenya in November. This is the first time I have been to Africa and I am properly excited about it.', '2026-03-22', {
    topics: ['travel'],
    keywords: ['kenya', 'safari'],
    entities: ['Kenya'],
  }),

  // ------------------------------------------------------- habits (evolving) --
  m(15, 'journal', 'Waking up early to study', 'Getting up at five thirty every morning to study before work. The quiet hour is the best part of my day.', '2024-05-09', {
    topics: ['habits', 'routine'],
    keywords: ['morning', 'study'],
  }),
  m(16, 'journal', 'Giving up the early mornings', 'Stopped waking at five thirty. Trying to sleep properly instead and studying after dinner, but I keep falling asleep on the sofa.', '2025-04-17', {
    topics: ['habits', 'routine'],
    keywords: ['morning', 'sleep', 'study'],
  }),
  m(17, 'journal', 'Started running', 'Began running three kilometres every other evening. Slower than I would like, but it is the first thing I can keep doing without hating it.', '2026-02-10', {
    topics: ['habits', 'health'],
    keywords: ['running', 'exercise'],
  }),
  m(18, 'journal', 'Joined a half marathon', 'Signed up for a half marathon in Chennai in December. The training plan says twelve weeks. This is the first race I have ever entered.', '2025-09-05', {
    topics: ['habits', 'health'],
    keywords: ['half marathon', 'race'],
    entities: ['Chennai'],
  }),

  // --------------------------------------------------------------- family --
  m(19, 'journal', 'Amma sixtieth birthday', 'Amma turned sixty today. Took her out for lunch at a place she has wanted to try for years. She loved the filter coffee.', '2024-02-14', {
    topics: ['family'],
    keywords: ['amma', 'birthday'],
    entities: ['Amma'],
  }),
  m(20, 'journal', 'Bought a scooter', 'Bought a used Honda Activa to commute instead of taking two buses. It cost 68000 and I financed it over two years.', '2025-11-02', {
    topics: ['transport', 'money'],
    keywords: ['scooter', 'commute'],
    entities: ['Honda Activa'],
  }),
  m(21, 'journal', 'That conversation with Appa', 'Appa finally talked about leaving his job at forty. I did not know he had been offered a role in Pune and turned it down. It reframed a lot for me.', '2026-06-14', {
    topics: ['family', 'career'],
    keywords: ['appa', 'pune'],
    entities: ['Appa', 'Pune'],
  }),

  // ------------------------------------------------------------ ambiguous --
  m(22, 'journal', 'The letter from the bank', 'Received a letter from HDFC about my account. Nothing urgent, they have updated their charges. I should read it properly later.', '2025-03-08', {
    topics: ['money', 'admin'],
    keywords: ['hdfc', 'letter', 'account'],
    entities: ['HDFC'],
  }),
  m(23, 'journal', 'Reading the bank letter properly', 'Finally read the HDFC letter. My savings account fee goes up from next month unless I keep a higher balance. I will switch the salary account.', '2025-03-09', {
    topics: ['money', 'admin'],
    keywords: ['hdfc', 'letter', 'account', 'fee'],
    entities: ['HDFC'],
  }),
  m(24, 'journal', 'The flat deposit', 'The deposit for the new place is one month rent plus the broker, about 35000. I need to arrange that before the end of the month.', '2026-05-06', {
    topics: ['home', 'money'],
    keywords: ['deposit', 'broker'],
  }),

  // ------------------------------------------- distractors: similar, other --
  m(25, 'journal', 'Car service', 'Took the car in for its scheduled service at the garage. They said the timing belt needs replacing next year. Cost around 9000.', '2025-12-01', {
    topics: ['transport'],
    keywords: ['car', 'service', 'garage'],
  }),
  m(26, 'journal', 'Bought a bicycle', 'Bought a second hand bicycle to ride down to the bus stop. It was 4000, from a colleague who was moving abroad.', '2024-08-19', {
    topics: ['transport'],
    keywords: ['bicycle', 'bus'],
  }),
  m(27, 'journal', 'The new laptop', 'Got a new laptop for work, a 14 inch machine with 16GB of RAM. The old one could not run the analytics tools properly any more.', '2026-07-21', {
    topics: ['work', 'tech'],
    keywords: ['laptop', 'ram'],
  }),
  m(28, 'journal', 'Insurance renewal', 'Renewed the health insurance policy. The premium went up by 900 a year but the cover is better. Also added my parents to it.', '2025-01-30', {
    topics: ['money', 'family', 'health'],
    keywords: ['insurance', 'premium'],
  }),
  m(29, 'journal', 'Passport renewal paperwork', 'Started the passport renewal paperwork. I need the old passport, three photos and a utility bill as address proof.', '2026-04-03', {
    topics: ['admin'],
    keywords: ['passport', 'renewal'],
  }),
  m(30, 'story', 'How I learned to cook', 'Taught myself to cook by watching my grandmother. Started with dal and rice and worked up slowly to a full biryani that turned out well.', '2024-10-11', {
    topics: ['family', 'cooking'],
    keywords: ['cooking', 'biryani'],
  }),
  m(31, 'voice', "Grandmother's recipe box", "Grandmother gave me her recipe box. Handwritten cards going back to the 1970s. I cried a little reading the one for her mother's biryani.", '2026-09-12', {
    topics: ['family', 'cooking'],
    keywords: ['recipe', 'grandmother'],
    source_kind: 'transcribed',
  }),
  m(32, 'journal', 'Gym membership lapsed', 'My gym membership expired and I have not renewed it. Running outside is cheaper anyway.', '2025-06-01', {
    topics: ['habits', 'health'],
    keywords: ['gym', 'membership'],
  }),
  m(33, 'email', 'Re: quarterly report deadline', 'Told my manager the quarterly report will be three days late because the vendor data export is broken. Better to say so now than promise something impossible.', '2024-06-25', {
    topics: ['work'],
    keywords: ['quarterly report', 'vendor', 'deadline'],
  }),
  m(34, 'journal', 'The vendor data problem again', 'The vendor system failed again during the monthly export. Same problem as last year. I documented it properly this time with timestamps.', '2026-08-02', {
    topics: ['work'],
    keywords: ['vendor', 'export'],
  }),
  m(35, 'voice', 'Grandmother in hospital', 'Grandmother had a fall at home. She is stable in hospital. We are taking turns at the bedside.', '2025-07-19', {
    topics: ['family', 'health'],
    keywords: ['grandmother', 'hospital'],
    source_kind: 'transcribed',
  }),
  m(36, 'journal', 'Grandmother discharged', 'Grandmother came home from hospital. She is weak but recovering. The doctor wants another two weeks of rest.', '2025-08-04', {
    topics: ['family', 'health'],
    keywords: ['grandmother', 'discharged'],
  }),
  m(37, 'journal', 'Neighbourhood watch', 'Started helping with the building watch rotation. Two hours on Sunday mornings. I have spoken to a few neighbours properly for the first time in six years.', '2026-09-28', {
    topics: ['neighbours'],
    keywords: ['watch', 'building'],
  }),
  m(38, 'journal', 'Flat in Coimbatore', 'Looked at a two bedroom flat in Coimbatore with Ritu. It is too far from Chennai and the rent was 22000, so we walked away.', '2025-04-04', {
    topics: ['home'],
    keywords: ['coimbatore', 'flat', 'rent'],
    entities: ['Coimbatore', 'Chennai', 'Ritu'],
  }),
  m(39, 'journal', 'Job offer I did not take', 'A recruiter offered me a data analyst role at a bigger company for 40 percent more. I decided not to take it. I want to be somewhere I know people.', '2026-01-29', {
    topics: ['career', 'decision'],
    keywords: ['analyst', 'offer', 'recruiter'],
  }),
  m(40, 'journal', 'Teaching my cousin to code', 'Spent the evening teaching my cousin how to write her first Python script. She had a bug on the very first line and we laughed about it. It reminded me why I wanted to learn this.', '2025-05-14', {
    topics: ['family', 'learning'],
    keywords: ['python', 'teaching'],
    entities: ['Python'],
  }),
  m(41, 'journal', 'Power cut in the building', 'Power cut for four hours today because of maintenance work. The lift was out so everyone had to walk up.', '2026-08-01', {
    topics: ['home'],
    keywords: ['power cut', 'lift'],
  }),
  m(42, 'journal', 'Joined a book club', 'Joined a book club at the community centre. This month we are reading a collection of short stories.', '2025-10-05', {
    topics: ['reading'],
    keywords: ['book club'],
  }),
  m(43, 'journal', 'The panel interview', 'Had a panel interview for a role abroad. There were four people on the panel and I lost my train of thought twice. I am nervous about the second round.', '2026-10-01', {
    topics: ['career', 'work'],
    keywords: ['interview', 'panel', 'nervous'],
  }),
  m(44, 'email', 'Dentist appointment', 'Booked a dentist appointment for the cleaning that has been overdue since the new year.', '2026-06-30', {
    topics: ['health'],
    keywords: ['dentist', 'appointment'],
  }),
  m(45, 'journal', 'Watching the terrace', 'Spent an evening on the terrace watching the rain over the roofs. It made the whole week feel slower.', '2025-08-20', {
    topics: [],
    keywords: [],
  }),
  m(46, 'journal', 'Replacing the bike light', 'The bicycle light is dead again. Ordered a small USB one that clips on.', '2025-09-14', {
    topics: ['transport'],
    keywords: ['bicycle', 'light'],
  }),
  m(47, 'journal', 'Money I owe my cousin', 'My cousin lent me 6000 for the deposit and I have paid back 3000 so far. Need to sort the rest.', '2026-05-20', {
    topics: ['money', 'family'],
    keywords: ['owe', 'lent'],
  }),
  m(48, 'journal', 'The bike tyre', 'Punctured the bicycle tyre on the way to the bus stop. Patched it at the pump on the corner.', '2024-08-25', {
    topics: ['transport'],
    keywords: ['bicycle', 'tyre', 'puncture'],
  }),
]

/** id(n) -> the memory, for building question ground truth by number. */
export const byIndex = (n) => id(n)

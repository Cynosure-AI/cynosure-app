/**
 * Empty-chat greetings. The hourly lists are the baseline; date-derived
 * context (special dates, weekday, season) is layered on top so greetings
 * vary across days and the year, not only across hours.
 */

type DayPart = 'night' | 'morning' | 'afternoon' | 'evening'
type Season = 'winter' | 'spring' | 'summer' | 'autumn'
/** `any` applies to every day part except night, which belongs to the previous day as often as not. */
type DayPartGreetings = Partial<Record<DayPart | 'any', string[]>>

const HOURLY_GREETINGS: Record<number, string[]> = {
  0: [
    'Midnight mode.',
    'Still building?',
    'Late-night runtime online.',
    'New day, same session?',
    'Past midnight already.',
    'One more thing before sleep?',
  ],

  1: [
    'Quiet hours.',
    'Deep work or debugging?',
    'Burning the midnight oil?',
    'The world is mostly offline.',
    'Late-night focus.',
    'Still something to solve?',
  ],

  2: [
    'Night shift active.',
    'Still up?',
    'Everything is quieter at 2 AM.',
    'Prime time for questionable ideas.',
    'Deep into the night.',
    'What’s keeping us busy?',
  ],

  3: [
    'Graveyard session.',
    'Late-night ideas?',
    'The system is still awake.',
    'This definitely counts as late.',
    '3 AM engineering?',
    'What are we still fixing?',
  ],

  4: [
    'Almost morning.',
    'Early start or late finish?',
    'Pre-dawn focus.',
    'The morning shift is approaching.',
    'Still running?',
    'One last push before sunrise?',
  ],

  5: [
    'Early start.',
    'Good morning.',
    'Fresh run, fresh context.',
    'Up before the noise.',
    'Starting early today?',
    'Morning systems online.',
  ],

  6: [
    'Morning boot-up.',
    'Ready when you are.',
    'Good morning.',
    'Early momentum.',
    'Fresh start?',
    'Let’s get the day moving.',
  ],

  7: [
    'Good morning.',
    'What are we building today?',
    'New day, clean slate.',
    'Morning. What’s first?',
    'Ready to get started?',
    'What deserves attention today?',
  ],

  8: [
    'Morning focus.',
    'Let’s get started.',
    'What should we tackle first?',
    'Time to get things moving.',
    'What’s first on the list?',
    'Ready for a productive morning?',
  ],

  9: [
    'Work mode online.',
    'Good morning.',
    'Ready for the first task.',
    'Morning momentum.',
    'What are we working on?',
    'Let’s make something happen.',
  ],

  10: [
    'Mid-morning check-in.',
    'What needs attention?',
    'Let’s make progress.',
    'Already in the flow?',
    'What are we improving today?',
    'Ready for the next task?',
  ],

  11: [
    'Almost lunch.',
    'What are we solving next?',
    'Still in the flow.',
    'One more thing before lunch?',
    'Late-morning focus.',
    'What’s next?',
  ],

  12: [
    'Lunchtime.',
    'Midday check-in.',
    'Taking a break or pushing on?',
    'Halfway through the day.',
    'Midday mode.',
    'What are we tackling this afternoon?',
  ],

  13: [
    'Back from lunch?',
    'Early afternoon mode.',
    'What’s next on the list?',
    'Afternoon session starting?',
    'Ready for round two?',
    'Let’s pick things back up.',
  ],

  14: [
    'Afternoon focus.',
    'Let’s keep momentum.',
    'What are we improving?',
    'Back into the flow.',
    'What needs solving?',
    'Plenty of day left.',
  ],

  15: [
    'Mid-afternoon run.',
    'Still going strong.',
    'Time to refine things.',
    'What are we polishing?',
    'Afternoon momentum.',
    'Let’s knock something out.',
  ],

  16: [
    'Late-afternoon focus.',
    'What should we finish today?',
    'Let’s close some loops.',
    'What’s still open?',
    'End-of-day tasks incoming?',
    'Time to wrap up the important stuff.',
  ],

  17: [
    'Wrapping up or diving in?',
    'End-of-day push.',
    'What still needs doing?',
    'One last productive stretch?',
    'Closing time approaches.',
    'Anything worth finishing today?',
  ],

  18: [
    'Good evening.',
    'Evening session?',
    'What are we working on tonight?',
    'Workday over — or not quite?',
    'Evening mode online.',
    'What’s the plan for tonight?',
  ],

  19: [
    'Evening mode.',
    'Ready for a calmer session.',
    'What’s on your mind?',
    'Back for another round?',
    'Evening focus.',
    'What are we exploring tonight?',
  ],

  20: [
    'Night work?',
    'Evening focus.',
    'Let’s build something useful.',
    'Quiet hours are starting.',
    'What are we making tonight?',
    'Time for a side project?',
  ],

  21: [
    'Late-evening session.',
    'Ideas after hours?',
    'What should we explore?',
    'Night session starting?',
    'Still got some momentum?',
    'Good time for experiments.',
  ],

  22: [
    'Night mode.',
    'Still productive?',
    'Quiet time, sharp thoughts.',
    'Late-night focus.',
    'One more problem to solve?',
    'The distractions are gone.',
  ],

  23: [
    'Almost midnight.',
    'Final task before shutdown?',
    'Late-night thoughts?',
    'Calling it soon?',
    'One last session?',
    'Let’s finish the day strong.',
  ],
}

const FALLBACK_GREETINGS = ['How can I help?']

// Indexed by Date#getDay() (0 = Sunday).
const WEEKDAY_GREETINGS: DayPartGreetings[] = [
  {
    any: ['Sunday side project?', 'Slow Sunday.'],
    evening: ['Getting ready for Monday?', 'Planning the week ahead?'],
  },
  {
    morning: ['Fresh week. Where do we start?', 'Monday morning. Let’s set the pace.'],
    any: ['New week, clean slate.', 'Monday momentum?'],
    evening: ['Monday’s done. Mostly.'],
  },
  {
    any: ['Tuesday. Let’s get things done.', 'Tuesday focus?'],
  },
  {
    any: ['Midweek already.', 'Halfway through the week.'],
  },
  {
    any: ['Thursday. Almost there.', 'One more push before Friday?'],
  },
  {
    morning: ['Friday. Let’s wrap things up.'],
    afternoon: ['Friday afternoon. Ship it?', 'Almost weekend.'],
    evening: ['Friday night experiments?'],
    night: ['Friday night experiments?'],
    any: ['Made it to Friday.'],
  },
  {
    morning: ['Slow Saturday morning?'],
    any: ['Weekend project?', 'Saturday tinkering?'],
  },
]

const SEASONAL_GREETINGS: Record<Season, DayPartGreetings> = {
  winter: {
    any: ['Winter focus.', 'Cold outside, warm ideas.'],
    morning: ['Dark morning, bright ideas?', 'Coffee and winter light.'],
    evening: ['Dark already. Good time to focus.', 'Cozy winter session?'],
  },
  spring: {
    any: ['Spring cleaning for the backlog?', 'Spring is in the air.'],
    morning: ['Bright spring morning.'],
    evening: ['Longer days, more ideas.'],
  },
  summer: {
    any: ['Summer session.', 'Too hot to think? Let me help.'],
    morning: ['Summer morning, clear head.'],
    evening: ['Long summer evening ahead?'],
  },
  autumn: {
    any: ['Autumn focus.', 'Crisp air, clear thoughts.'],
    morning: ['Foggy autumn morning?'],
    evening: ['Autumn evening session?', 'Darker evenings, sharper focus.'],
  },
}

// Chance that a non-empty context layer is used before falling through to the
// next one (occasion → weekday → season → hourly). On an ordinary afternoon this
// yields ~30% weekday, ~14% seasonal and ~56% hourly greetings.
const OCCASION_CHANCE = 0.6
const WEEKDAY_CHANCE = 0.3
const SEASON_CHANCE = 0.2

/** Pick a greeting for the given moment, mixing hourly phrasing with date context. */
export function getGreeting(
  date: Date = new Date(),
  random: () => number = Math.random,
  southernHemisphere: boolean = isSouthernHemisphere(date.getFullYear()),
): string {
  const hour = date.getHours()
  const part = dayPartOf(hour)
  const layers: Array<[string[], number]> = [
    [occasionGreetings(date, southernHemisphere), OCCASION_CHANCE],
    [forDayPart(WEEKDAY_GREETINGS[date.getDay()], part), WEEKDAY_CHANCE],
    [forDayPart(SEASONAL_GREETINGS[seasonOf(date.getMonth(), southernHemisphere)], part), SEASON_CHANCE],
  ]
  for (const [options, chance] of layers) {
    if (options.length > 0 && random() < chance) return pick(options, random)
  }
  return pick(HOURLY_GREETINGS[hour] ?? FALLBACK_GREETINGS, random)
}

/** Greetings tied to a specific calendar date; empty on ordinary days. */
export function occasionGreetings(date: Date, southernHemisphere: boolean): string[] {
  const year = date.getFullYear()
  const month = date.getMonth() + 1
  const day = date.getDate()
  const monthName = date.toLocaleString('en-US', { month: 'long' })
  const isLastDayOfMonth = new Date(year, month, 0).getDate() === day
  const greetings: string[] = []

  if (month === 1 && day === 1) greetings.push('Happy New Year!', 'First page of a new year.', 'New year, new ideas?')
  if (month === 12 && day === 31) greetings.push('Last day of the year.', 'Wrapping up the year?', 'One more for this year?')
  if (month === 2 && day === 29) greetings.push('Leap day. A bonus day.')
  if (month === 3 && day === 14) greetings.push('Happy Pi Day.', '3.14159… Happy Pi Day.')
  if (month === 5 && day === 4) greetings.push('May the Fourth be with you.')
  if (month === 10 && day === 31) greetings.push('Happy Halloween!', 'Spooky bugs tonight?')
  if (month === 12 && day >= 24 && day <= 26) greetings.push('Happy holidays!', 'Quiet holidays, good ideas?', 'Festive session?')
  if ((month === 6 || month === 12) && day === 21) {
    const longest = (month === 6) !== southernHemisphere
    greetings.push(longest ? 'Longest day of the year.' : 'Shortest day of the year.', 'Solstice today.')
  }
  if (dayOfYear(date) === 256) greetings.push('Happy Programmer’s Day!', 'Day 256. Happy Programmer’s Day.')
  if (day === 13 && date.getDay() === 5) greetings.push('Friday the 13th. Commit carefully.', 'Friday the 13th. Backed up?')

  // Month boundaries are the weakest occasion; only use them when nothing more specific applies.
  if (greetings.length === 0 && day === 1) greetings.push(`Hello, ${monthName}.`, 'New month, fresh start.')
  if (greetings.length === 0 && isLastDayOfMonth) greetings.push(`Last day of ${monthName}.`, 'Month-end wrap-up?')

  return greetings
}

export function dayPartOf(hour: number): DayPart {
  if (hour < 5) return 'night'
  if (hour < 12) return 'morning'
  if (hour < 17) return 'afternoon'
  if (hour < 22) return 'evening'
  return 'night'
}

/** Meteorological seasons by zero-based month, flipped for the southern hemisphere. */
export function seasonOf(month: number, southernHemisphere: boolean): Season {
  const northern: Season[] = ['winter', 'spring', 'summer', 'autumn']
  const index = Math.floor(((month + 1) % 12) / 3)
  return northern[southernHemisphere ? (index + 2) % 4 : index]
}

/**
 * Infer the hemisphere from the local DST rule: if clocks are ahead in January,
 * summer is in January. Zones without DST can't be told apart and default to north.
 */
function isSouthernHemisphere(year: number): boolean {
  return new Date(year, 0, 1).getTimezoneOffset() < new Date(year, 6, 1).getTimezoneOffset()
}

function forDayPart(greetings: DayPartGreetings, part: DayPart): string[] {
  return [...(greetings[part] ?? []), ...(part === 'night' ? [] : greetings.any ?? [])]
}

function dayOfYear(date: Date): number {
  const startOfYear = Date.UTC(date.getFullYear(), 0, 0)
  return (Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) - startOfYear) / 86_400_000
}

function pick(options: string[], random: () => number): string {
  return options[Math.floor(random() * options.length)]
}

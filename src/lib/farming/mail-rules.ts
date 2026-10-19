/*
 * Reading farm arrangements out of an email (#319; examples FC2-FC12,
 * decision 570). Pure and browser-safe: fixed text rules, no AI. Dates are
 * New Zealand ones (day before month) and are worked out from the day the
 * email was sent, in New Zealand time.
 */

export const FARM_MAIL_KINDS = ["animal_health", "delivery", "stock_movement", "contractor", "deadline", "meeting"] as const;
export type FarmMailKind = (typeof FARM_MAIL_KINDS)[number];
export const FARM_MAIL_KIND_LABELS: Record<FarmMailKind, string> = {
  animal_health: "Vet or animal health",
  delivery: "Delivery",
  stock_movement: "Stock movement",
  contractor: "Contractor work",
  deadline: "Deadline",
  meeting: "Visit or meeting",
};

export type FarmRef = { id: string; name: string };

export type Arrangement = {
  kind: FarmMailKind;
  /** The arrangement as the email words it, such as "TB testing". */
  title: string;
  /** YYYY-MM-DD, or null when there's no exact date (FC4). */
  date: string | null;
  /** HH:MM, 24-hour. */
  startTime: string | null;
  endTime: string | null;
  /** FC3: wording such as "should be" or "weather permitting". */
  tentative: boolean;
  /** FC7, FC8: whether the email moves or cancels a booking. */
  change: "new" | "moved" | "cancelled";
  /** Why a person should check it (FC4, FC6, FC10); empty when it reads clearly. */
  checkReasons: string[];
  /** The farms it names (FC10, FC11). */
  farmIds: string[];
  /** The sentence it came from, at most 300 characters. */
  excerpt: string;
};

const NZ_TIME_ZONE = "Pacific/Auckland";

/** The email's day in New Zealand (YYYY-MM-DD). */
export function nzDay(iso: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: NZ_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((part) => part.type === type)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/** 0 = Sunday. */
function weekdayOf(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function longDate(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  return `${day} ${MONTH_NAMES[month - 1]} ${year}`;
}

const WEEKDAY = "(mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)";
const MONTH = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const ORDINAL = "(\\d{1,2})(?:st|nd|rd|th)?";

function weekdayIndex(text: string): number {
  const key = text.slice(0, 3).toLowerCase();
  return ["sun", "mon", "tue", "wed", "thu", "fri", "sat"].indexOf(key);
}

function monthIndex(text: string): number {
  const key = text.slice(0, 3).toLowerCase();
  return ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(key);
}

function validDate(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const value = new Date(Date.UTC(year, month - 1, day));
  if (value.getUTCMonth() !== month - 1) return null;
  return value.toISOString().slice(0, 10);
}

/** FC5: a date without a year is the next one on or after the email's day, unless it's at most 60 days before it. */
function withoutYear(month: number, day: number, sentDay: string): string | null {
  const year = Number(sentDay.slice(0, 4));
  const thisYear = validDate(year, month, day);
  if (!thisYear) return validDate(year + 1, month, day);
  if (thisYear >= addDays(sentDay, -60)) return thisYear;
  return validDate(year + 1, month, day);
}

function fullYear(text: string): number {
  const value = Number(text);
  return text.length <= 2 ? 2000 + value : value;
}

const UNCLEAR_PHRASES = [
  "early next week",
  "later next week",
  "next week",
  "later in the week",
  "later this week",
  "end of the week",
  "end of the month",
  "end of next week",
  "in a couple of weeks",
  "in a few weeks",
  "sometime",
  "soon",
];

type FoundDate = { date: string | null; unclear: string | null; reasons: string[] };

/** The first date (or no-exact-date phrase) in a sentence, relative to the day it was sent (FC3-FC6). */
export function findDate(sentence: string, sentDay: string): FoundDate | null {
  const text = sentence;
  const checkWeekday = (date: string | null, weekday: string | undefined): FoundDate | null => {
    if (!date) return null;
    if (weekday) {
      const wanted = weekdayIndex(weekday);
      const actual = weekdayOf(date);
      if (wanted !== actual) {
        return { date, unclear: null, reasons: [`${WEEKDAY_NAMES[wanted]} doesn't match ${longDate(date)} (a ${WEEKDAY_NAMES[actual]})`] };
      }
    }
    return { date, unclear: null, reasons: [] };
  };
  // "Thursday 22 October 2026", "22nd of Oct"
  let match = new RegExp(`\\b(?:${WEEKDAY},?\\s+(?:the\\s+)?)?${ORDINAL}\\s+(?:of\\s+)?${MONTH}\\b(?:,?\\s+(\\d{4}))?`, "i").exec(text);
  if (match) {
    const [, weekday, day, month, year] = match;
    const date = year ? validDate(Number(year), monthIndex(month) + 1, Number(day)) : withoutYear(monthIndex(month) + 1, Number(day), sentDay);
    const found = checkWeekday(date, weekday);
    if (found) return found;
  }
  // "October 22", "Thursday, October 22nd, 2026"
  match = new RegExp(`\\b(?:${WEEKDAY},?\\s+)?${MONTH}\\s+${ORDINAL}\\b(?:,?\\s+(\\d{4}))?`, "i").exec(text);
  if (match) {
    const [, weekday, month, day, year] = match;
    const date = year ? validDate(Number(year), monthIndex(month) + 1, Number(day)) : withoutYear(monthIndex(month) + 1, Number(day), sentDay);
    const found = checkWeekday(date, weekday);
    if (found) return found;
  }
  // "3/11", "3/11/26", "03.11.2026" (a dot only with a year, so 7.30am isn't a date)
  match = new RegExp(`(?:\\b${WEEKDAY},?\\s+)?(?<![\\d/.:])(\\d{1,2})(?:/(\\d{1,2})(?:/(\\d{2}|\\d{4}))?|\\.(\\d{1,2})\\.(\\d{2}|\\d{4}))(?![\\d/:]|\\.\\d|\\s*(?:am|pm)\\b)`, "i").exec(text);
  if (match) {
    const [, weekday, day, slashMonth, slashYear, dotMonth, dotYear] = match;
    const month = Number(slashMonth ?? dotMonth);
    const yearText = slashYear ?? dotYear;
    const date = yearText ? validDate(fullYear(yearText), month, Number(day)) : withoutYear(month, Number(day), sentDay);
    const found = checkWeekday(date, weekday);
    if (found) return found;
  }
  if (/\bthe day after tomorrow\b/i.test(text)) return { date: addDays(sentDay, 2), unclear: null, reasons: [] };
  if (/\btomorrow\b/i.test(text)) return { date: addDays(sentDay, 1), unclear: null, reasons: [] };
  if (/\btoday\b|\bthis (?:morning|afternoon|arvo)\b|\btonight\b/i.test(text)) return { date: sentDay, unclear: null, reasons: [] };
  for (const phrase of UNCLEAR_PHRASES) {
    if (new RegExp(`\\b${phrase.replace(/ /g, "\\s+")}\\b`, "i").test(text)) return { date: null, unclear: phrase, reasons: [`No exact date: '${phrase}'`] };
  }
  // A weekday on its own: the next one after the day it was sent (FC3).
  match = new RegExp(`\\b(next|this|on)?\\s*${WEEKDAY}\\b`, "i").exec(text);
  if (match) {
    const [, qualifier, weekday] = match;
    // "sat" and "sun" alone are too often other words.
    if (/^(sat|sun)$/i.test(weekday)) return null;
    const wanted = weekdayIndex(weekday);
    let date = addDays(sentDay, 1);
    while (weekdayOf(date) !== wanted) date = addDays(date, 1);
    const reasons = qualifier?.toLowerCase() === "next" ? [`'next ${WEEKDAY_NAMES[wanted]}' could mean ${longDate(date)} or the week after`] : [];
    return { date, unclear: null, reasons };
  }
  return null;
}

function clock(hourText: string, minuteText: string | undefined, meridiem: string | undefined): string | null {
  let hour = Number(hourText);
  const minute = minuteText ? Number(minuteText) : 0;
  if (minute > 59) return null;
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    const pm = meridiem.toLowerCase() === "pm";
    if (pm && hour !== 12) hour += 12;
    if (!pm && hour === 12) hour = 0;
  } else if (hour > 23) return null;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/** Times in a sentence (FC5): "9am", "7.30am", "14:00", "between 9 and 11am", "9am-12pm", "midday". */
export function findTimes(sentence: string): { start: string | null; end: string | null } {
  const range = /\b(?:between\s+)?(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?\s*(?:-|–|to|and|till|until)\s*(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)\b/i.exec(sentence);
  if (range) {
    const [, h1, m1, mer1, h2, m2, mer2] = range;
    let first = mer1 ?? mer2;
    // "11 to 1pm": the start is in the morning.
    if (!mer1 && mer2.toLowerCase() === "pm" && Number(h1) > Number(h2) && Number(h1) !== 12) first = "am";
    const start = clock(h1, m1, first);
    const end = clock(h2, m2, mer2);
    if (start && end) return { start, end };
  }
  const single = /\b(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)\b/i.exec(sentence) ?? /\b(?:at\s+)(\d{1,2}):(\d{2})\b/i.exec(sentence);
  if (single) {
    const start = clock(single[1], single[2], single[3]);
    if (start) return { start, end: null };
  }
  if (/\b(?:midday|noon)\b/i.test(sentence)) return { start: "12:00", end: null };
  return { start: null, end: null };
}

type KindRule = { kind: FarmMailKind; pattern: RegExp };

const STOCK = "(?:cattle|calves|cows|heifers|steers|bulls|lambs|ewes|hoggets|sheep|stock|bobbies)";
const KIND_RULES: KindRule[] = [
  { kind: "animal_health", pattern: /\b(?:vet(?:s)?|tb\s+test(?:ing)?|pregnancy\s+scan(?:ning)?|preg(?:nancy)?\s+test(?:ing)?|scanning|metrichecking|herd\s+test(?:ing)?|drenching|vaccinat(?:ing|ion)|dehorning|disbudding)\b/i },
  { kind: "stock_movement", pattern: new RegExp(`\\b(?:stock\\s+truck|cartage|trucking|(?:pick(?:ing)?\\s+up|collect(?:ing|ion of)?)\\s+(?:the\\s+)?${STOCK}|bobby\\s+calves|kill\\s+date|processing\\s+date)\\b`, "i") },
  { kind: "delivery", pattern: /\b(?:deliver(?:y|ing|ed)?|fert(?:iliser)?\s+truck|feed|pke|palm\s+kernel|baleage|silage|hay|fuel|dropping\s+off)\b/i },
  { kind: "contractor", pattern: /\b(?:contractors?|spreading|spreader|spraying|mowing|baling|wrapping|harvest(?:ing)?|cultivat(?:ing|ion)|drilling|sowing|regrass(?:ing)?|shearing|shearers?|crutching|fencing|fencer|digger)\b/i },
  { kind: "deadline", pattern: /\b(?:deadline|due\s+(?:by|on)|payment\s+due|must\s+be\s+(?:done|in|filed)\s+by|nait|return\s+due)\b/i },
  { kind: "meeting", pattern: /\b(?:meeting|appointment|field\s+day|discussion\s+group|farm\s+visit|inspection|audit|assessment)\b/i },
];

/** The first arrangement word in a text, and the words as written (FC12). */
export function findKind(text: string): { kind: FarmMailKind; words: string; index: number } | null {
  let best: { kind: FarmMailKind; words: string; index: number } | null = null;
  for (const rule of KIND_RULES) {
    const match = rule.pattern.exec(text);
    if (match && (!best || match.index < best.index)) best = { kind: rule.kind, words: match[0], index: match.index };
  }
  return best;
}

const TENTATIVE = /\b(?:tentative(?:ly)?|provisional(?:ly)?|pencil(?:l)?ed(?:\s+in)?|weather\s+permitting|should\s+be|hopefully|probably|might|may\s+(?:be|come|arrive|need)|tbc|to\s+be\s+confirmed|subject\s+to)\b/i;
// "Moved to Friday", "move the TB testing to 23/10": only when what follows is a day, so "moved to the runoff" isn't a change.
const WHEN_START = "(?:mon|tue|wed|thu|fri|sat|sun|next|tomorrow|today|the\\s+\\d|\\d)";
const MOVED = new RegExp(
  `\\b(?:(?:mov(?:e|ed|ing)|chang(?:e|ed|ing))\\s+(?:(?:it|this|that|the\\s+[\\w\\s]{1,30}?)\\s+)?(?:to|till|until)\\s+${WHEN_START}|reschedul(?:ed|ing)|postpon(?:ed|ing)|pushed\\s+back|brought\\s+forward)`,
  "i",
);
const CANCELLED = /\b(?:cancel(?:l)?ed|cancel(?:l)?ing|called\s+off|not\s+coming|not\s+going\s+ahead)\b/i;

/** FC9: the reply without the earlier messages it quotes. */
export function stripQuoted(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const kept: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (/^On\b.{0,200}\bwrote:\s*$/i.test(trimmed)) break;
    if (/^-{2,}\s*(?:Original Message|Forwarded message)\s*-{2,}/i.test(trimmed)) break;
    if (/^From:\s.+/i.test(trimmed) && lines.slice(index + 1, index + 5).some((next) => /^(?:Sent|Date):\s/i.test(next.trim()))) break;
    if (trimmed.startsWith(">")) continue;
    kept.push(line);
  }
  return kept.join("\n");
}

/** Sentences: lines, split again at a full stop followed by a capital letter (not inside "7.30am" or "3.11.26"). */
export function sentences(text: string): string[] {
  return text
    .split(/\n\s*\n|\n(?=\s*[-•*]\s)|\n/)
    .flatMap((line) => line.split(/(?<=[.!?])\s+(?=[A-Z])/))
    .map((sentence) => sentence.replace(/\s+/g, " ").trim())
    .filter((sentence) => sentence.length > 0);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The farms named in a text, as whole words ignoring case (FC10). */
export function farmsIn(text: string, farms: readonly FarmRef[]): string[] {
  return farms.filter((farm) => farm.name.trim() && new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(farm.name.trim())}(?![\\p{L}\\p{N}])`, "iu").test(text)).map((farm) => farm.id);
}

function titleFrom(words: string): string {
  const clean = words.replace(/\s+/g, " ").trim();
  return clean.length <= 3 ? clean.toUpperCase() : clean.charAt(0).toUpperCase() + clean.slice(1);
}

/**
 * The arrangements in an email (FC2-FC12). An arrangement needs an
 * arrangement word and a date (or a no-exact-date phrase) in the same
 * sentence, or the arrangement in the subject and the date in the text.
 * A cancellation needs no date. One per kind and date in an email.
 */
export function readEmail(input: { subject: string | null; text: string; sentAt: string; farms: readonly FarmRef[] }): Arrangement[] {
  const sentDay = nzDay(input.sentAt);
  const subject = input.subject ?? "";
  const subjectKind = findKind(subject);
  const body = stripQuoted(input.text);
  const emailFarms = farmsIn(`${subject}\n${body}`, input.farms);
  const subjectFarms = farmsIn(subject, input.farms);
  const found: Arrangement[] = [];
  for (const sentence of sentences(body)) {
    const kind = findKind(sentence) ?? subjectKind;
    if (!kind) continue;
    const cancelled = CANCELLED.test(sentence);
    const date = findDate(sentence, sentDay);
    if (!date && !cancelled) continue;
    // No exact date ("soon") only counts with the arrangement in the same sentence.
    if (date && !date.date && !findKind(sentence)) continue;
    const times = date?.date ? findTimes(sentence) : { start: null, end: null };
    const sentenceFarms = farmsIn(sentence, input.farms);
    const farmIds = sentenceFarms.length > 0 ? sentenceFarms : subjectFarms.length > 0 ? subjectFarms : emailFarms;
    const checkReasons = [...(date?.reasons ?? [])];
    if (farmIds.length > 1) {
      const names = input.farms.filter((farm) => farmIds.includes(farm.id)).map((farm) => farm.name);
      checkReasons.push(`Mentions more than one farm: ${names.sort((a, b) => a.localeCompare(b)).join(", ")}`);
    }
    const arrangement: Arrangement = {
      kind: kind.kind,
      title: titleFrom(findKind(sentence)?.words ?? kind.words),
      date: date?.date ?? null,
      startTime: times.start,
      endTime: times.end,
      tentative: TENTATIVE.test(sentence),
      change: cancelled ? "cancelled" : MOVED.test(sentence) ? "moved" : "new",
      checkReasons,
      farmIds,
      excerpt: sentence.length > 300 ? `${sentence.slice(0, 299)}…` : sentence,
    };
    if (found.some((other) => other.kind === arrangement.kind && other.date === arrangement.date && other.change === arrangement.change)) continue;
    found.push(arrangement);
  }
  return found;
}

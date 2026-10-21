import type { AccuracyMetrics, AlignmentToken } from '../types.js';

export interface NormalizationOptions {
  lowercase?: boolean;
  stripPunctuation?: boolean;
  /**
   * When true, normalizes Spanish spoken numbers ("uno", "veintitrés", "treinta y dos")
   * to digits, Spanish spoken letter names ("be", "uve", "equis", "jota", "doble uve")
   * to single letters, and splits grouped digits/alphanumeric codes ("1234BCF" -> "1 2 3 4 b c f")
   * so formatting differences do not penalize WER.
   */
  normalizeAlphanumeric?: boolean;
}

const SPANISH_MULTIWORD_LETTER_REPLACEMENTS: Array<[RegExp, string]> = [
  [/\b(?:doble\s+uve|uve\s+doble|doble\s+v|v\s+doble|doble\s+u|ve\s+doble)\b/giu, 'w'],
  [/\b(?:i\s+griega|y\s+griega)\b/giu, 'y'],
  [/\b(?:i\s+latina)\b/giu, 'i'],
  [/\b(?:be\s+alta|be\s+larga|v\s+alta|ve\s+alta|ve\s+larga)\b/giu, 'b'],
  [/\b(?:ve\s+baja|ve\s+corta|be\s+baja|be\s+corta|v\s+baja|v\s+corta)\b/giu, 'v'],
  [/\b(?:doble\s+ele|elle)\b/giu, 'll'],
  [/\b(?:doble\s+erre)\b/giu, 'rr'],
];

const SPANISH_SINGLE_LETTER_NAMES: Record<string, string> = {
  be: 'b',
  ce: 'c',
  de: 'd',
  efe: 'f',
  ge: 'g',
  je: 'g',
  hache: 'h',
  jota: 'j',
  ka: 'k',
  ca: 'k',
  ele: 'l',
  eme: 'm',
  ene: 'n',
  eñe: 'ñ',
  pe: 'p',
  cu: 'q',
  qu: 'q',
  erre: 'r',
  ere: 'r',
  ese: 's',
  te: 't',
  uve: 'v',
  ve: 'v',
  equis: 'x',
  ekis: 'x',
  ye: 'y',
  zeta: 'z',
  ceta: 'z',
  zeda: 'z',
};

const SPANISH_DIRECT_NUMBER_WORDS: Record<string, number> = {
  cero: 0,
  un: 1,
  uno: 1,
  una: 1,
  dos: 2,
  dós: 2,
  tres: 3,
  trés: 3,
  cuatro: 4,
  cinco: 5,
  seis: 6,
  séis: 6,
  siete: 7,
  ocho: 8,
  nueve: 9,
  diez: 10,
  once: 11,
  doce: 12,
  trece: 13,
  catorce: 14,
  quince: 15,
  dieciseis: 16,
  dieciséis: 16,
  diecisiete: 17,
  dieciocho: 18,
  diecinueve: 19,
  veinte: 20,
  veintiun: 21,
  veintiún: 21,
  veintiuno: 21,
  veintiuna: 21,
  veintidos: 22,
  veintidós: 22,
  veintitres: 23,
  veintitrés: 23,
  veinticuatro: 24,
  veinticinco: 25,
  veintiseis: 26,
  veintiséis: 26,
  veintisiete: 27,
  veintiocho: 28,
  veintinueve: 29,
};

const SPANISH_TENS_WORDS: Record<string, number> = {
  treinta: 30,
  cuarenta: 40,
  cincuenta: 50,
  sesenta: 60,
  setenta: 70,
  ochenta: 80,
  noventa: 90,
};

const SPANISH_HUNDREDS_WORDS: Record<string, number> = {
  cien: 100,
  ciento: 100,
  cientos: 100,
  doscientos: 200,
  doscientas: 200,
  trescientos: 300,
  trescientas: 300,
  cuatrocientos: 400,
  cuatrocientas: 400,
  quinientos: 500,
  quinientas: 500,
  seiscientos: 600,
  seiscientas: 600,
  setecientos: 700,
  setecientas: 700,
  ochocientos: 800,
  ochocientas: 800,
  novecientos: 900,
  novecientas: 900,
};

/**
 * Converts Spanish spoken numbers, letter names, and grouped alphanumeric tokens
 * into a canonical sequence of tokens so that "uno dos be" == "12B" == "1 2 B".
 */
export function normalizeSpanishAlphanumericText(input: string): string {
  if (!input) return '';

  // 1. Unicode NFKC + lowercase
  let text = input.normalize('NFKC').toLowerCase();

  // 2. Replace multi-word Spanish letter names ("doble uve", "i griega", "be alta", etc.)
  for (const [pattern, replacement] of SPANISH_MULTIWORD_LETTER_REPLACEMENTS) {
    text = text.replace(pattern, ` ${replacement} `);
  }

  // 3. Remove punctuation (converting dots/hyphens/commas to spaces)
  text = text.replace(/[^\p{L}\p{N}\s]/gu, ' ');
  const rawTokens = text.split(/\s+/).filter((t) => t.length > 0);
  if (rawTokens.length === 0) return '';

  // 4. Convert compound and single Spanish number words into digit strings
  const consumeUnderThousand = (
    tokens: string[],
    startIdx: number
  ): { value: number; nextIdx: number } | null => {
    const tok = tokens[startIdx];
    if (tok === undefined) return null;
    const next1 = tokens[startIdx + 1];
    const next2 = tokens[startIdx + 2];

    // Check for "<hundreds> + optional <tens y unit | tens | direct 1..29>"
    if (tok in SPANISH_HUNDREDS_WORDS) {
      let value = SPANISH_HUNDREDS_WORDS[tok]!;
      let idx = startIdx + 1;
      if (tok !== 'cien' && idx < tokens.length) {
        const subTok = tokens[idx]!;
        const subNext1 = tokens[idx + 1];
        const subNext2 = tokens[idx + 2];
        if (
          subTok in SPANISH_TENS_WORDS &&
          subNext1 === 'y' &&
          subNext2 !== undefined &&
          subNext2 in SPANISH_DIRECT_NUMBER_WORDS &&
          SPANISH_DIRECT_NUMBER_WORDS[subNext2]! >= 1 &&
          SPANISH_DIRECT_NUMBER_WORDS[subNext2]! <= 9
        ) {
          value +=
            SPANISH_TENS_WORDS[subTok]! + SPANISH_DIRECT_NUMBER_WORDS[subNext2]!;
          idx += 3;
        } else if (subTok in SPANISH_TENS_WORDS) {
          value += SPANISH_TENS_WORDS[subTok]!;
          idx += 1;
        } else if (
          subTok in SPANISH_DIRECT_NUMBER_WORDS &&
          SPANISH_DIRECT_NUMBER_WORDS[subTok]! >= 1 &&
          SPANISH_DIRECT_NUMBER_WORDS[subTok]! <= 29
        ) {
          value += SPANISH_DIRECT_NUMBER_WORDS[subTok]!;
          idx += 1;
        }
      }
      return { value, nextIdx: idx };
    }

    // Check for "<tens> y <unit 1..9>" (e.g. "treinta y cuatro" -> 34)
    if (
      tok in SPANISH_TENS_WORDS &&
      next1 === 'y' &&
      next2 !== undefined &&
      next2 in SPANISH_DIRECT_NUMBER_WORDS &&
      SPANISH_DIRECT_NUMBER_WORDS[next2]! >= 1 &&
      SPANISH_DIRECT_NUMBER_WORDS[next2]! <= 9
    ) {
      return {
        value: SPANISH_TENS_WORDS[tok]! + SPANISH_DIRECT_NUMBER_WORDS[next2]!,
        nextIdx: startIdx + 3,
      };
    }

    // Check for "diez y seis" / "veinte y tres"
    if (
      (tok === 'diez' || tok === 'veinte') &&
      next1 === 'y' &&
      next2 !== undefined &&
      next2 in SPANISH_DIRECT_NUMBER_WORDS &&
      SPANISH_DIRECT_NUMBER_WORDS[next2]! >= 1 &&
      SPANISH_DIRECT_NUMBER_WORDS[next2]! <= 9
    ) {
      const base = tok === 'diez' ? 10 : 20;
      return {
        value: base + SPANISH_DIRECT_NUMBER_WORDS[next2]!,
        nextIdx: startIdx + 3,
      };
    }

    // Standalone tens ("treinta", "cuarenta"...)
    if (tok in SPANISH_TENS_WORDS) {
      return {
        value: SPANISH_TENS_WORDS[tok]!,
        nextIdx: startIdx + 1,
      };
    }

    // Direct number 0..29 ("cero", "uno", "dos", ..., "veintitrés")
    if (tok in SPANISH_DIRECT_NUMBER_WORDS) {
      return {
        value: SPANISH_DIRECT_NUMBER_WORDS[tok]!,
        nextIdx: startIdx + 1,
      };
    }

    return null;
  };

  const afterNumbers: string[] = [];
  let idx = 0;

  while (idx < rawTokens.length) {
    const tok = rawTokens[idx]!;

    // Standalone "mil [optional < 1000]"
    if (tok === 'mil') {
      let total = 1000;
      idx++;
      const remainder = consumeUnderThousand(rawTokens, idx);
      if (remainder && remainder.value > 0) {
        total += remainder.value;
        idx = remainder.nextIdx;
      }
      afterNumbers.push(String(total));
      continue;
    }

    const parsed = consumeUnderThousand(rawTokens, idx);
    if (parsed !== null) {
      // Check if followed by "mil" (e.g. "dos mil trescientos")
      if (
        parsed.value >= 1 &&
        parsed.value <= 999 &&
        rawTokens[parsed.nextIdx] === 'mil'
      ) {
        let total = parsed.value * 1000;
        idx = parsed.nextIdx + 1;
        const remainder = consumeUnderThousand(rawTokens, idx);
        if (remainder && remainder.value > 0) {
          total += remainder.value;
          idx = remainder.nextIdx;
        }
        afterNumbers.push(String(total));
        continue;
      }

      afterNumbers.push(String(parsed.value));
      idx = parsed.nextIdx;
      continue;
    }

    afterNumbers.push(tok);
    idx++;
  }

  // 5. Map Spanish letter names ("be" -> "b", "uve" -> "v", "equis" -> "x", etc.)
  // and split digit groups / mixed alphanumeric codes into individual characters
  const finalTokens: string[] = [];

  for (const token of afterNumbers) {
    // a) Single spoken letter name
    if (token in SPANISH_SINGLE_LETTER_NAMES) {
      finalTokens.push(SPANISH_SINGLE_LETTER_NAMES[token]!);
      continue;
    }

    // b) Pure digits ("1234" -> "1", "2", "3", "4")
    if (/^\d+$/.test(token)) {
      for (const ch of token) {
        finalTokens.push(ch);
      }
      continue;
    }

    // c) Mixed letters and digits ("b1234xz" or "48080a" -> "b", "1", "2", "3", "4", "x", "z")
    if (/\p{L}/u.test(token) && /\p{N}/u.test(token)) {
      for (const ch of Array.from(token)) {
        finalTokens.push(ch);
      }
      continue;
    }

    // d) Consonant-only cluster of 2..6 letters typical of spelled plates/codes ("bcf", "xzw" -> "b", "c", "f")
    if (
      token.length >= 2 &&
      token.length <= 6 &&
      /^[bcdfghjklmnñpqrstvwxyz]+$/u.test(token)
    ) {
      for (const ch of Array.from(token)) {
        finalTokens.push(ch);
      }
      continue;
    }

    finalTokens.push(token);
  }

  return finalTokens.join(' ');
}

/**
 * Normalize transcript text for standard speech-to-text evaluation:
 * - Unicode NFKC normalization
 * - Optional lowercase conversion (default: true)
 * - Optional punctuation removal (default: true)
 * - Optional Spanish alphanumeric / ITN normalization (default: false)
 * - Collapsing consecutive whitespace and trimming
 */
export function normalizeTranscriptText(
  text: string,
  options: NormalizationOptions = {}
): string {
  const {
    lowercase = true,
    stripPunctuation = true,
    normalizeAlphanumeric = false,
  } = options;

  if (normalizeAlphanumeric) {
    return normalizeSpanishAlphanumericText(text);
  }

  let normalized = text.normalize('NFKC');
  if (lowercase) {
    normalized = normalized.toLowerCase();
  }
  if (stripPunctuation) {
    // Replace punctuation characters with space or remove them
    normalized = normalized.replace(/[^\p{L}\p{N}\s]/gu, ' ');
  }

  return normalized.replace(/\s+/g, ' ').trim();
}

/**
 * Tokenize normalized text into words.
 */
export function tokenizeWords(normalizedText: string): string[] {
  if (!normalizedText) {
    return [];
  }
  return normalizedText.split(' ').filter((w) => w.length > 0);
}

/**
 * Tokenize normalized text into characters (excluding spaces or keeping single spaces;
 * standard CER evaluates non-space characters or normalized string characters —
 * here we evaluate characters of the space-collapsed normalized string, or non-whitespace characters if empty).
 * Note: In standard ASR evaluation (e.g. JiWER / NIST), CER is computed on the normalized character sequence
 * (including single spaces between words, or characters). Let's compute on the normalized string characters.
 */
export function tokenizeChars(normalizedText: string): string[] {
  if (!normalizedText) {
    return [];
  }
  return Array.from(normalizedText);
}

interface EditDistanceResult {
  substitutions: number;
  deletions: number;
  insertions: number;
  hits: number;
  alignment: AlignmentToken[];
}

/**
 * Compute minimum Levenshtein edit distance and optimal alignment backtrace
 * between `refTokens` and `hypTokens`.
 */
export function computeLevenshteinAlignment(
  refTokens: string[],
  hypTokens: string[],
  includeAlignment = true
): EditDistanceResult {
  const n = refTokens.length;
  const m = hypTokens.length;

  // dp[i][j] holds minimum edit operations for refTokens[0..i-1] and hypTokens[0..j-1]
  // hitsDp[i][j] holds maximum exact matches among paths with minimum edit operations
  const width = m + 1;
  const dp = new Int32Array((n + 1) * width);
  const hitsDp = new Int32Array((n + 1) * width);

  for (let i = 0; i <= n; i++) {
    dp[i * width] = i;
  }
  for (let j = 0; j <= m; j++) {
    dp[j] = j;
  }

  for (let i = 1; i <= n; i++) {
    const refTok = refTokens[i - 1];
    const rowOffset = i * width;
    const prevRowOffset = (i - 1) * width;

    for (let j = 1; j <= m; j++) {
      const hypTok = hypTokens[j - 1];
      if (refTok === hypTok) {
        dp[rowOffset + j] = dp[prevRowOffset + (j - 1)]!;
        hitsDp[rowOffset + j] = hitsDp[prevRowOffset + (j - 1)]! + 1;
      } else {
        const subCost = dp[prevRowOffset + (j - 1)]! + 1;
        const delCost = dp[prevRowOffset + j]! + 1;
        const insCost = dp[rowOffset + (j - 1)]! + 1;
        const minCost = Math.min(subCost, delCost, insCost);
        dp[rowOffset + j] = minCost;

        let maxHits = -1;
        if (subCost === minCost) {
          maxHits = Math.max(maxHits, hitsDp[prevRowOffset + (j - 1)]!);
        }
        if (delCost === minCost) {
          maxHits = Math.max(maxHits, hitsDp[prevRowOffset + j]!);
        }
        if (insCost === minCost) {
          maxHits = Math.max(maxHits, hitsDp[rowOffset + (j - 1)]!);
        }
        hitsDp[rowOffset + j] = maxHits;
      }
    }
  }

  // Backtrack to count exact Hits, Substitutions, Deletions, Insertions
  let i = n;
  let j = m;
  let substitutions = 0;
  let deletions = 0;
  let insertions = 0;
  let hits = 0;
  const reversedAlignment: AlignmentToken[] = [];

  while (i > 0 || j > 0) {
    const currentCost = dp[i * width + j]!;
    const currentHits = hitsDp[i * width + j]!;

    if (
      i > 0 &&
      j > 0 &&
      refTokens[i - 1] === hypTokens[j - 1] &&
      currentCost === dp[(i - 1) * width + (j - 1)]! &&
      currentHits === hitsDp[(i - 1) * width + (j - 1)]! + 1
    ) {
      hits++;
      if (includeAlignment) {
        reversedAlignment.push({
          op: 'hit',
          reference: refTokens[i - 1],
          hypothesis: hypTokens[j - 1],
        });
      }
      i--;
      j--;
    } else if (
      i > 0 &&
      j > 0 &&
      currentCost === dp[(i - 1) * width + (j - 1)]! + 1 &&
      currentHits === hitsDp[(i - 1) * width + (j - 1)]!
    ) {
      substitutions++;
      if (includeAlignment) {
        reversedAlignment.push({
          op: 'substitution',
          reference: refTokens[i - 1],
          hypothesis: hypTokens[j - 1],
        });
      }
      i--;
      j--;
    } else if (
      i > 0 &&
      currentCost === dp[(i - 1) * width + j]! + 1 &&
      currentHits === hitsDp[(i - 1) * width + j]!
    ) {
      deletions++;
      if (includeAlignment) {
        reversedAlignment.push({
          op: 'deletion',
          reference: refTokens[i - 1],
        });
      }
      i--;
    } else {
      insertions++;
      if (includeAlignment) {
        reversedAlignment.push({
          op: 'insertion',
          hypothesis: hypTokens[j - 1],
        });
      }
      j--;
    }
  }

  return {
    substitutions,
    deletions,
    insertions,
    hits,
    alignment: reversedAlignment.reverse(),
  };
}

/**
 * Calculate comprehensive Word Error Rate (WER) and Character Error Rate (CER) metrics
 * between a reference transcript and a hypothesis transcript.
 */
export function calculateAccuracyMetrics(
  referenceTranscript: string,
  hypothesisTranscript: string,
  options: NormalizationOptions = {}
): AccuracyMetrics {
  const normRef = normalizeTranscriptText(referenceTranscript, options);
  const normHyp = normalizeTranscriptText(hypothesisTranscript, options);

  const refWords = tokenizeWords(normRef);
  const hypWords = tokenizeWords(normHyp);

  const wordEdit = computeLevenshteinAlignment(refWords, hypWords, true);

  let wer = 0;
  if (refWords.length > 0) {
    wer =
      (wordEdit.substitutions + wordEdit.deletions + wordEdit.insertions) /
      refWords.length;
  } else if (hypWords.length > 0) {
    wer = 1.0;
  }

  const refChars = tokenizeChars(normRef);
  const hypChars = tokenizeChars(normHyp);
  const charEdit = computeLevenshteinAlignment(refChars, hypChars, false);

  let cer = 0;
  if (refChars.length > 0) {
    cer =
      (charEdit.substitutions + charEdit.deletions + charEdit.insertions) /
      refChars.length;
  } else if (hypChars.length > 0) {
    cer = 1.0;
  }

  return {
    wer: Number(wer.toFixed(4)),
    cer: Number(cer.toFixed(4)),
    wordAccuracy: Number(Math.max(0, 1 - wer).toFixed(4)),
    charAccuracy: Number(Math.max(0, 1 - cer).toFixed(4)),
    substitutions: wordEdit.substitutions,
    deletions: wordEdit.deletions,
    insertions: wordEdit.insertions,
    hits: wordEdit.hits,
    referenceWordCount: refWords.length,
    hypothesisWordCount: hypWords.length,
    referenceCharCount: refChars.length,
    hypothesisCharCount: hypChars.length,
    charSubstitutions: charEdit.substitutions,
    charDeletions: charEdit.deletions,
    charInsertions: charEdit.insertions,
    charHits: charEdit.hits,
    wordAlignment: wordEdit.alignment,
    normalizedReference: normRef,
    normalizedHypothesis: normHyp,
  };
}

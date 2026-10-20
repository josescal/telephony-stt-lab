import type { AccuracyMetrics, AlignmentToken } from '../types.js';

export interface NormalizationOptions {
  lowercase?: boolean;
  stripPunctuation?: boolean;
}

/**
 * Normalize transcript text for standard speech-to-text evaluation:
 * - Unicode NFKC normalization
 * - Optional lowercase conversion (default: true)
 * - Optional punctuation removal while keeping alphanumeric and apostrophes inside contractions if desired, or standard punctuation stripping (default: true)
 * - Collapsing consecutive whitespace and trimming
 */
export function normalizeTranscriptText(
  text: string,
  options: NormalizationOptions = {}
): string {
  const { lowercase = true, stripPunctuation = true } = options;

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
  };
}

/** Deterministic Hebrew-oriented tokenization for the Silent Router. Not a morphological analyzer. */

const LETTER_OR_NUMBER_OR_COLON = /[^\p{L}\p{N}:]+/gu;

export function normalizeUnicode(text: string): string {
  return text.normalize("NFC").toLowerCase();
}

export function tokenizeHe(text: string): string[] {
  const spaced = normalizeUnicode(text).replace(LETTER_OR_NUMBER_OR_COLON, " ").trim();
  if (!spaced) return [];
  return spaced.split(/\s+/).filter(Boolean);
}

export function isValidHhMm(token: string): boolean {
  return /^([01]?\d|2[0-3]):[0-5]\d$/.test(token);
}

const HE_PREFIXES = ["ה", "ב", "ל", "מ", "ו", "ש", "כ"] as const;

export function stripOneHePrefix(token: string): string | null {
  for (const p of HE_PREFIXES) {
    if (token.startsWith(p) && token.length - p.length >= 2) {
      return token.slice(p.length);
    }
  }
  return null;
}

export function hasExactToken(tokens: readonly string[], word: string): boolean {
  const want = normalizeUnicode(word);
  return tokens.some((t) => t === want);
}

export function hasConsecutivePhrase(tokens: readonly string[], phrase: string): boolean {
  const parts = tokenizeHe(phrase);
  if (parts.length === 0 || parts.length > tokens.length) return false;
  for (let i = 0; i <= tokens.length - parts.length; i++) {
    if (parts.every((p, j) => tokens[i + j] === p)) return true;
  }
  return false;
}

/** Match a catalog name as consecutive tokens; the first token may carry one clitic prefix. */
export function hasCatalogName(tokens: readonly string[], name: string): boolean {
  const phrase = tokenizeHe(name.replace(/\+/g, " "));
  if (phrase.length === 0 || phrase.length > tokens.length) return false;
  for (let i = 0; i <= tokens.length - phrase.length; i++) {
    let ok = true;
    for (let j = 0; j < phrase.length; j++) {
      const tok = tokens[i + j]!;
      const want = phrase[j]!;
      if (tok === want) continue;
      if (j === 0) {
        const stripped = stripOneHePrefix(tok);
        if (stripped === want) continue;
      }
      ok = false;
      break;
    }
    if (ok) return true;
  }
  return false;
}

export function hasLexiconToken(
  tokens: readonly string[],
  lexicon: ReadonlySet<string>,
  opts?: { allowPrefixStrip?: boolean },
): boolean {
  for (const tok of tokens) {
    if (lexicon.has(tok)) return true;
    if (opts?.allowPrefixStrip) {
      const stripped = stripOneHePrefix(tok);
      if (stripped && lexicon.has(stripped)) return true;
    }
  }
  return false;
}

export function hasCivilDateTokens(tokens: readonly string[]): boolean {
  for (let i = 0; i <= tokens.length - 3; i++) {
    const y = tokens[i]!;
    const m = tokens[i + 1]!;
    const d = tokens[i + 2]!;
    if (!/^\d{4}$/.test(y)) continue;
    const month = Number(m);
    const day = Number(d);
    if (month < 1 || month > 12 || day < 1 || day > 31) continue;
    return true;
  }
  return false;
}

export function hasHhMmToken(tokens: readonly string[]): boolean {
  return tokens.some((t) => isValidHhMm(t));
}

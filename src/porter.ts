/**
 * Porter stemmer, ported from this project's origin/riya branch (src/core-ir.ts).
 * Both sides of a BM25 match are stemmed, so "leaks" finds "leak" and "leakage".
 */
export function stem(word: string): string {
  // Only alphabetic words are stemmed: versions, measurements and IDs must survive intact.
  if (!/[a-z]/i.test(word) || word.length < 3) return word.toLowerCase();
  let w = word.toLowerCase();

  const isConsonant = (str: string, i: number): boolean => {
    const c = str[i]!;
    if (c === 'a' || c === 'e' || c === 'i' || c === 'o' || c === 'u') return false;
    if (c === 'y') return i === 0 ? true : !isConsonant(str, i - 1);
    return true;
  };

  const measure = (str: string): number => {
    let n = 0;
    let i = 0;
    const len = str.length;
    while (i < len && isConsonant(str, i)) i++;
    while (i < len) {
      while (i < len && !isConsonant(str, i)) i++;
      if (i < len) {
        n++;
        while (i < len && isConsonant(str, i)) i++;
      }
    }
    return n;
  };

  const hasVowel = (str: string): boolean => {
    for (let i = 0; i < str.length; i++) {
      if (!isConsonant(str, i)) return true;
    }
    return false;
  };

  const endsWithDoubleConsonant = (str: string): boolean => {
    const len = str.length;
    if (len < 2) return false;
    if (str[len - 1] !== str[len - 2]) return false;
    return isConsonant(str, len - 1);
  };

  const cvc = (str: string): boolean => {
    const len = str.length;
    if (len < 3) return false;
    if (!isConsonant(str, len - 1) || isConsonant(str, len - 2) || !isConsonant(str, len - 3)) return false;
    const last = str[len - 1]!;
    if (last === 'w' || last === 'x' || last === 'y') return false;
    return true;
  };

  // Step 1a
  if (w.endsWith('sses')) w = w.slice(0, -2);
  else if (w.endsWith('ies')) w = w.slice(0, -2);
  else if (!w.endsWith('ss') && w.endsWith('s')) w = w.slice(0, -1);

  // Step 1b
  let extra1b = false;
  if (w.endsWith('eed')) {
    const s = w.slice(0, -3);
    if (measure(s) > 0) w = s + 'ee';
  } else if (w.endsWith('ed')) {
    const s = w.slice(0, -2);
    if (hasVowel(s)) {
      w = s;
      extra1b = true;
    }
  } else if (w.endsWith('ing')) {
    const s = w.slice(0, -3);
    if (hasVowel(s)) {
      w = s;
      extra1b = true;
    }
  }
  if (extra1b) {
    if (w.endsWith('at') || w.endsWith('bl') || w.endsWith('iz')) {
      w += 'e';
    } else if (endsWithDoubleConsonant(w) && !w.endsWith('l') && !w.endsWith('s') && !w.endsWith('z')) {
      w = w.slice(0, -1);
    } else if (measure(w) === 1 && cvc(w)) {
      w += 'e';
    }
  }

  // Step 1c
  if (w.endsWith('y') && hasVowel(w.slice(0, -1))) {
    w = w.slice(0, -1) + 'i';
  }

  // Step 2
  const step2Pairs: [string, string][] = [
    ['ational', 'ate'], ['tional', 'tion'], ['enci', 'ence'], ['anci', 'ance'],
    ['izer', 'ize'], ['abli', 'able'], ['alli', 'al'], ['entli', 'ent'],
    ['eli', 'e'], ['ousli', 'ous'], ['ization', 'ize'], ['ation', 'ate'],
    ['ator', 'ate'], ['alism', 'al'], ['iveness', 'ive'], ['fulness', 'ful'],
    ['ousness', 'ous'], ['aliti', 'al'], ['iviti', 'ive'], ['biliti', 'ble'],
  ];
  for (const [suffix, repl] of step2Pairs) {
    if (w.endsWith(suffix)) {
      const s = w.slice(0, -suffix.length);
      if (measure(s) > 0) w = s + repl;
      break;
    }
  }

  // Step 3
  const step3Pairs: [string, string][] = [
    ['icate', 'ic'], ['ative', ''], ['alize', 'al'],
    ['iciti', 'ic'], ['ical', 'ic'], ['ful', ''], ['ness', ''],
  ];
  for (const [suffix, repl] of step3Pairs) {
    if (w.endsWith(suffix)) {
      const s = w.slice(0, -suffix.length);
      if (measure(s) > 0) w = s + repl;
      break;
    }
  }

  // Step 4
  const step4Suffixes = [
    'al', 'ance', 'ence', 'er', 'ic', 'able', 'ible', 'ant',
    'ement', 'ment', 'ent', 'ou', 'ism', 'ate', 'iti', 'ous', 'ive', 'ize',
  ];
  for (const suffix of step4Suffixes) {
    if (w.endsWith(suffix)) {
      const s = w.slice(0, -suffix.length);
      if (measure(s) > 1) w = s;
      break;
    }
  }
  if (w.endsWith('ion')) {
    const s = w.slice(0, -3);
    if (measure(s) > 1 && (s.endsWith('s') || s.endsWith('t'))) {
      w = s;
    }
  }

  // Step 5a
  if (w.endsWith('e')) {
    const s = w.slice(0, -1);
    const m = measure(s);
    if (m > 1 || (m === 1 && !cvc(s))) {
      w = s;
    }
  }

  // Step 5b
  if (w.endsWith('ll') && measure(w.slice(0, -1)) > 1) {
    w = w.slice(0, -1);
  }

  return w;
}

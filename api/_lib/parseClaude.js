// api/_lib/parseClaude.js
//
// Shared JSON parser for Claude API responses.
//
// Claude sometimes returns JSON wrapped in markdown fences, prefixed with prose,
// or truncated mid-output (when max_tokens is hit). This module recovers what
// it can: strips fences, finds the start of JSON, attempts a clean parse, and
// if that fails, tries progressively more aggressive recovery.
//
// Used by ai_search.js, classify.js, deep_tag.js, find_duplicates.js.

'use strict';

function parseJSON(text) {
  if (typeof text !== 'string') {
    throw new Error('parseJSON expected a string, got ' + typeof text);
  }

  // Strip markdown code fences if present
  let cleaned = text.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```\s*$/, '');

  // Find the start of the JSON (first { or [)
  const firstBrace = cleaned.indexOf('{');
  const firstBracket = cleaned.indexOf('[');
  let first;
  if (firstBrace < 0 && firstBracket < 0) {
    throw new Error('No JSON found in: ' + cleaned.slice(0, 120));
  } else if (firstBrace < 0) {
    first = firstBracket;
  } else if (firstBracket < 0) {
    first = firstBrace;
  } else {
    first = Math.min(firstBrace, firstBracket);
  }
  cleaned = cleaned.slice(first);

  // Strategy 1: clean parse if response ends in } or ]
  const lastClose = Math.max(cleaned.lastIndexOf('}'), cleaned.lastIndexOf(']'));
  if (lastClose > 0) {
    try { return JSON.parse(cleaned.slice(0, lastClose + 1)); }
    catch (e) { /* fall through to recovery */ }
  }

  // Strategy 2: scan, tracking depths + the current string's start position
  let inString = false, escape = false;
  let braceDepth = 0, bracketDepth = 0;
  let lastSafeEnd = -1;
  let lastTokenEnd = -1;
  let currentStringStart = -1;

  for (let i = 0; i < cleaned.length; i++) {
    const c = cleaned[i];
    if (escape) { escape = false; continue; }
    if (inString) {
      if (c === '\\') escape = true;
      else if (c === '"') { inString = false; currentStringStart = -1; lastTokenEnd = i + 1; }
      continue;
    }
    if (c === '"') { inString = true; currentStringStart = i; continue; }
    if (c === '{') braceDepth++;
    else if (c === '}') {
      braceDepth--; lastTokenEnd = i + 1;
      if (braceDepth === 0 && bracketDepth === 0) lastSafeEnd = i + 1;
    }
    else if (c === '[') bracketDepth++;
    else if (c === ']') { bracketDepth--; lastTokenEnd = i + 1; }
    else if (/[\d\.\-]/.test(c) || /[truefalsn]/i.test(c)) lastTokenEnd = i + 1;
  }

  if (lastSafeEnd > 0) {
    try { return JSON.parse(cleaned.slice(0, lastSafeEnd)); }
    catch (e) { /* fall through */ }
  }

  // Strategy 3: repair by determining where to cut and auto-closing
  let cut;
  if (inString && currentStringStart >= 0) {
    cut = currentStringStart;
    while (cut > 0 && /\s/.test(cleaned[cut - 1])) cut--;
    if (cut > 0 && cleaned[cut - 1] === ':') {
      cut--;
      while (cut > 0 && /\s/.test(cleaned[cut - 1])) cut--;
      if (cut > 0 && cleaned[cut - 1] === '"') {
        cut--;
        while (cut > 0 && cleaned[cut - 1] !== '"') cut--;
        if (cut > 0) cut--;
      }
    }
    while (cut > 0 && /[\s,]/.test(cleaned[cut - 1])) cut--;
  } else {
    cut = lastTokenEnd > 0 ? lastTokenEnd : cleaned.length;
    while (cut > 0 && /[\s,]/.test(cleaned[cut - 1])) cut--;
  }

  // Re-scan the cut region to compute open-bracket/open-brace counts
  let bd = 0, kd = 0, str = false, esc = false;
  for (let i = 0; i < cut; i++) {
    const c = cleaned[i];
    if (esc) { esc = false; continue; }
    if (str) {
      if (c === '\\') esc = true;
      else if (c === '"') str = false;
      continue;
    }
    if (c === '"') str = true;
    else if (c === '{') bd++;
    else if (c === '}') bd--;
    else if (c === '[') kd++;
    else if (c === ']') kd--;
  }

  let candidate = cleaned.slice(0, cut);
  for (let i = 0; i < kd; i++) candidate += ']';
  for (let i = 0; i < bd; i++) candidate += '}';
  candidate = candidate.replace(/,(\s*[\]}])/g, '$1');

  try { return JSON.parse(candidate); }
  catch (e) {
    throw new Error('parseJSON: recovery exhausted: ' + e.message + ' | head: ' + cleaned.slice(0, 80));
  }
}

module.exports = { parseJSON };

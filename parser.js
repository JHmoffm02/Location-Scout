// parser.js — shared notes parser for client (browser) and server (Node).
// Strategy: expand collapsed text → classify each line → group into structure → render.
// Pure functions, no DOM access. Renderer returns HTML string; caller decides where to mount.

(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.NotesParser = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ── Regex library ──────────────────────────────────────────────────────────
  const RX = {
    PHONE_LINE: /^\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]\d{4}/,
    PHONE_ANY: /\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]\d{4}/,
    EMAIL: /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/,
    EMAIL_LINE: /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/,
    DATE_FULL: /^(\d{1,2})[-\/](\d{1,2})[-\/](\d{2,4})\.?$/,
    DATE_PREFIX: /^(\d{1,2}[-\/]\d{1,2}[-\/]\d{2,4})\b[:.\-]?\s*(.+)?$/,
    SIGNATURE: /^J\.?\s*Hoffman/i,
    NOTES_HDR: /^notes?\s*:?\s*$/i,
    CONTACT_HDR: /^(C\d*|Contact|Owner|Manager|Mgr|GM|Chef|Booker|Booking|Agent|Producer|Director|Realtor|Broker|Host)\s*:\s*(.*)$/i,
    BULLET: /^[-•‣▪]/,
    CITY_STATE: /^([A-Za-z][A-Za-z\s.'\-]+),\s*([A-Z]{2})(?:\s+(\d{5}))?\s*$/,
    // Street: starts with number(s), maybe a hyphen+number (like "27-20"), then a token.
    // Allows "4401 11th St", "27-20 23rd Ave", "222 Old Country Rd". Letters required *somewhere*.
    // Excludes: "1 bedroom", "2 person rooms", "24 hour", etc.
    STREET_HEAD: /^\d+(?:[-\/]\d+)?\s+\S/,
    STREET_NEGATIVE: /^\d+(?:[-\/]\d+)?\s+(year|yr|month|mo|day|bedroom|bed|bath|story|stories|stry|car|person|people|hour|hr|min|minute|sec|second|foot|feet|ft|inch|in|mile|mi|kid|child|adult|guest|seat|table|room)s?\b/i,
    CROSS_HINT: /(?:Btw|btw|@\s|Across|Between|Corner|Entrance|Across\s+from|Next\s+to|Behind)/i,
    CROSS_PAREN: /^\(.*\)?$/,
    PENDING_INLINE: /\*pending\*/gi,
    ITALIC_LINE: /^\*([^*]+)\*$/,
    URL: /(https?:\/\/[^\s<>"]+)/g,
  };

  // ── Tiny utils ─────────────────────────────────────────────────────────────
  function escapeHtml(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function decode(s) {
    return String(s || '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, ' ');
  }

  // ── Step 1: expand collapsed text into separated lines ─────────────────────
  function expand(raw) {
    let s = decode(raw);
    s = s.replace(/\r\n?/g, '\n');

    // Strip markdown links → plain
    s = s.replace(/\[([^\]]+)\]\(mailto:([^)]+)\)/g, '$2');
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1');

    // Inject newlines BEFORE structural markers when no newline already present.
    // Order matters — start with strong anchors.
    s = s.replace(/([^\n\s])(\s*)(\bC\d*\s*:)/g, '$1\n$3');
    s = s.replace(/([^\n\s])(\s*)(\b(?:Contact|Owner|Manager|Mgr|GM|Chef|Booker|Booking|Agent|Producer|Director|Realtor|Broker|Host)\s*:)/g, '$1\n$3');
    s = s.replace(/([^\n\s])(\s*)(\bNotes?:)/gi, '$1\n$3');
    s = s.replace(/([^\n\s])(\s*)(J\.?\s*Hoffman)/g, '$1\n$3');

    // Cross-street parenthesis: "St(Btw" → "St\n(Btw"
    s = s.replace(/([^\s\n(])(\s*)(\((?:Btw|btw|@\s|Across|Between|Entrance|Corner))/g, '$1\n$3');

    // Closing paren of cross-street + city: ")Yonkers," or ") Yonkers,"
    s = s.replace(/(\))(\s*)([A-Z][a-z]+(?:\s[A-Z][a-z]+)*,\s*[A-Z]{2})/g, '$1\n$3');

    // ZIP followed by anything else (with or without space): "10703C" → "10703\nC"
    s = s.replace(/(\b\d{5})(?!\s*$)(\s*)([A-Za-z(])/g, '$1\n$3');

    // Phone number followed by text: "555-1234C" or "555-1234 Notes:" → split
    s = s.replace(/(\d{3}[-.\s]\d{4})(\s*)(\(c\)|\(o\)|\(h\)|\(m\))?(\s*)([A-Za-z][a-zA-Z]+\s*:)/gi, '$1$3\n$5');

    // (c)/(o)/(h)/(m) tag immediately followed by capital letter → split
    s = s.replace(/(\([cohm]\))(\s*)([A-Z][a-zA-Z])/gi, '$1\n$3');

    // Hoffman + date: "Hoffman6-21-21" → split
    s = s.replace(/(Hoffman)(\d{1,2}[-\/]\d{1,2}[-\/]\d{2,4})/g, '$1\n$2');

    // Period-then-bullet: ".text-Next" → ".text\n-Next"
    s = s.replace(/([.!?])\s*-\s*([A-Z])/g, '$1\n-$2');

    // Email immediately followed by capital text
    s = s.replace(/([a-zA-Z]{2,4})(\s*)([A-Z][a-z]+\s*:)/g, function (m, dom, ws, tail) {
      // Only if "dom" is plausibly a TLD-like end of email
      if (/^(com|org|net|edu|gov|io|co|us|info|biz|me)$/i.test(dom)) return dom + '\n' + tail;
      return m;
    });

    // Multi-phone separator: number followed by "917-..." on same line
    s = s.replace(/(\d{4})\s+(\(?\d{3}\)?[\s.\-]\d{3}[\s.\-]\d{4})/g, '$1\n$2');

    return s;
  }

  // ── Step 2: classify each line ─────────────────────────────────────────────
  function classify(rawLine) {
    let line = String(rawLine).trim();
    if (!line) return { type: 'empty' };

    // Detect & strip *pending* anywhere — set flag on returned token
    let pending = false;
    if (RX.PENDING_INLINE.test(line)) {
      pending = true;
      line = line.replace(RX.PENDING_INLINE, '').replace(/\*\s*\*/g, '').trim();
      if (!line) return { type: 'pending_marker', pending: true };
    }

    function tag(obj) { if (pending) obj.pending = true; return obj; }

    // Whole-line italic
    let m = line.match(RX.ITALIC_LINE);
    if (m) return tag({ type: 'italic', text: m[1].trim() });

    // Strip leading/trailing solo asterisks
    line = line.replace(/^\*+|\*+$/g, '').trim();
    if (!line) return { type: 'empty' };

    // Date alone
    if (RX.DATE_FULL.test(line)) return tag({ type: 'date', text: line.replace(/\.$/, '') });

    // Signature ("J. Hoffman ...")
    if (RX.SIGNATURE.test(line)) {
      const dateMatch = line.match(/(\d{1,2}[-\/]\d{1,2}[-\/]\d{2,4})/);
      const name = line.replace(/\d{1,2}[-\/]\d{1,2}[-\/]\d{2,4}/g, '').trim();
      return tag({ type: 'signature', name: name, date: dateMatch ? dateMatch[1] : '' });
    }

    if (RX.NOTES_HDR.test(line)) return tag({ type: 'notes_header' });

    m = line.match(RX.CONTACT_HDR);
    if (m) return tag({ type: 'contact_header', label: m[1], rest: m[2] || '' });

    if (RX.BULLET.test(line)) {
      return tag({ type: 'bullet', text: line.replace(/^[-•‣▪]\s*|^•\s*/, '') });
    }

    m = line.match(RX.DATE_PREFIX);
    if (m && m[2] && m[2].length > 3) {
      return tag({ type: 'update', date: m[1], text: m[2] });
    }
    if (/^update\s*[:.\-]/i.test(line)) {
      return tag({ type: 'update', date: '', text: line.replace(/^update\s*[:.\-]\s*/i, '') });
    }

    if (RX.CROSS_PAREN.test(line) && RX.CROSS_HINT.test(line)) {
      return tag({ type: 'cross', text: line });
    }

    if (RX.PHONE_LINE.test(line)) return tag({ type: 'phone', text: line });

    if (RX.EMAIL_LINE.test(line)) {
      const em = line.match(RX.EMAIL);
      return tag({ type: 'email', text: em[0] });
    }

    m = line.match(RX.CITY_STATE);
    if (m) return tag({ type: 'city_state_zip', city: m[1].trim(), state: m[2], zip: m[3] || '' });

    if (RX.STREET_HEAD.test(line) && /[A-Za-z]/.test(line) && !RX.STREET_NEGATIVE.test(line)) {
      return tag({ type: 'street', text: line });
    }

    return tag({ type: 'prose', text: line });
  }

  // ── Step 3: group classified tokens into structured output ─────────────────
  function group(tokens, opts) {
    const locName = ((opts && opts.locName) || '').trim().toLowerCase();
    const out = {
      title: [],
      address: null,           // {street, cross, city, state, zip}
      addressCandidates: [],   // alternates the parser found
      cross: [],
      contacts: [],
      notes: [],               // {kind:'bullet'|'prose'|'update', text, date?}
      italic: [],
      signature: '',
      date: '',
      pending: false,
    };

    // Skip any leading empties
    let i = 0;
    while (i < tokens.length && tokens[i].type === 'empty') i++;

    // Sweep all tokens for pending flag (can appear anywhere)
    tokens.forEach(t => { if (t.pending) out.pending = true; });

    // ── Phase A: collect title (consecutive prose lines until structural break) ──
    while (i < tokens.length) {
      const t = tokens[i];
      if (t.type === 'pending_marker') { out.pending = true; i++; continue; }
      if (t.type === 'italic')         { out.italic.push(t.text); i++; continue; }
      if (t.type === 'empty')          { i++; continue; }

      // If this line IS the locName, consume as title regardless of classification
      const tokenText = (t.text || '').trim().toLowerCase();
      const matchesLocName = locName && tokenText === locName;

      // Hard breaks → title done (unless line equals locName)
      if (['contact_header', 'notes_header', 'phone', 'email', 'bullet', 'signature', 'update'].includes(t.type)) break;
      if (['street', 'city_state_zip', 'cross'].includes(t.type) && !matchesLocName) break;

      // Prose, or address-y line that matches locName → treat as title
      if (t.type === 'prose' || matchesLocName) {
        out.title.push(t.text || '');
        i++;
        continue;
      }
      if (t.type === 'date') { out.date = t.text; i++; continue; }
      i++;
    }

    // ── Phase B: address block — collect contiguous street/cross/city ─────────
    // Allow other prose/italic between street and city, captured as `extras`
    // so detail panel can render them BELOW the address lines.
    const ADDR_TYPES = new Set(['street', 'cross', 'city_state_zip', 'empty']);
    const STOP_TYPES = new Set(['contact_header', 'notes_header', 'signature',
                                'bullet', 'update', 'phone', 'email']);
    let addrStart = i;
    let addrStreet = '', addrCross = '', addrCity = '', addrState = '', addrZip = '';
    const addrExtras = [];

    let scanned = 0;
    while (i < tokens.length && scanned < 10) {
      const t = tokens[i];
      if (STOP_TYPES.has(t.type)) break;
      if (t.type === 'empty') { i++; scanned++; continue; }

      if (t.type === 'street') {
        // Prefer cleaner street (without " - " separator) over title-style
        if (!addrStreet || (addrStreet.indexOf(' - ') >= 0 && t.text.indexOf(' - ') < 0)) {
          addrStreet = t.text;
        }
        i++; scanned++; continue;
      }
      if (t.type === 'cross') {
        if (!addrCross) addrCross = t.text;
        else addrExtras.push({ kind: 'cross', text: t.text });
        i++; scanned++; continue;
      }
      if (t.type === 'city_state_zip' && !addrCity) {
        addrCity = t.city; addrState = t.state; addrZip = t.zip;
        i++; scanned++;
        break;  // city/state/zip is the end of an address block
      }

      // Prose/italic appearing between address lines → extras
      if (addrStreet || addrCity || addrCross) {
        if (t.type === 'italic') addrExtras.push({ kind: 'italic', text: t.text });
        else if (t.type === 'prose') addrExtras.push({ kind: 'prose', text: t.text });
        else { /* unknown — stop the block */ break; }
        i++; scanned++; continue;
      }

      // Nothing started yet, non-address content → not an address block
      break;
    }

    if (addrStreet || (addrCity && addrState)) {
      out.address = {
        street: addrStreet, cross: addrCross,
        city: addrCity, state: addrState, zip: addrZip,
        extras: addrExtras
      };
      out.addressCandidates.push({
        confidence: addrStreet && addrCity ? 'high' : (addrStreet || addrCity ? 'medium' : 'low'),
        street: addrStreet, cross: addrCross, city: addrCity, state: addrState, zip: addrZip,
        query: [addrStreet, addrCity, addrState, addrZip].filter(Boolean).join(', ')
      });
    } else {
      // No address found — rewind so the orphan tokens get processed in Phase C
      i = addrStart;
    }

    // ── Phase C: contacts / notes / footer (state machine) ───────────────────
    let curContact = null;
    let inNotes = false;

    function closeContact() {
      if (curContact && (curContact.name || curContact.phones.length || curContact.emails.length)) {
        out.contacts.push(curContact);
      }
      curContact = null;
    }
    function pickPhonesEmails(text) {
      const phones = [], emails = [];
      let stripped = String(text || '');
      const phMatches = stripped.match(new RegExp(RX.PHONE_ANY.source, 'g'));
      if (phMatches) phMatches.forEach(p => { phones.push(p); stripped = stripped.replace(p, ''); });
      const emMatches = stripped.match(new RegExp(RX.EMAIL.source, 'g'));
      if (emMatches) emMatches.forEach(e => { emails.push(e); stripped = stripped.replace(e, ''); });
      return { phones: phones, emails: emails, name: stripped.replace(/\s+/g, ' ').trim() };
    }

    while (i < tokens.length) {
      const t = tokens[i++];

      if (t.type === 'empty') continue;
      if (t.type === 'pending_marker') { out.pending = true; continue; }
      if (t.type === 'italic') { out.italic.push(t.text); continue; }

      if (t.type === 'signature') {
        closeContact();
        out.signature = t.name || 'J. Hoffman';
        if (t.date && !out.date) out.date = t.date;
        continue;
      }
      if (t.type === 'date') { out.date = t.text; continue; }

      // Stray cross-street outside address block
      if (t.type === 'cross') {
        if (inNotes) out.notes.push({ kind: 'prose', text: t.text });
        else if (curContact) curContact.name += (curContact.name ? '\n' : '') + t.text;
        else out.cross.push(t.text);
        continue;
      }

      if (t.type === 'notes_header') {
        closeContact();
        inNotes = true;
        continue;
      }

      if (t.type === 'contact_header') {
        closeContact();
        const ext = pickPhonesEmails(t.rest);
        curContact = { label: t.label, name: ext.name, phones: ext.phones, emails: ext.emails };
        inNotes = false;
        continue;
      }

      if (curContact && !inNotes) {
        if (t.type === 'phone') { curContact.phones.push(t.text); continue; }
        if (t.type === 'email') { curContact.emails.push(t.text); continue; }
        if (t.type === 'prose' && curContact.phones.length === 0 && curContact.emails.length === 0) {
          // Continuation of contact name
          curContact.name += (curContact.name ? '\n' : '') + t.text;
          continue;
        }
        // Anything else closes the contact
        closeContact();
      }

      // Notes / orphan content
      if (t.type === 'bullet')  { out.notes.push({ kind: 'bullet', text: t.text }); inNotes = true; continue; }
      if (t.type === 'update')  { out.notes.push({ kind: 'update', date: t.date, text: t.text }); inNotes = true; continue; }
      if (t.type === 'prose')   { out.notes.push({ kind: 'prose', text: t.text }); inNotes = true; continue; }
      if (t.type === 'phone' || t.type === 'email') {
        // Stray contact info → make a contact
        const c = { label: 'C', name: '', phones: [], emails: [] };
        if (t.type === 'phone') c.phones.push(t.text); else c.emails.push(t.text);
        out.contacts.push(c);
        continue;
      }
      if (t.type === 'street' || t.type === 'city_state_zip') {
        // Late-arriving address parts → fold into existing or create note
        if (out.address) {
          if (t.type === 'street' && !out.address.street) out.address.street = t.text;
          if (t.type === 'city_state_zip' && !out.address.city) {
            out.address.city = t.city; out.address.state = t.state; out.address.zip = t.zip;
          }
        } else {
          out.notes.push({ kind: 'prose', text: t.text || (t.city + ', ' + t.state + (t.zip ? ' ' + t.zip : '')) });
        }
        continue;
      }
    }
    closeContact();

    return out;
  }

  // ── Public: parse() returns the structured group ──────────────────────────
  function parse(rawNotes, opts) {
    if (!rawNotes) return null;
    const o = opts || {};
    const expanded = expand(rawNotes);
    const lines = expanded.split('\n');
    const tokens = lines.map(classify);
    const grouped = group(tokens, o);

    // If the album/location has its own name and our scraped title duplicates it, drop it
    if (o.locName) {
      const locName = String(o.locName).trim().toLowerCase();
      const titleJoined = grouped.title.join(' ').trim().toLowerCase();
      if (titleJoined === locName ||
          titleJoined === locName + ' ' + locName ||  // duplicate-line title
          !titleJoined) {
        grouped.title = [];
      }
    }

    return grouped;
  }

  // ── Convenience: extract a flat address record for DB writes ──────────────
  function extractAddress(rawNotes, opts) {
    const g = parse(rawNotes, opts || {});
    if (!g || !g.address) return { confidence: 'none', candidates: [] };
    const a = g.address;
    return {
      confidence: g.addressCandidates[0] ? g.addressCandidates[0].confidence : 'low',
      address: a.street || '',
      cross: a.cross || '',
      city: a.city || '',
      state_code: a.state || '',
      zip: a.zip || '',
      query: [a.street, a.city, a.state, a.zip].filter(Boolean).join(', '),
      candidates: g.addressCandidates,
    };
  }

  // ── Renderer: returns HTML string for the detail panel notes section ──────
  // This is layout-agnostic: caller puts it where it wants.
  function renderHtml(grouped, opts) {
    if (!grouped) return '';
    const o = opts || {};
    const showAddress = o.showAddress !== false;  // caller can hide if rendering own
    const css = {
      sec:    'margin-top:14px;padding-top:10px;border-top:1px solid var(--border)',
      lbl:    "font-size:8px;letter-spacing:.14em;color:var(--text3);text-transform:uppercase;margin-bottom:6px;font-family:'DM Mono',monospace",
      ital:   'font-size:11px;color:var(--accent);font-style:italic;display:block;margin-bottom:6px',
      cross:  'font-size:11px;color:var(--text3);font-style:italic;display:block;margin-top:2px',
      cName:  'font-size:12px;font-weight:500;color:var(--text);white-space:pre-line;line-height:1.4',
      cInfo:  'font-size:11px;color:var(--text2);margin-top:1px',
      cMail:  'font-size:11px;color:var(--accent);text-decoration:none;display:inline-block;margin-top:1px',
      cLabel: "font-size:8px;font-family:'DM Mono',monospace;color:var(--text3);letter-spacing:.06em;margin-right:6px;text-transform:uppercase",
      bullet: 'font-size:12px;color:var(--text2);padding-left:14px;position:relative;margin-bottom:3px;line-height:1.55',
      bulDot: 'position:absolute;left:2px;top:0;color:var(--text3)',
      prose:  'font-size:12px;color:var(--text2);margin-bottom:3px;line-height:1.55',
      upd:    'margin-top:12px;margin-bottom:6px;display:flex;align-items:center;gap:8px',
      updLbl: "font-size:9px;letter-spacing:.1em;color:var(--amber);font-family:'DM Mono',monospace;text-transform:uppercase;border:1px solid var(--amber);padding:1px 7px;border-radius:3px",
      updDate: "font-size:10px;color:var(--text3);font-family:'DM Mono',monospace",
      foot:   "font-size:10px;color:var(--text3);font-family:'DM Mono',monospace;margin-top:14px;padding-top:8px;border-top:1px solid var(--border)",
    };

    const parts = [];
    const E = escapeHtml;

    // Italics (e.g., hours notes)
    grouped.italic.forEach(t => parts.push(`<span style="${css.ital}">${E(t)}</span>`));

    // Orphan cross-streets (when we have no street but we have a cross)
    if (showAddress && grouped.cross.length) {
      grouped.cross.forEach(t => parts.push(`<span style="${css.cross}">${E(t)}</span>`));
    }

    // Contacts
    if (grouped.contacts.length) {
      parts.push(`<div style="${css.sec}"><div style="${css.lbl}">Contact</div>`);
      grouped.contacts.forEach((c, idx) => {
        if (idx > 0) parts.push('<div style="height:8px"></div>');
        // Skip C / C1 / C2 / etc. labels — only show meaningful labels (Owner, Manager, etc.)
        const labelTag = c.label && !/^C\d*$/i.test(c.label)
          ? `<span style="${css.cLabel}">${E(c.label)}</span>`
          : '';
        if (c.name) parts.push(`<div style="${css.cName}">${labelTag}${E(c.name)}</div>`);
        else if (labelTag) parts.push(`<div>${labelTag}</div>`);
        c.phones.forEach(p => {
          const tel = String(p).replace(/[^\d+]/g, '');
          parts.push(`<div style="${css.cInfo}"><a href="tel:${tel}" style="color:inherit;text-decoration:none;border-bottom:1px dotted var(--border2)">${E(p)}</a></div>`);
        });
        c.emails.forEach(e => parts.push(
          `<a href="mailto:${E(e)}" style="${css.cMail}">${E(e)}</a>`
        ));
      });
      parts.push('</div>');
    }

    // Notes
    if (grouped.notes.length) {
      parts.push(`<div style="${css.sec}"><div style="${css.lbl}">Notes</div>`);
      let inUpdate = false;
      grouped.notes.forEach(n => {
        if (n.kind === 'update') {
          parts.push(`<div style="${css.upd}"><span style="${css.updLbl}">UPDATE</span>${
            n.date ? `<span style="${css.updDate}">${E(n.date)}</span>` : ''
          }</div>`);
          if (n.text) parts.push(`<div style="${css.bullet};color:var(--amber)"><span style="${css.bulDot}">•</span>${E(n.text)}</div>`);
          inUpdate = true;
          return;
        }
        const colorOverride = inUpdate ? ';color:var(--amber)' : '';
        // Every notes line gets a bullet — bullet OR prose, both display as •
        parts.push(`<div style="${css.bullet}${colorOverride}"><span style="${css.bulDot}">•</span>${E(n.text)}</div>`);
      });
      parts.push('</div>');
    }

    // Signature / date footer
    if (grouped.signature || grouped.date) {
      const left = grouped.signature ? E(grouped.signature) : '';
      const right = grouped.date ? E(grouped.date) : '';
      const sep = (left && right) ? ' &nbsp;·&nbsp; ' : '';
      parts.push(`<div style="${css.foot}">${left}${sep}${right}</div>`);
    }

    return parts.join('');
  }

  // ── Public API ────────────────────────────────────────────────────────────
  return {
    parse: parse,
    extractAddress: extractAddress,
    renderHtml: renderHtml,
    escapeHtml: escapeHtml,
    // exposed for testing
    _expand: expand,
    _classify: classify,
    _group: group,
  };
});

// test_edge_cases.js — stress test parser on format variations
const P = require('./parser.js');

const cases = [
  {
    name: 'Bare street with no title',
    raw: `100 Main St
Brooklyn, NY 11201
718-555-1234`,
    check: r => r.address && r.address.street === '100 Main St' && r.address.city === 'Brooklyn'
  },
  {
    name: 'Email-first contact',
    raw: `Joe's Diner
500 Atlantic Ave
Brooklyn, NY 11217

Contact: Joe Smith
joe@example.com
(718) 555-9876`,
    check: r => r.contacts.length === 1 && r.contacts[0].emails[0] === 'joe@example.com'
  },
  {
    name: 'Multiple updates with dates',
    raw: `Title
123 Main St
Anywhere, NY 11111

Notes:
- Originally scouted in summer.

11/15/22 - Building was sold.

3/4/23 - New owner contacted.`,
    check: r => r.notes.filter(n => n.kind === 'update').length === 2
  },
  {
    name: 'Pending status marker',
    raw: `Cool Place *pending*
1 First Ave
Manhattan, NY 10001`,
    check: r => r.pending === true
  },
  {
    name: 'No contact header, just phone',
    raw: `Spot
99 Bond St
Brooklyn, NY 11217
347-555-0001`,
    check: r => r.contacts.length === 1 && r.contacts[0].phones[0].includes('347-555-0001')
  },
  {
    name: 'Italic hours line',
    raw: `Cafe X
*Hours: 8am-10pm daily*
234 Driggs Ave
Brooklyn, NY 11211`,
    check: r => r.italic.length === 1 && r.italic[0].includes('Hours')
  },
  {
    name: 'Connecticut location',
    raw: `Sweet Spot - Greenwich
17 Greenwich Ave
Greenwich, CT 06830

C: Sarah Lee
203-555-1212`,
    check: r => r.address && r.address.state === 'CT' && r.address.city === 'Greenwich'
  },
  {
    name: 'Address with apartment number',
    raw: `Studio Loft
500 Broadway, Apt 4B
New York, NY 10012`,
    check: r => r.address && r.address.street.includes('500 Broadway')
  },
  {
    name: 'No address at all (just notes)',
    raw: `Some Place
A scouted location with no real address yet.`,
    check: r => r.address === null && r.title.length > 0
  },
  {
    name: 'Owner: header (variant)',
    raw: `Place
1 Main St
Town, NJ 07001

Owner: Bob
201-555-0000`,
    check: r => r.contacts.length === 1 && r.contacts[0].label.toLowerCase() === 'owner'
  },
  {
    name: 'Hyphenated address with no leading number',
    raw: `Joe's
Some prose without an obvious address
Brooklyn, NY 11201`,
    check: r => r.address && r.address.city === 'Brooklyn' && !r.address.street
  },
  {
    name: 'Malicious-looking content (XSS attempt in notes)',
    raw: `Place
1 Main St
Town, NY 11211
<script>alert(1)</script>
Notes:
- "Quotes" & ampersands & </script> tags`,
    check: r => {
      const html = P.renderHtml(r);
      // Must NOT contain literal executable script tags or unescaped angle brackets in dangerous spots
      const hasLiveScript = /<script[\s>]/i.test(html) || /<\/script>/i.test(html);
      const hasEscapedScript = html.indexOf('&lt;script&gt;') >= 0;
      return !hasLiveScript && hasEscapedScript;
    }
  },
];

let pass = 0, fail = 0;
cases.forEach(tc => {
  const result = P.parse(tc.raw, { locName: tc.name });
  let ok = false;
  try { ok = tc.check(result); } catch (e) { ok = false; }
  if (ok) { pass++; console.log(`✅ ${tc.name}`); }
  else {
    fail++;
    console.log(`❌ ${tc.name}`);
    console.log(JSON.stringify(result, null, 2).split('\n').map(l => '   ' + l).join('\n'));
  }
});

console.log(`\n${pass} pass, ${fail} fail`);

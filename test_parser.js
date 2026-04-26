// test_parser.js — validate parser against real notes from user examples
const P = require('./parser.js');

const cases = [
  {
    name: 'Case 1 — Metropolitan Building',
    locName: 'Metropolitan Building - LIC',
    raw: `Metropolitan Building - LIC
Metropolitan Building - LIC
4401 11th St
(@ 44th Ave)
Long Island City, NY 11101

C: Jorge, Carlos, and Lazaro
718-784-3717
917-294-4749 (Jorge Cell Phone Number)
Bookings@metropolitanbuilding.com

Notes:
-Events space with three floors all different from the last.
-I spoke with Jorge on the phone and followed up with an preliminary email with our basic details.
-They have become 'very busy' with events and other productions in the past month.
-Floor 1: pictures 12-31
-Floor 2: pictures 38-61
-Floor 3: pictures 79-92
-North staircase photographs between floors.
-South staircase: pictures 93-106

J. Hoffman
2-26-21`,
    expect: {
      address: { street: '4401 11th St', cross: '(@ 44th Ave)', city: 'Long Island City', state: 'NY', zip: '11101' },
      contactCount: 1,
      contactName: /Jorge.*Carlos.*Lazaro/,
      noteCount: 8,
      hasUpdate: false,
      signature: 'J. Hoffman',
      date: '2-26-21',
    }
  },
  {
    name: 'Case 2 — Mineola',
    locName: '222 Old Country Rd - Mineola',
    raw: `222 Old Country Rd
(@ Kellum Pl)
Mineola, NY 11501

C: Ed Goydas (owner)
917-288-1578 (c)

Notes:
-The first floor is an empty old bank.
-The second floor is a layers office and will be vacant at the end of January.
-Ed has some people that are interested in taking the lease but he will hold off if we decide we wan the space/building. He wants to know by January.
-Good sized (~48 car) parking lot.
-We can remove load bearing walls or whatever else we want.
-Ceiling tiles are all accounted for and can go back in.
-Elevator will be fixed in the next month.
-Next door to Nassau County Clerks Office.
-Ed has no concern with the content of the scenes.
-Mineola has a simple enough application process without too many restrictions.

J. Hoffman
12-5-22`,
    expect: {
      address: { street: '222 Old Country Rd', cross: '(@ Kellum Pl)', city: 'Mineola', state: 'NY', zip: '11501' },
      contactCount: 1,
      contactName: /Ed Goydas/,
      noteCount: 10,
      signature: 'J. Hoffman',
      date: '12-5-22',
    }
  },
  {
    name: 'Case 3 — 51 Crescent Pl',
    locName: '51 Crescent Pl - Yonkers',
    raw: `51 Crescent Pl - Yonkers
51 Crescent Pl
(@ Villa Ave)
Yonkers, NY 10704

C: Patricia Villegas (owner)
203-428-5245 (c)

Notes:
-Across the street from an Elementary School.
-Family of 5 in the house, Patricia and her adult children.
-Villa Ave is a dead end.

J. Hoffman
4-19-21`,
    expect: {
      address: { street: '51 Crescent Pl', cross: '(@ Villa Ave)', city: 'Yonkers', state: 'NY', zip: '10704' },
      contactCount: 1,
      contactName: /Patricia Villegas/,
      noteCount: 3,
      signature: 'J. Hoffman',
      date: '4-19-21',
    }
  },
  {
    name: 'Case 4 — 106 High St (collapsed text)',
    locName: '106 High St - Yonkers',
    raw: `106 High St(Btw Ridge Ave &amp; St Joseph Ave)Yonkers, NY 10703C: Melissa Green914-953-2023 (c)Notes:-Single Family home, with a very nice family.-Melissa is an aspiring actress and producer.J. Hoffman6-21-21`,
    expect: {
      address: { street: '106 High St', cross: /Btw Ridge Ave/, city: 'Yonkers', state: 'NY', zip: '10703' },
      contactCount: 1,
      contactName: /Melissa Green/,
      noteCount: 2,
      signature: 'J. Hoffman',
      date: '6-21-21',
    }
  },
  {
    name: 'Case 5 — Letlove Inn (multi-contact)',
    locName: 'The Letlove Inn - Ditmars Steinway',
    raw: `The Letlove Inn - Ditmars Steinway
27-20 23rd Ave
(@ 28th St)
Queens, NY 11105

C: George Samios (Co-owner, day guy)
917-662-9233 (c)

C2: Evan Roumeliotis (Co-owner, night guy)
917-454-7220 (c)

Notes:
-Same owners as Mar's in Astoria; they own another bar called 'Sparrow Tavern' I haven not photographed.
-Bare and small bar.

J. Hoffman
3-10-21`,
    expect: {
      address: { street: '27-20 23rd Ave', cross: '(@ 28th St)', city: 'Queens', state: 'NY', zip: '11105' },
      contactCount: 2,
      contactName: /George Samios/,
      noteCount: 2,
      signature: 'J. Hoffman',
      date: '3-10-21',
    }
  }
];

let pass = 0, fail = 0;
const failures = [];

cases.forEach(tc => {
  const result = P.parse(tc.raw, { locName: tc.locName });
  const errors = [];

  if (tc.expect.address) {
    const a = result && result.address;
    if (!a) errors.push('NO ADDRESS extracted');
    else {
      const e = tc.expect.address;
      if (e.street && a.street !== e.street) errors.push(`street: "${a.street}" vs expected "${e.street}"`);
      if (e.city && a.city !== e.city) errors.push(`city: "${a.city}" vs expected "${e.city}"`);
      if (e.state && a.state !== e.state) errors.push(`state: "${a.state}" vs expected "${e.state}"`);
      if (e.zip && a.zip !== e.zip) errors.push(`zip: "${a.zip}" vs expected "${e.zip}"`);
      if (e.cross instanceof RegExp) {
        if (!e.cross.test(a.cross || '')) errors.push(`cross: "${a.cross}" vs expected match ${e.cross}`);
      } else if (e.cross && a.cross !== e.cross) {
        errors.push(`cross: "${a.cross}" vs expected "${e.cross}"`);
      }
    }
  }

  if (tc.expect.contactCount != null && result.contacts.length !== tc.expect.contactCount) {
    errors.push(`contacts: got ${result.contacts.length}, expected ${tc.expect.contactCount}`);
  }
  if (tc.expect.contactName && result.contacts[0]) {
    if (!tc.expect.contactName.test(result.contacts[0].name)) {
      errors.push(`first contact name: "${result.contacts[0].name}" doesn't match ${tc.expect.contactName}`);
    }
  }
  if (tc.expect.noteCount != null && result.notes.length !== tc.expect.noteCount) {
    errors.push(`notes: got ${result.notes.length}, expected ${tc.expect.noteCount}`);
  }
  if (tc.expect.signature && !result.signature.includes('Hoffman')) {
    errors.push(`signature: "${result.signature}" missing Hoffman`);
  }
  if (tc.expect.date && result.date !== tc.expect.date) {
    errors.push(`date: "${result.date}" vs "${tc.expect.date}"`);
  }

  if (errors.length === 0) {
    pass++;
    console.log(`✅ ${tc.name}`);
  } else {
    fail++;
    failures.push({ name: tc.name, errors, result });
    console.log(`❌ ${tc.name}`);
    errors.forEach(e => console.log(`     ${e}`));
  }
});

console.log(`\n${pass} pass, ${fail} fail`);
if (fail > 0) {
  console.log('\n--- Detailed failures ---');
  failures.forEach(f => {
    console.log(`\n${f.name}:`);
    console.log(JSON.stringify(f.result, null, 2));
  });
}

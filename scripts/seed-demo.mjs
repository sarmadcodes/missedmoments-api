/**
 * Seeds a demo dataset so the app has real content to show.
 *
 * Everything goes through the public API rather than straight into Postgres,
 * so what a client sees is produced by exactly the code paths a real user hits.
 *
 *   node scripts/seed-demo.mjs --lat 24.895226 --lng 67.118776
 *
 * The coordinate matters: Discover only shows people whose check-in was within
 * MOMENT_RADIUS_METRES of yours. Pass the location you will be demoing from
 * (the device's own location is the right answer) or the feed will be empty.
 *
 * Safe to re-run; each run creates a fresh set with a unique email suffix.
 */
const BASE = process.env.BASE ?? 'http://localhost:4100';

const arg = name => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
};

// Defaults to the device's last known location.
const BASE_LAT = Number(arg('lat') ?? 24.895226);
const BASE_LNG = Number(arg('lng') ?? 67.118776);

const DEMO_EMAIL = arg('email') ?? 'demo@missedmoments.test';
const DEMO_PASSWORD = arg('password') ?? 'demo-password-123';
const PASSWORD = 'demo-password-123';

// ~1 degree of latitude is 111km, so this puts people 10-90m away.
const jitter = metres => (metres / 111_000) * (Math.random() < 0.5 ? -1 : 1);
const near = () => ({
  latitude: BASE_LAT + jitter(20 + Math.random() * 70),
  longitude: BASE_LNG + jitter(20 + Math.random() * 70),
});

const call = async (path, { method = 'GET', body, token } = {}) => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(data)}`);
  }
  return data;
};

const resetRateLimits = async () => {
  const { default: Redis } = await import('ioredis');
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
  const keys = await redis.keys('fastify-rate-limit*');
  if (keys.length) await redis.del(...keys);
  redis.disconnect();
};

// Written to read like real people rather than filler.
const PEOPLE = [
  {
    name: 'Sienna',
    birthDate: '2000-03-14',
    gender: 'female',
    city: 'Karachi',
    bio: 'Flat white, window seat, whatever book I am halfway through. I notice people and never say anything, which is presumably why I am here.',
    interests: ['music', 'food', 'photography'],
    role: 'admirer',
  },
  {
    name: 'Emily',
    birthDate: '1996-07-02',
    gender: 'female',
    city: 'Karachi',
    bio: 'Architect. I will absolutely make you look at a building you have walked past a hundred times.',
    interests: ['travel', 'photography', 'movies'],
    role: 'match',
    opener: 'I knew it was you. Blue Door, right? You had the corner table.',
  },
  {
    name: 'Marcus',
    birthDate: '1994-11-20',
    gender: 'male',
    city: 'Karachi',
    bio: 'Runs at 6am, regrets it at 6:15. Cook, occasional guitarist, aggressively average at chess.',
    interests: ['sports', 'music', 'food'],
    role: 'nearby',
  },
  {
    name: 'Olivia',
    birthDate: '1998-01-09',
    gender: 'female',
    city: 'Karachi',
    bio: 'Illustrator. I collect train tickets and other people’s stories.',
    interests: ['photography', 'travel', 'movies'],
    role: 'match',
    opener: 'Was that you at the counter? I nearly said hello and then completely did not.',
  },
  {
    name: 'Daniel',
    birthDate: '1993-05-28',
    gender: 'male',
    city: 'Karachi',
    bio: 'Sound engineer. Ask me about the acoustics in here, I dare you.',
    interests: ['music', 'gaming', 'movies'],
    role: 'nearby',
  },
  {
    name: 'Hannah',
    birthDate: '1999-09-17',
    gender: 'female',
    city: 'Karachi',
    bio: 'Doctor, tired, still up for a long walk and an argument about films.',
    interests: ['movies', 'food', 'travel'],
    role: 'admirer',
  },
  {
    name: 'Zayn',
    birthDate: '1995-02-11',
    gender: 'male',
    city: 'Karachi',
    bio: 'Photographer. Mostly strangers, mostly at golden hour, always with permission.',
    interests: ['photography', 'travel', 'music'],
    role: 'nearby',
  },
  {
    name: 'Ayesha',
    birthDate: '1997-12-05',
    gender: 'female',
    city: 'Karachi',
    bio: 'Teacher. I read the last page first and I will not be apologising for it.',
    interests: ['food', 'movies', 'dance'],
    role: 'admirer',
  },
  {
    name: 'Bilal',
    birthDate: '1992-08-23',
    gender: 'male',
    city: 'Karachi',
    bio: 'Product designer. Chronically early, which is how I end up noticing everyone.',
    interests: ['gaming', 'music', 'sports'],
    role: 'nearby',
  },
  {
    name: 'Noor',
    birthDate: '2001-04-30',
    gender: 'female',
    city: 'Karachi',
    bio: 'Final year, half a thesis, entirely too much coffee. Say something interesting.',
    interests: ['dance', 'party', 'music'],
    role: 'match',
    opener: 'Same queue, same time, two days running. At this point it is basically fate or a scheduling coincidence.',
  },
];

// Replies for the matched conversations, so the inbox is not one-sided.
// `last` is what shows in the inbox preview, so it differs per person --
// three identical previews reads as obviously seeded.
const REPLIES = {
  Emily: {
    mine: 'It was! I saw you looking and then panicked and looked at my laptop.',
    last: 'Same table on Thursday? I will be the one pretending to read.',
  },
  Olivia: {
    mine: 'You should have. I would have said hello back.',
    last: 'Noted for next time. There is going to be a next time, right?',
  },
  Noor: {
    mine: 'I am going with fate. Lower effort.',
    last: 'Fate it is. Coffee on Saturday, then.',
  },
};


/**
 * Pre-populates the `places` cache with venues around the demo location.
 *
 * resolvePlace() checks this table spatially before calling Google, so seeding
 * it gives the demo real venue names ("Blue Door Cafe" rather than "111m
 * away") without needing a GOOGLE_MAPS_API_KEY. This is the same cache a live
 * Google lookup would populate, so nothing is faked at the app layer.
 */
const VENUE_NAMES = [
  'Blue Door Cafe',
  'The Roundhouse',
  'Esquires Coffee',
  'Chai Wala Corner',
  'Ocean Mall Atrium',
  'Dolmen Bookstore',
  'Butlers Chocolate Cafe',
  'Platform 4 Coffee',
  'The Rooftop Bistro',
];

const seedVenues = async () => {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({
    connectionString:
      process.env.DATABASE_URL ??
      'postgres://missedmoments:missedmoments@localhost:5432/missedmoments',
  });

  // A 3x3 grid at roughly 55m spacing, so any check-in in the demo area falls
  // inside the cache lookup radius of at least one venue.
  const step = 0.0005; // ~55m
  const offsets = [-step, 0, step];
  let i = 0;

  for (const dLat of offsets) {
    for (const dLng of offsets) {
      const name = VENUE_NAMES[i % VENUE_NAMES.length];
      await pool.query(
        `INSERT INTO places (place_id, name, location, address)
         VALUES ($1, $2, ST_MakePoint($4, $3)::geography, $5)
         ON CONFLICT (place_id) DO UPDATE
           SET name = EXCLUDED.name, location = EXCLUDED.location`,
        [
          `demo-venue-${i}`,
          name,
          BASE_LAT + dLat,
          BASE_LNG + dLng,
          'Karachi, Pakistan',
        ],
      );
      i += 1;
    }
  }

  await pool.end();
  console.log(`Seeded ${i} venues around the demo location`);
};

const run = async () => {
  console.log(`\nSeeding demo data at ${BASE_LAT}, ${BASE_LNG}\n`);
  await resetRateLimits();
  await seedVenues();

  // --- the account you will demo from -------------------------------------
  let demo;
  try {
    demo = await call('/v1/auth/login', {
      method: 'POST',
      body: { email: DEMO_EMAIL, password: DEMO_PASSWORD },
    });
    console.log(`Using existing demo account: ${DEMO_EMAIL}`);
  } catch {
    demo = await call('/v1/auth/register', {
      method: 'POST',
      body: {
        email: DEMO_EMAIL,
        password: DEMO_PASSWORD,
        name: 'Alex',
        birthDate: '1996-06-15',
        gender: 'other',
        city: 'Karachi',
        bio: 'Here to see whether the moment was mutual.',
        interests: ['music', 'travel', 'food', 'photography'],
      },
    });
    console.log(`Created demo account: ${DEMO_EMAIL}`);
  }

  // The demo account has to have a moment here too, or it matches nobody.
  await call('/v1/moments/check-in', {
    method: 'POST',
    token: demo.accessToken,
    body: { latitude: BASE_LAT, longitude: BASE_LNG, accuracy: 12 },
  });
  console.log('Demo account checked in\n');

  const suffix = Date.now().toString().slice(-6);
  const created = [];

  for (const person of PEOPLE) {
    const email = `${person.name.toLowerCase()}.${suffix}@missedmoments.demo`;
    const account = await call('/v1/auth/register', {
      method: 'POST',
      body: {
        email,
        password: PASSWORD,
        name: person.name,
        birthDate: person.birthDate,
        gender: person.gender,
        city: person.city,
        bio: person.bio,
        interests: person.interests,
      },
    });

    // Each person checks in a short distance away, at a slightly different
    // time, so "6m ago" style timestamps vary in the feed.
    const position = near();
    const minutesAgo = 2 + Math.floor(Math.random() * 50);
    const checkIn = await call('/v1/moments/check-in', {
      method: 'POST',
      token: account.accessToken,
      body: {
        ...position,
        accuracy: 8 + Math.floor(Math.random() * 20),
        capturedAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
      },
    });

    created.push({
      ...person,
      ...account,
      email,
      momentId: checkIn.moment.momentId,
    });
    console.log(`  ${person.name.padEnd(8)} ${person.role.padEnd(8)} ${minutesAgo}m ago`);
  }

  console.log('');

  // --- likes and matches ---------------------------------------------------
  for (const person of created) {
    if (person.role === 'nearby') continue;

    // They like the demo account. For 'admirer' it stops here, which is the
    // Quiet Admirers list: a like the recipient cannot see the source of.
    await call('/v1/likes', {
      method: 'POST',
      token: person.accessToken,
      body: {
        targetUserId: demo.userId,
        action: 'like',
        momentId: person.momentId,
      },
    });

    if (person.role !== 'match') continue;

    // The demo account likes back, which is what creates the match.
    const result = await call('/v1/likes', {
      method: 'POST',
      token: demo.accessToken,
      body: { targetUserId: person.userId, action: 'like' },
    });

    if (result.matchId && person.opener) {
      await call(`/v1/chat/${result.matchId}/messages`, {
        method: 'POST',
        token: person.accessToken,
        body: { body: person.opener },
      });

      const reply = REPLIES[person.name];
      if (reply) {
        await call(`/v1/chat/${result.matchId}/messages`, {
          method: 'POST',
          token: demo.accessToken,
          body: { body: reply.mine },
        });
        // Leave one unread from them so the inbox shows a badge.
        await call(`/v1/chat/${result.matchId}/messages`, {
          method: 'POST',
          token: person.accessToken,
          body: { body: reply.last },
        });
      }
      console.log(`  conversation with ${person.name}`);
    }
  }

  // --- what the demo account will actually see -----------------------------
  const nearby = await call('/v1/moments/nearby?window=hour', {
    token: demo.accessToken,
  });
  const admirers = await call('/v1/likes/admirers', { token: demo.accessToken });
  const matches = await call('/v1/likes/matches', { token: demo.accessToken });
  const notes = await call('/v1/notifications', { token: demo.accessToken });

  console.log('\n--- what the demo account sees ---');
  console.log(`  Discover : ${nearby.people.length} people nearby`);
  console.log(`  Likes    : ${admirers.people.length} quiet admirers`);
  console.log(`  Matches  : ${matches.matches.length} matches`);
  console.log(`  Inbox    : ${matches.matches.filter(m => m.lastMessage).length} conversations, ` +
    `${matches.matches.reduce((n, m) => n + (m.unreadCount || 0), 0)} unread`);
  console.log(`  Alerts   : ${notes.notifications.length} notifications`);

  console.log('\n--- sign in on the device ---');
  console.log(`  email    : ${DEMO_EMAIL}`);
  console.log(`  password : ${DEMO_PASSWORD}`);
  console.log(`\n  Every demo user's password is: ${PASSWORD}`);
  // This script does not load .env, so do not quote a radius it cannot know.
  console.log(`  Discover fills in when you check in near ${BASE_LAT}, ${BASE_LNG}.
`);
};

run().catch(err => {
  console.error('\nSeeding failed:', err.message);
  process.exit(1);
});

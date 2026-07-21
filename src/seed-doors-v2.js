/**
 * node src/seed-doors-v2.js
 *
 * Replaces the "B2C — Security Screen Doors" sequence with a tighter, higher-
 * intent 10-email version for a WARM list (people who previously asked us about
 * security screens). Not cold outreach.
 *
 * Arc across the ten: open on the security instinct, move to how it feels to
 * live with, close on proof, economics, and a risk-free guarantee. One clear
 * action per email. Reply and photo CTAs early because they re-engage a warm
 * list far better than "browse our products."
 *
 * Copy rules: plain human voice, short sentences, no em dashes. Every claim is
 * either about our own product or stated as an inference, never as cited
 * statistics we cannot source.
 *
 * Delays are days AFTER the previous step (matches the existing seed's usage),
 * spread over ~70 days so a considered purchase does not get ten messages in a
 * month.
 */
require('dotenv').config();
const { pool } = require('./db');

const SEQUENCE_NAME = 'B2C — Security Screen Doors';

// [stepNumber, delayDaysAfterPrevious, subject, body]
const STEPS = [
  [1, 0,
`Door, windows, or both?`,
`Hi {first_name},

A while back you looked into security screens from us. Quick question so I point you the right way.

What are you thinking about protecting first?

A. A front, side, or sliding door
B. One or more windows
C. Both

Reply with A, B, or C and your ZIP code. I will tell you what we would secure first and whether we install in your area.

If it is easier, text a photo of the opening to (747) 688-9992.

No pressure either way. I just do not want to send you things that do not fit what you actually need.

{salesperson_name}
Sure Secured`],

  [2, 3,
`The three openings we would check first`,
`Hi {first_name},

Most people think they have to secure the whole house at once. You do not.

When we look at a home, we usually start with three spots:

1. Ground floor doors that cannot be seen from the street
2. Sliding doors and side entrances
3. Windows next to a fence, side yard, or landscaping someone could stand behind

Those are the openings that give a person the most time and the least attention.

Here is the easiest way to find out which one matters most for your place. Text 3 to 5 photos of the doors or windows you are worried about to (747) 688-9992. I will tell you which one I would secure first and roughly what it runs.

Costs nothing and takes about two minutes.

{salesperson_name}
Sure Secured`],

  [3, 4,
`What a security screen can and cannot do`,
`Hi {first_name},

I will be straight with you. No screen makes a house impossible to get into. Anyone who tells you different is selling.

The real goal is simpler. Make the opening slow enough, loud enough, and stubborn enough that whoever is trying gives up and moves on.

Most doors fail at the frame, not the lock. The wood splits, the strike plate tears out, and the deadbolt ends up in a pile of splinters, still locked.

Our screen works differently. It is 316 marine grade stainless steel mesh in a triple interlock aluminum frame that connects at three points. There is no single weak spot that gives out and takes the rest with it.

Want to see it take a beating? Reply and I will send you a short clip.

{salesperson_name}
Sure Secured`],

  [4, 5,
`Will it look like a jail?`,
`Hi {first_name},

This is the thing that stops most people, so let us get it out of the way.

Bars and iron look like you are expecting trouble. A lot of folks will not put that on the front of their home, and I do not blame them.

Our screens do not read that way. The mesh is thin and dark, so from a few feet back you mostly see straight through it, like a regular screen door. You keep the light. You keep the breeze. You still see the street.

The difference is this one does not tear when someone leans into it.

[[img://suresecured.com/cdn/shop/files/sh-installed.png?width=1200|Sure Secured security screen door installed on a home]]

If you want to see what it looks like on a real home, reply and I will send you a few more photos from jobs around LA County.

{salesperson_name}
Sure Secured`],

  [5, 6,
`The morning after`,
`Hi {first_name},

The feedback that sticks with us is not about how the screen looks. It is the call after something happens.

Someone tries the door, the screen holds, and the family inside sleeps through it. The next morning they see the scuff marks and realize how close it was.

That is the whole point. Not to scare anyone off your street. Just to make your door the one that is not worth the time.

If you want, I will walk you through what we would put on your specific doors. Text a photo to (747) 688-9992 or reply here.

{salesperson_name}
Sure Secured`],

  [6, 8,
`What you are actually getting`,
`Hi {first_name},

Since you looked into these, here is the plain version of what the screen is made of.

Mesh: 316 marine grade stainless steel. The grade they use on boats because it does not rust out.
Frame: aluminum, triple interlock, three connection points with a security clamp. No exposed screws to pop off.
Lock: multi point, so it holds along the whole edge, not just one spot.
Fit: measured and built for your exact opening. Not a one size box off a shelf.
Airflow and light: the weave is open, so it is built to keep the breeze and the view.

[[img://suresecured.com/cdn/shop/files/mesh.png?width=1200|316 marine grade stainless steel mesh close up]]

Free shipping anywhere in the country. If you are in LA County, we install it for you.

Want the one page buyer checklist, so you know what to look for even if you shop around? Reply with the word checklist and I will send it.

{salesperson_name}
Sure Secured`],

  [7, 9,
`Screens vs bars vs an alarm`,
`Hi {first_name},

You have probably weighed a few options. Here is the honest rundown, including where the others win.

Alarm or camera: tells you after someone is already inside. Good for evidence. Does nothing to keep them out.
Window bars or iron doors: strong, but they look the part, and depending on the room they can make it harder to get out in a fire.
A security screen: sits in front of the opening as a physical barrier, keeps the light and airflow, and does not box you in.

Honestly, a lot of homes are best with a screen on the main entry points and a camera for the rest. I am happy to tell you what mix makes sense for yours instead of pushing the most expensive thing.

Reply with your biggest concern and I will give you a straight answer.

{salesperson_name}
Sure Secured`],

  [8, 10,
`What this actually costs`,
`Hi {first_name},

Nobody likes chasing a price, so here is how it works.

Most single door screens land in a range depending on size, and the price covers the custom build and the hardware. If you are in LA County, installation is included. Shipping is free either way.

If paying all at once is not ideal, we have financing that breaks it into monthly payments. Your actual payment and terms depend on approval, so I will not pretend to quote you an exact number here.

The fastest way to a real number for your home is to text photos of your doors to (747) 688-9992. I will get you a range the same day.

{salesperson_name}
Sure Secured`],

  [9, 11,
`If it ever fails, that is on us`,
`Hi {first_name},

Here is the part that should make this an easy call.

Every screen comes with a lifetime break in warranty. If someone ever defeats it, we handle it. No inspection fee to file, no runaround.

The mesh and frame carry their own long term coverage too. I will send you the exact written warranty so you are not taking my word for it.

I am putting the risk on us on purpose. You should not have to gamble on whether this holds up. That is our job to prove, not yours.

Want to move forward, or just see the numbers? Reply here, or request a quote at suresecured.com/pages/request-a-quote.

{salesperson_name}
Sure Secured`],

  [10, 14,
`Should I keep these coming?`,
`Hi {first_name},

I do not want to fill your inbox if the timing is just not right, so let us make this simple.

Reply with one number:

1. I am interested now, let us talk
2. Not now, check back in a few months
3. Just doors
4. Just windows
5. Not interested, take me off

Whatever you pick, I will respect it. If it is 5, you will not hear from me again.

And if you ever want a straight answer on securing a door or window, you know where to find me. Text a photo to (747) 688-9992 anytime.

{salesperson_name}
Sure Secured`],
];

async function run() {
  const { rows } = await pool.query('SELECT id FROM sequences WHERE name = $1', [SEQUENCE_NAME]);
  if (!rows.length) { console.error(`Sequence not found: ${SEQUENCE_NAME}`); process.exit(1); }
  const seqId = rows[0].id;

  // Guard: do not rewrite a sequence people are actively moving through.
  const active = await pool.query(
    `SELECT COUNT(*)::int AS n FROM contact_enrollments WHERE sequence_id = $1 AND status = 'active'`,
    [seqId]
  );
  if (active.rows[0].n > 0) {
    console.error(`Refusing: ${active.rows[0].n} active enrollment(s) on this sequence. Pause them first.`);
    process.exit(1);
  }

  // Update steps 1-10 in place rather than delete-and-reinsert. A step that has
  // already been sent is referenced by email_sends.step_id, so deleting it
  // violates that foreign key (and would orphan send history). Upserting keeps
  // each step's id stable, so historical sends stay attached to their step.
  for (const [n, delay, subject, body] of STEPS) {
    await pool.query(
      `INSERT INTO sequence_steps (sequence_id, step_number, delay_days, subject, body)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (sequence_id, step_number)
       DO UPDATE SET delay_days = $3, subject = $4, body = $5`,
      [seqId, n, delay, subject, body]
    );
  }
  // Retire the old steps 11-20. Safe to delete only because none of them have
  // send history; if any did, this would need an `active` flag instead of a
  // delete. Guarded so we never remove a retired step that was actually sent.
  const orphanRefs = await pool.query(
    `SELECT COUNT(*)::int AS n FROM email_sends es
     JOIN sequence_steps ss ON ss.id = es.step_id
     WHERE ss.sequence_id = $1 AND ss.step_number > $2`,
    [seqId, STEPS.length]
  );
  if (orphanRefs.rows[0].n > 0) {
    console.error(`Refusing: ${orphanRefs.rows[0].n} send(s) reference steps beyond ${STEPS.length}. Needs an active flag, not a delete.`);
    process.exit(1);
  }
  await pool.query(
    'DELETE FROM sequence_steps WHERE sequence_id = $1 AND step_number > $2',
    [seqId, STEPS.length]
  );

  const check = await pool.query(
    'SELECT COUNT(*)::int AS n FROM sequence_steps WHERE sequence_id = $1', [seqId]);
  console.log(`Doors sequence (id ${seqId}) rebuilt: ${check.rows[0].n} steps.`);
  await pool.end();
}

run().catch(e => { console.error(e.message); process.exit(1); });

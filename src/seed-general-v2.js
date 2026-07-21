/**
 * node src/seed-general-v2.js
 *
 * "B2C — General Home Security" as a 10-email warm-list sequence for people who
 * want doors and windows, or are not sure yet. Same arc and voice as the Doors
 * rewrite, broadened to the whole home. No em dashes, claims kept defensible.
 */
require('dotenv').config();
const { rebuildSequence } = require('./lib/seedSequence');
const { pool } = require('./db');

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

Easiest way to find out which one matters most for your place. Text 3 to 5 photos of the doors or windows you are worried about to (747) 688-9992. I will tell you which one I would secure first and roughly what it runs.

Costs nothing and takes about two minutes.

{salesperson_name}
Sure Secured`],

  [3, 4,
`What a security screen can and cannot do`,
`Hi {first_name},

Straight with you. No screen makes a home impossible to get into. Anyone who says otherwise is selling.

The goal is simpler. Make the opening slow, loud, and stubborn enough that whoever is trying gives up and moves on.

Most doors fail at the frame, not the lock, and a regular window screen tears like paper. Ours is a different thing. 316 marine grade stainless steel mesh in a triple interlock aluminum frame, on your doors and your windows alike.

Do not take my word for it. Here is one getting kicked and pried:

[[video:https://www.youtube.com/shorts/z2JtbkNpPyA]]

Have a specific opening in mind? Reply with a photo and your ZIP and I will tell you what I would put on it.

{salesperson_name}
Sure Secured`],

  [4, 5,
`Will it look like a jail?`,
`Hi {first_name},

This is the thing that stops most people, so let us get it out of the way.

Bars and iron look like you are expecting trouble. A lot of folks will not put that on their home, and I do not blame them.

Our screens do not read that way. The mesh is thin and dark, so from a few feet back you mostly see straight through, on a door or a window. You keep the light. You keep the breeze. You still see out.

Here is one on a home:

[[img://suresecured.com/cdn/shop/files/sh-installed.png?width=1200|Sure Secured security screen installed on a home]]

Want a few more from jobs around LA County, doors and windows? Reply and I will send them.

{salesperson_name}
Sure Secured`],

  [5, 6,
`The morning after`,
`Hi {first_name},

The feedback that sticks with us is not about how the screen looks. It is the call after something happens.

Someone tries a door or a back window, the screen holds, and the family inside sleeps through it. The next morning they see the marks and realize how close it was.

That is the whole point. Not to scare anyone off your street. Just to make your home the one that is not worth the time.

If you want, I will look at your specific doors and windows and tell you what I would do first. Text a photo to (747) 688-9992 or reply here.

{salesperson_name}
Sure Secured`],

  [6, 8,
`What you are actually getting`,
`Hi {first_name},

Since you looked into these, here is the plain version of what the screens are made of.

Mesh: 316 marine grade stainless steel. The grade they use on boats because it does not rust out.
Frame: aluminum, triple interlock, three connection points with a security clamp. No exposed screws.
Fit: measured and built for each exact opening, doors and windows. Not one size boxes off a shelf.
Airflow and light: the weave is open, so it is built to keep the breeze and the view.

[[img://suresecured.com/cdn/shop/files/mesh.png?width=1200|316 marine grade stainless steel mesh close up]]

Free shipping anywhere in the country. If you are in LA County, we install it.

Want the one page buyer checklist so you know what to look for, even if you shop around? Reply with the word checklist.

{salesperson_name}
Sure Secured`],

  [7, 9,
`Screens vs bars vs an alarm`,
`Hi {first_name},

You have probably weighed a few options. Here is the honest rundown, including where the others win.

Alarm or camera: tells you after someone is already inside. Good for evidence. Does nothing to keep them out.
Bars or iron doors: strong, but they look the part, and on a bedroom window they can make it hard to get out in a fire.
A security screen: a physical barrier on the opening that keeps the light and airflow and does not box you in.

Honestly, most homes are best with screens on the main doors and the vulnerable windows, plus a camera for the rest. I am happy to tell you the mix that makes sense for yours instead of pushing the most expensive thing.

Reply with your biggest concern and I will give you a straight answer.

{salesperson_name}
Sure Secured`],

  [8, 10,
`What this actually costs`,
`Hi {first_name},

Nobody likes chasing a price, so here is how it works.

Doors and windows each land in a range depending on size and type, and the price covers the custom build and the hardware. If you are in LA County, installation is included. Shipping is free either way.

Most people do not do the whole house at once. We start with the two or three openings that matter most and go from there, so it is not one big number up front.

If paying all at once is not ideal, we have financing that breaks it into monthly payments. Your actual payment and terms depend on approval, so I will not pretend to quote an exact number here.

Fastest way to a real number: text photos of your doors and windows to (747) 688-9992. I will get you a range the same day.

{salesperson_name}
Sure Secured`],

  [9, 11,
`If it ever fails, that is on us`,
`Hi {first_name},

Here is the part that should make this easy.

Every screen comes with a lifetime break in warranty, doors and windows. If someone ever defeats one, we handle it. No inspection fee to file, no runaround.

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

And if you ever want a straight answer on securing your home, you know where to find me. Text a photo to (747) 688-9992 anytime.

{salesperson_name}
Sure Secured`],
];

rebuildSequence('B2C — General Home Security', STEPS,
  '10-email doors + windows sequence for prior inquirers. Qualify, prove, close over ~70 days.')
  .then(() => pool.end())
  .catch(e => { console.error(e.message); process.exit(1); });

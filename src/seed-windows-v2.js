/**
 * node src/seed-windows-v2.js
 *
 * "B2C — Security Screen Windows" as a 10-email warm-list sequence, same arc and
 * voice as the Doors rewrite, focused on windows. Plain human voice, no em
 * dashes, claims kept to our own product or stated as inference.
 */
require('dotenv').config();
const { rebuildSequence } = require('./lib/seedSequence');
const { pool } = require('./db');

const STEPS = [
  [1, 0,
`Which windows are you thinking about?`,
`Hi {first_name},

A while back you looked into security screens for your windows. Quick question so I point you the right way.

Which windows are on your mind first?

A. Ground floor windows you can see from the street
B. Back or side windows near a fence or side yard
C. Bedroom or fire escape windows

Reply with A, B, or C and your ZIP code. I will tell you which ones I would secure first and whether we install in your area.

If it is easier, text a photo of the window to (747) 688-9992.

No pressure. I just do not want to send you things that do not fit what you actually need.

{salesperson_name}
Sure Secured`],

  [2, 3,
`The windows we would secure first`,
`Hi {first_name},

You do not need to cover every window at once. Most homes have a few that matter far more than the rest.

We usually start with three:

1. Ground floor windows hidden from the street by a fence, wall, or landscaping
2. Windows near a side gate or back yard where someone has time to work
3. Any window big enough for a person to climb through with an easy reach from the ground

Those give a person the most time and the least attention.

Easiest way to find out which one matters most for your place. Text 3 to 5 photos of the windows you are worried about to (747) 688-9992. I will tell you which one I would secure first and roughly what it runs.

Costs nothing and takes about two minutes.

{salesperson_name}
Sure Secured`],

  [3, 4,
`What a window screen can and cannot do`,
`Hi {first_name},

Straight with you. No screen makes a window impossible to get through. Anyone who says otherwise is selling.

The goal is to make it slow, loud, and stubborn enough that whoever is trying gives up and moves on. A regular window screen tears like paper. This is a different thing.

It is 316 marine grade stainless steel mesh in a triple interlock aluminum frame. It sits over the window as a physical barrier, not a bug screen.

Do not take my word for it. Here is one getting kicked and pried:

[[video:https://www.youtube.com/shorts/z2JtbkNpPyA]]

Have a specific window in mind? Reply with a photo and your ZIP and I will tell you what I would put on it.

{salesperson_name}
Sure Secured`],

  [4, 5,
`Will it block my light and view?`,
`Hi {first_name},

This is the question that stops most people, so let us handle it.

Bars turn a window into a cage. Most people do not want to look out through that every morning, and I do not blame them.

Our screens do not read that way. The mesh is thin and dark, so from inside you mostly look straight through it. You keep the light. You keep the view. You still open the window for a breeze.

Here is one on a home so you can see for yourself:

[[img://suresecured.com/cdn/shop/files/fw-installed.png?width=1200|Sure Secured security screen on a home window]]

Want a few more from jobs around LA County? Reply and I will send them.

{salesperson_name}
Sure Secured`],

  [5, 6,
`The window they gave up on`,
`Hi {first_name},

The feedback that sticks with us is not about how the screen looks. It is the morning after.

Someone works at a back window for a minute, the screen holds, and the family inside never wakes up to it. The next day they see the marks and realize how close it was.

That is the whole point. Not to scare anyone. Just to make your window the one that is not worth the time.

If you want, I will look at your specific windows and tell you what I would do. Text a photo to (747) 688-9992 or reply here.

{salesperson_name}
Sure Secured`],

  [6, 8,
`What you are actually getting`,
`Hi {first_name},

Since you looked into these, here is the plain version of what the screen is made of.

Mesh: 316 marine grade stainless steel. The grade they use on boats because it does not rust out.
Frame: aluminum, triple interlock, three connection points with a security clamp. No exposed screws.
Fit: measured and built for your exact window opening. Not a one size box off a shelf.
Airflow and light: the weave is open, so it is built to keep the breeze and the view.

[[img://suresecured.com/cdn/shop/files/mesh.png?width=1200|316 marine grade stainless steel mesh close up]]

Free shipping anywhere in the country. If you are in LA County, we install it.

Want the one page buyer checklist so you know what to look for, even if you shop around? Reply with the word checklist.

{salesperson_name}
Sure Secured`],

  [7, 9,
`Screens vs bars vs window film`,
`Hi {first_name},

You have probably weighed a few options for windows. Here is the honest rundown, including where the others win.

Window film: helps glass hold together when it breaks. Does nothing once the glass is out of the way.
Bars: strong, but they look like a cage, and on a bedroom window they can be a real problem getting out in a fire.
Alarm or camera: tells you after someone is already coming through. Good for evidence.
A security screen: a physical barrier over the window that keeps the light and airflow and does not trap you inside.

For a bedroom or fire escape window, that last part matters. We can set it up so it still opens for you from the inside in an emergency.

Reply with your biggest concern and I will give you a straight answer.

{salesperson_name}
Sure Secured`],

  [8, 10,
`What this actually costs`,
`Hi {first_name},

Nobody likes chasing a price, so here is how it works.

Window screens land in a range depending on size and type, and the price covers the custom build and the hardware. If you are in LA County, installation is included. Shipping is free either way.

Most people do not do every window at once. We start with the two or three that matter and go from there, so it is not one big number up front.

If paying all at once is not ideal, we have financing that breaks it into monthly payments. Your actual payment and terms depend on approval, so I will not pretend to quote an exact number here.

Fastest way to a real number: text photos of your windows to (747) 688-9992. I will get you a range the same day.

{salesperson_name}
Sure Secured`],

  [9, 11,
`If it ever fails, that is on us`,
`Hi {first_name},

Here is the part that should make this easy.

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
3. Just windows
4. Doors too
5. Not interested, take me off

Whatever you pick, I will respect it. If it is 5, you will not hear from me again.

And if you ever want a straight answer on securing a window or door, you know where to find me. Text a photo to (747) 688-9992 anytime.

{salesperson_name}
Sure Secured`],
];

rebuildSequence('B2C — Security Screen Windows', STEPS)
  .then(() => pool.end())
  .catch(e => { console.error(e.message); process.exit(1); });

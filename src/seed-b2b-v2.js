/**
 * node src/seed-b2b-v2.js
 *
 * "B2B — Become a Dealer" as a 10-email sequence for contractors, installers,
 * and security pros who asked about carrying Sure Secured. Business-opportunity
 * angle: high-margin add-on to jobs they already do, we build custom, they keep
 * the client and the margin. Plain contractor-to-contractor voice, no em dashes,
 * numbers stated as ranges since actual margins depend on the deal.
 */
require('dotenv').config();
const { rebuildSequence } = require('./lib/seedSequence');
const { pool } = require('./db');

const STEPS = [
  [1, 0,
`Are you offering security screens yet?`,
`Hi {first_name},

You reached out about carrying Sure Secured screens, so let me start simple.

Are you already offering security screens to your clients?

A. Yes, and I want a better product or better margins
B. No, but my clients keep asking for something like this
C. Just looking into it

Reply with A, B, or C and what you do (contractor, installer, handyman, security). I will tell you the fastest way to add this to what you already sell.

Or call or text me direct at (747) 688-9992.

{salesperson_name}
Sure Secured`],

  [2, 2,
`The job you are probably leaving on the table`,
`Hi {first_name},

Here is what we see. A homeowner has you out for a door, a remodel, or a repair. While you are there, they ask if there is anything you can do to make the place more secure.

If the answer is no, they call someone else, and that person now has a foot in the door on your client.

Security screens are an easy yes to that question. Same customer, same visit, another line on the invoice, and you stay the person they call.

Want to see how dealers fit it into work they are already doing? Reply and I will walk you through it.

{salesperson_name}
Sure Secured`],

  [3, 3,
`How the dealer setup actually works`,
`Hi {first_name},

No inventory to carry and no cash tied up in stock. Here is the flow.

1. You measure the opening, or we help you get the measurements right.
2. We build the screen custom to that exact opening.
3. You install it, or for LA County jobs we can handle install.
4. You keep the margin and you keep the client.

You are not becoming a security company. You are adding one clean, high quality product to jobs you already win.

Reply and I will send you the dealer pricing so you can see the margin for yourself.

{salesperson_name}
Sure Secured`],

  [4, 4,
`Why it is an easy sell`,
`Hi {first_name},

A product is easy to sell when it obviously works and it looks good. This is both.

It is 316 marine grade stainless steel mesh in a triple interlock aluminum frame, with a lifetime break in warranty behind it. Thin dark mesh, so it keeps the light and the view instead of looking like bars.

Here is one getting kicked and pried, which is the demo that closes homeowners for you:

[[video:https://www.youtube.com/shorts/z2JtbkNpPyA]]

Want the same clips and photos to show your own clients? Reply and I will send you the dealer kit.

{salesperson_name}
Sure Secured`],

  [5, 5,
`The margin, in plain numbers`,
`Hi {first_name},

You want to know if this is worth your time, so let us talk numbers.

Dealers buy at wholesale and set their own install price, so the margin per door or window lands in a healthy range depending on your market and whether you install. On a job you are already on site for, that margin comes with almost no added overhead.

I am not going to throw a fake number at you here, because it depends on your pricing and the job. But reply and I will send you the actual dealer price sheet so you can run it against your own rates.

{salesperson_name}
Sure Secured`],

  [6, 6,
`What you get behind you`,
`Hi {first_name},

Adding a product only helps if the company behind it does not leave you hanging. Here is what you get as a dealer.

Custom build on every order, measured to the opening.
The lifetime break in warranty is ours to honor, not yours to eat.
Photos, clips, and product info to show your clients.
A real person to call when you have a question on a job.

You bring the client and the install. We handle the product and stand behind it.

Reply and I will get you set up.

{salesperson_name}
Sure Secured`],

  [7, 7,
`What other dealers are seeing`,
`Hi {first_name},

The dealers who do well with this have one thing in common. They stop treating it as a separate sale and start offering it on every job where it fits.

A door install becomes a door plus a screen. A window job becomes a window plus a screen on the two that matter. Same trip, bigger ticket, and the client feels taken care of.

It is not a new business. It is more out of the work you already have.

Want to talk through how it would fit your jobs? Reply or text me at (747) 688-9992.

{salesperson_name}
Sure Secured`],

  [8, 8,
`I am not a security guy though`,
`Hi {first_name},

Hear this one a lot, so let me put it to rest.

You do not need to be a security company to offer this. If you can measure an opening and mount a frame, you can install these. It is closer to hanging a quality screen door than wiring an alarm system.

Your client does not care what category it falls under. They care that the person they already trust can make their home harder to break into. That person is you.

Reply and I will send you the install guide so you can see how simple it is.

{salesperson_name}
Sure Secured`],

  [9, 9,
`Getting started is not a big commitment`,
`Hi {first_name},

Becoming a dealer does not mean a big order or a contract you regret.

You get set up with dealer pricing, we send you the kit to show clients, and you sell your first one when the right job comes up. No minimum stock, no pressure to move volume before you are ready.

Start with one job. If it goes the way it goes for most of our dealers, the next ones are easy.

Reply with the word dealer and I will get you the pricing and the kit today.

{salesperson_name}
Sure Secured`],

  [10, 10,
`Should I keep these coming?`,
`Hi {first_name},

I do not want to clutter your inbox if this is not for you, so let us make it simple.

Reply with one number:

1. I am in, send me the dealer pricing
2. Interested, but not right now
3. Send me more info first
4. Not a fit for my business

Whatever you pick, I will respect it. If it is 4, you will not hear from me again.

And if you ever want to talk it through, call or text me direct at (747) 688-9992.

{salesperson_name}
Sure Secured`],
];

rebuildSequence('B2B — Become a Dealer', STEPS,
  '10-email dealer sequence. Opportunity, proof, partnership, close over ~55 days.')
  .then(() => pool.end())
  .catch(e => { console.error(e.message); process.exit(1); });

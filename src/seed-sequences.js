/**
 * node src/seed-sequences.js
 *
 * Seeds 4 email campaign sequences:
 *  1. B2C — Security Screen Doors
 *  2. B2C — Security Screen Windows
 *  3. B2C — General / Both
 *  4. B2B — Become a Dealer
 *
 * Arc: Reptilian (fear/survival) -> Limbic (emotion/family) -> Neocortex (logic/specs/close)
 * 20 emails over ~130 days for B2C. 12 emails over ~60 days for B2B.
 */

require('dotenv').config();
const { pool, initDb } = require('./db');

async function createSequence(name, description, audience_type) {
  const { rows } = await pool.query(
    `INSERT INTO sequences (name, description, audience_type, active)
     VALUES ($1, $2, $3, true)
     ON CONFLICT DO NOTHING RETURNING id`,
    [name, description, audience_type]
  );
  if (rows[0]) return rows[0].id;
  const existing = await pool.query('SELECT id FROM sequences WHERE name = $1', [name]);
  return existing.rows[0].id;
}

async function addStep(sequenceId, stepNumber, delayDays, subject, body) {
  await pool.query(
    `INSERT INTO sequence_steps (sequence_id, step_number, delay_days, subject, body)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (sequence_id, step_number) DO UPDATE SET delay_days=$3, subject=$4, body=$5`,
    [sequenceId, stepNumber, delayDays, subject, body]
  );
}

// ---------------------------------------------------------------------------
// SEQUENCE 1: B2C Doors
// ---------------------------------------------------------------------------

async function seedDoorSequence() {
  const id = await createSequence(
    'B2C — Security Screen Doors',
    '20-email door sequence. Reptilian -> Limbic -> Neocortex over ~130 days.',
    'B2C'
  );

  const steps = [

    // PHASE 1: REPTILIAN (emails 1-6) — survival, threat, statistics

    [1, 0,
    `Quick question about your door, {first_name}`,
    `Hi {first_name},

You came across our security screens and I wanted to reach out before too much time passed.

Here's a number I keep coming back to: a burglary happens somewhere in the US every 16 seconds. Not at night, not in rough neighborhoods. Tuesday afternoon, places just like yours.

The front door is how most of them get in.

Most standard doors can be forced open in under a minute. It's not the lock that gives out. It's the frame, the strike plate, the door itself. The lock ends up fine, sitting in a pile of splintered wood.

That's the problem our screen solves. It sits in front of your door as a second barrier that has to be defeated first.

Take a look when you get a chance: https://suresecured.com/products/single-doors`],

    [2, 2,
    `How a burglar picks which house`,
    `Hi {first_name},

Most people think burglars pick houses randomly. They don't.

Studies done with convicted burglars show the whole evaluation takes less than 60 seconds at the curb. They're looking for one thing: an easy way in without getting caught.

The stuff that actually changes their decision isn't the alarm company sign. It's whether the entry points look like they'd take time and noise to defeat.

A security screen on your front door is visible from the street. They see it and move on. The house next door without one becomes the easier target.

Not trying to scare you. Just giving you the actual picture of how these decisions get made.

Our screens: https://suresecured.com/products/single-doors`],

    [3, 2,
    `The part of your door that gives out first`,
    `Hi {first_name},

Most people think a deadbolt is what keeps a door secure. Here's what actually happens in a forced entry.

The kick goes to the frame, not the lock. The wood splits. The strike plate pulls out of the wall. The deadbolt is still perfectly intact, just sitting in a door frame that's no longer there.

A $200 lock in a $40 frame is still a $40 frame.

Our security screen addresses this differently. The triple-interlock aluminum frame connects at three separate points with a patented security clamp. There's no single spot that fails and takes everything with it.

This is what a real barrier looks like versus a lock: https://suresecured.com/products/single-doors`],

    [4, 3,
    `It happened at 2pm on a Tuesday`,
    `Hi {first_name},

A customer shared this with me and said I could pass it along.

She was at work when her phone buzzed with a camera alert. Someone had walked up to her front door, tried the handle, then moved on to the house next door.

She watched the whole thing from her desk. Her security screen was the only reason they kept walking. The house next door wasn't as lucky.

She told me she wasn't scared after she watched it. She was relieved. And then sad for her neighbor.

The thing that sticks with me is how ordinary it all looked on the camera. Just someone checking doors in the afternoon.

If you want to talk through what a screen for your entry would look like, call or text me: {salesperson_phone}`],

    [5, 3,
    `Alarms call the police. A screen stops them at the door.`,
    `Hi {first_name},

There's a difference between a system that responds to a break-in and one that prevents it.

The average police response time after an alarm goes off is 7 to 11 minutes. The average break-in takes 8 to 12 minutes. They're in and out before anyone arrives. The alarm got a recording, not a result.

A physical barrier changes the problem. Our 316 marine-grade stainless steel mesh can't be cut with standard tools. It doesn't give under impact the way a regular screen does. The triple-interlock frame has no single failure point.

The intruder has to defeat the screen before they get to your door. Most don't try. The ones that do can't do it fast enough to feel safe about it.

That's the actual difference between a notification and a barrier.

https://suresecured.com/products/single-doors`],

    [6, 4,
    `The cheap tool that beats most "security doors"`,
    `Hi {first_name},

Most doors sold as security doors use decorative wrought iron over a standard door core. They look serious. A bolt cutter handles the hinges or the exposed frame screws in about 30 seconds.

Even solid steel doors have the same issue: a panel that can be broken, or a frame that can be pried. Break the panel, reach through from the inside, turn the handle. No special tools.

Our screens are built differently on purpose.

The 316 stainless steel mesh won't cut with bolt cutters. The alloy is specifically chosen for that reason. The triple-interlock frame has no exposed fasteners. There's no panel to punch through. Air and light come through normally. Nothing else does.

https://suresecured.com/products/single-doors`],

    // PHASE 2: LIMBIC (emails 7-13) — family, emotion, peace of mind

    [7, 5,
    `What your kids do when you're not home`,
    `Hi {first_name},

Kids don't think about doors. They leave them unlocked between trips in and out, open them for knocks without checking, walk through them without a second thought. That's not a criticism. It's just how kids are.

The question most parents don't let themselves sit with: what does the house look like from the outside when you're gone and they're home?

Our security screen changes that without requiring your kid to do anything differently. They can open the main door for air. They can see who's outside without opening anything. The screen stays locked and they don't have to think about it.

The protection doesn't depend on anyone remembering a rule.

Happy to help you find the right option for your entry: {salesperson_phone}`],

    [8, 5,
    `Locking the door and actually meaning it`,
    `Hi {first_name},

There's a specific feeling most homeowners know.

You're halfway down the block and you think: did I actually lock the door? Not just pull it closed. Lock it. And even if you did, something still feels off.

Our customers describe something that shifts after installation. They still lock the door. But the question stops following them down the street. The physical barrier gives the brain something real to hold onto.

One customer said to me, "I didn't realize how much mental energy I was spending on that until it stopped."

A lock is a mechanical device. A barrier is something the brain can actually rest on.

https://suresecured.com/products/single-doors`],

    [9, 5,
    `Your neighbor just upgraded. Here's what that means for you.`,
    `Hi {first_name},

There's something that criminologists have documented about neighborhood security: when one house hardens, the adjacent properties become relatively more attractive to burglars. The threat doesn't leave the street. It redistributes.

In neighborhoods where we do a lot of installs, we see clusters. One homeowner gets a screen. Their neighbor sees it from the street. Two weeks later they call us.

Not because they're copying. Because they saw something real and thought about what it meant for their own door.

If someone on your block has already made this move, you've probably noticed it. Now you know what it is.

If you want to be the one they're noticing: https://suresecured.com/products/single-doors`],

    [10, 5,
    `A call we got at 9pm last month`,
    `Hi {first_name},

A homeowner called us on a Thursday evening, pretty shaken.

She'd gotten home to find her neighbor's door had been pried open. House three doors down. Place she walked past every day.

She wasn't calling to place an order. She just wanted to talk to someone who understood the problem. We talked for 45 minutes about her entry points, her layout, what made sense.

She wasn't ready to move forward that night. That was fine.

Two weeks later she called back. Ordered a screen for her front door and her side entry. Said the second call felt completely different. She knew what she was getting and she was ready.

If you want to have that first conversation, I'm here: {salesperson_phone}`],

    [11, 7,
    `You've worked hard for everything in that house`,
    `Hi {first_name},

Your home is the accumulation of years of showing up. The furniture you chose carefully. The renovations that finally got done. The way the place feels now.

A break-in takes 8 minutes to work through all of that.

And beyond what's taken, which insurance doesn't fully replace, there's what's left behind. The feeling that the space isn't entirely yours in the same way anymore. That someone was inside it without permission.

We don't sell security screens as a way to prevent loss. We sell them as a way to hold onto something you've already built.

https://suresecured.com/products/single-doors`],

    [12, 7,
    `The night it almost happened`,
    `Hi {first_name},

A customer of ours, a single mom in the valley, told me about the night that changed things for her.

She'd fallen asleep on the couch with the TV on. Her kids were upstairs. Around midnight she heard what she thought was wind rattling the door.

It wasn't wind.

Someone had tried the handle of her security screen. The marine-grade mesh and triple-interlock frame held. The person left. Police found no one.

She told me: "I didn't realize I'd been falling asleep with my front door basically open. The screen was the only thing between them and my kids' hallway."

She's one of the reasons I do this.

Her screen: https://suresecured.com/products/single-doors`],

    [13, 7,
    `This isn't really about security`,
    `Hi {first_name},

I've sent you a fair amount of information about statistics and materials and frame construction.

Here's the simpler version of what I've been trying to say.

Most of our customers don't buy a screen because they're scared. They buy it because they care too much about what's inside the house not to.

It's the same reason people put on seatbelts before they back out of the driveway. Not fear. Just caring enough to take the concrete step.

When you're ready to take that step, I'm here.

{salesperson_phone} or https://suresecured.com/pages/request-a-quote`],

    // PHASE 3: NEOCORTEX (emails 14-20) — specs, comparison, ROI, close

    [14, 7,
    `Why 316 marine-grade steel (not the cheap kind)`,
    `Hi {first_name},

You've probably seen different grades of steel mentioned in security products. Here's why the grade actually matters.

316 stainless is what's used in boat hardware, offshore oil platforms, and medical implants. The reason is molybdenum, an additive that makes it resist corrosion and cutting force in ways that cheaper alloys can't match.

304 stainless, the more common and cheaper alternative, corrodes faster in humidity and coastal climates. It also has lower tensile strength, which matters when someone is applying force to it.

Our 12x12 weave pattern is chosen specifically for this mesh: tight enough that nothing passes through, open enough that air and light come through normally.

This is the specific material we chose for a specific reason. It costs more. It works better.

https://suresecured.com/products/single-doors`],

    [15, 10,
    `SureSecured vs. other security doors, honestly`,
    `Hi {first_name},

You've probably looked at other options. Here's how we actually compare.

Traditional wrought iron doors run $600-$1,200 installed. Most use decorative iron over a standard door core. The mesh panels are often lower-grade steel or aluminum. Hinges and frame screws are frequently exposed. No break-in warranty on the barrier itself.

Our screens start at $1,899 and include 316 marine-grade stainless mesh, a triple-interlock frame with no exposed fasteners, a patented security clamp, free shipping nationwide, free installation in LA County, and a lifetime break-in warranty.

The price is higher. The protection level is in a different category.

One more thing worth knowing: our screens maintain full airflow and natural light. Most iron doors make rooms feel darker and more closed in. You don't have to give up the way your home feels.

Questions? I'll give you straight answers: {salesperson_phone}`],

    [16, 10,
    `What a security screen door actually costs`,
    `Hi {first_name},

Our single hinged door starts at $1,899. I want to put that number in context.

The average US home burglary results in about $2,800 in losses (FBI data). That doesn't include the $500-$1,500 to repair a forced door frame, or the deductible on whatever you're claiming.

One prevented break-in covers the screen. Twice.

We also offer financing. A single door on a 12-month plan works out to about $158 a month. On 24 months, about $79. That's less than most people spend on streaming services in a month.

If you're in LA County, installation is free.

If you want an exact quote for your specific door: https://suresecured.com/pages/request-a-quote`],

    [17, 10,
    `3 questions to ask before buying any security screen`,
    `Hi {first_name},

Before you buy from us or anyone else, these three questions are worth asking.

First: what grade is the mesh steel? The answer you want is 316 stainless. 304 is cheaper and more common. If the company can't tell you the alloy grade immediately, that's an answer in itself.

Second: how does the frame lock? Single-point locks have single failure points. You want triple-interlock with a patented security clamp, and you want to know whether the frame fasteners are exposed or concealed.

Third: what does the warranty cover in a break-in? "Lifetime warranty" often means manufacturing defects. Ask specifically: if my screen is defeated during a break-in, what happens? Ours replaces it. Most others don't cover that.

We pass all three. Ask the competitors the same questions.

{salesperson_phone}`],

    [18, 14,
    `Our warranty, in plain terms`,
    `Hi {first_name},

Our lifetime break-in warranty covers this: if your SureSecured screen is defeated during an actual break-in attempt, we replace the unit at no cost, for the life of the product.

No deductible. No inspection fee. We replace it.

We offer this because we have not had a screen fail a break-in attempt since we've been doing this. The warranty is confidence in writing, not fine print that escapes the situation.

It doesn't cover accidental damage, modifications after installation, or wear unrelated to a security event. I want to be upfront about that.

The warranty comes with every order.

Ready to move forward: https://suresecured.com/pages/request-a-quote`],

    [19, 14,
    `Financing, if that helps`,
    `Hi {first_name},

A few people have come back to me after we've talked and said the upfront cost is a tough month.

I get that. And I don't want it to be the reason the door isn't protected.

We offer financing options. For a single hinged door at $1,899, that works out to roughly $158 a month over 12 months, or $79 over 24 months. Exact terms depend on your approval.

If you're in LA County, installation is included at no extra cost.

To start the financing conversation: https://suresecured.com/pages/financing

Or call me directly: {salesperson_phone}`],

    [20, 14,
    `My last message to you`,
    `Hi {first_name},

This is the last email I'll send.

If the timing wasn't right, that's completely fine. Hold onto my number. When it makes sense for you, I'm here.

If there's something specific I didn't answer, I'd genuinely like to try. Call or text me directly: {salesperson_phone}. Not a call center. Me.

For anyone coming from this email, I'll do a free consultation with no pressure. We'll talk through your entry points and what actually makes sense for your situation. If we're the right fit, great. If not, you'll have better information than when we started.

That's the offer.

https://suresecured.com/pages/request-a-quote`],

  ];

  for (const [n, d, s, b] of steps) await addStep(id, n, d, s, b);
  console.log(`Door sequence: ${steps.length} steps`);
  return id;
}

// ---------------------------------------------------------------------------
// SEQUENCE 2: B2C Windows
// ---------------------------------------------------------------------------

async function seedWindowSequence() {
  const id = await createSequence(
    'B2C — Security Screen Windows',
    '20-email window sequence. Reptilian -> Limbic -> Neocortex over ~130 days.',
    'B2C'
  );

  const steps = [

    [1, 0,
    `About the windows in your home, {first_name}`,
    `Hi {first_name},

Thanks for your interest in our security screen windows.

Windows are the second most common entry point in residential break-ins, right behind front doors. And most homeowners have no barrier on them at all.

A standard window latch is designed to keep the window from opening in the wind. That's it. One hard pull from outside, or a quick break near the latch to reach through from inside, and it's open.

Our security screens install over your existing windows as a second layer. The 316 marine-grade stainless steel mesh sits between the outside world and your glass. The window stays. The weak point goes away.

You keep the light and the airflow. The vulnerability is what you lose.

https://suresecured.com/products/fixed-security-screen-windows`],

    [2, 2,
    `The window technique most homeowners don't know about`,
    `Hi {first_name},

There's a method called glass fishing that's more common than most people know.

The burglar breaks a small section of glass near the latch, reaches in, flips the latch from the inside, and opens the window. The whole thing takes under 20 seconds. No prying, no noise to speak of, easy exit.

Regular window screens stop insects. Nothing else.

A security screen changes this completely. Breaking the glass gets them nowhere because the mesh is on the outside of the glass, secured with a triple-interlock frame. There's nothing accessible on the other side of the break.

The gap in most window security isn't the glass. It's the absence of anything behind the glass.

https://suresecured.com/products/fixed-security-screen-windows`],

    [3, 2,
    `Ground floor windows: the entry point everyone overlooks`,
    `Hi {first_name},

Front door security gets most of the attention. Ground floor and side windows are almost always the afterthought.

Which is exactly why they're targeted.

A side or back window typically has no sightline from the street. Landscaping and fencing provide cover. A burglar working a back window has time and concealment that a front door approach never gives them.

Our fixed security screen windows are specifically designed for these positions. They install clean, look like part of the window rather than an add-on, and provide the same marine-grade barrier as our door screens.

The places nobody's watching are exactly where the protection matters most.

https://suresecured.com/products/fixed-security-screen-windows`],

    [4, 3,
    `What a broken window sounds like at 3am`,
    `Hi {first_name},

Picture this: it's 3am and you hear something break somewhere in the house.

You lie still and listen, trying to figure out if it was a dream.

It wasn't.

Most security plans assume you'll have time to respond. To call someone, get to safety, do something. The reality is that window entry is quiet and fast. By the time you've registered what's happening, someone is already inside.

A security screen doesn't require you to respond. It requires the intruder to defeat a barrier they weren't expecting, in the open, taking time they don't have.

Most of them leave.

https://suresecured.com/products/fixed-security-screen-windows`],

    [5, 3,
    `Window alarms are missing the point`,
    `Hi {first_name},

Window alarms go off when the glass breaks or the window opens.

By that point, someone is already inside your home.

The alarm didn't stop the entry. It started the clock on a 7-minute police response while a stranger is standing in your house.

A security screen sits outside the window before the glass. There's nothing to reach through to, no latch to flip from the broken side, no way in that the alarm needs to document.

The screen stops the entry. The alarm never has to trigger.

https://suresecured.com/products/fixed-security-screen-windows`],

    [6, 4,
    `What window security products don't tell you`,
    `Hi {first_name},

There are a few common window security options worth understanding honestly.

Laminated glass holds shattered pieces in place but isn't a barrier. A determined person goes through it. And it requires replacing all your existing windows at $300-600 per window.

Window film slows glass breakage. It's not a physical barrier.

Window bars are effective but create a serious fire exit risk, look institutional, and affect property value.

Standard screens keep bugs out. That's all they're designed for.

Our security screens are the one option that provides a real physical barrier without replacing your windows, creating a fire hazard, or changing how your home looks and feels from inside.

For the fire escape version, there's a quick-release mechanism so exit is always possible from the inside.

https://suresecured.com/products/fixed-security-screen-windows`],

    [7, 5,
    `Sleeping with the windows open`,
    `Hi {first_name},

How many nights do you close and lock every window before bed because it's easier than worrying about it?

It becomes a habit without you realizing you've made a choice. Windows shut. Air conditioning on. Something you gave up quietly.

Our customers tell us this more than almost anything else: after the screens go in, they start sleeping with windows open again.

Not because they stopped being careful. Because they have a real barrier they can trust.

The screen doesn't just protect the window. It gives the window back.

https://suresecured.com/products/fixed-security-screen-windows`],

    [8, 5,
    `The bedroom window question`,
    `Hi {first_name},

Here's something worth thinking about.

If someone were going to come through a window in your home, which one would be easiest to reach without being seen from the street?

For most homes the answer is a side or back bedroom window. Often a child's room.

Our fire escape security screen windows include a quick-release mechanism that opens from the inside in seconds, simple enough for a child to use. The emergency exit function is preserved. Only the unauthorized entry from outside is stopped.

You don't have to choose between security and safety.

{salesperson_phone}`],

    [9, 5,
    `What happened in a neighborhood like yours`,
    `Hi {first_name},

We did an install last spring for a family in the valley. Quiet street, good neighborhood.

Six weeks after the screens went in, their neighbor had a break-in through a side window. Same style home, same window position, same kind of latch.

The family watched the police from their driveway. They told me they didn't feel good about it. They felt grateful and sad at the same time.

"We kept thinking that could have been our window," the wife said.

Security isn't about the neighborhood. It's about the specific vulnerabilities of your specific home.

Would you like to talk through what yours look like? {salesperson_phone}`],

    [10, 5,
    `The light that comes through`,
    `Hi {first_name},

Most people expect the screens to darken the house or make it feel more enclosed.

The opposite tends to happen.

Our mesh is 316 stainless steel, not painted aluminum or fiberglass. It doesn't absorb light or create the yellow tint you get with older screens. The view through it is clear. Natural light comes through the same as before.

Customers tell us they're surprised. They expected the house to feel more closed in and it doesn't.

There's also a bonus they didn't expect: the screens block up to 66% of UV rays, which keeps rooms cooler in summer and stops furniture from fading near the windows.

The security is invisible. The benefits show up every day.

https://suresecured.com/products/fixed-security-screen-windows`],

    [11, 7,
    `You've made this place home`,
    `Hi {first_name},

There's a specific kind of work that goes into making a house feel like home. It's not just the furniture or the renovation. It's years of small choices, routines, the way light falls in a certain room at a certain time of day.

Window security is usually the last thing homeowners get around to, after everything else is in place.

It doesn't have to be last.

https://suresecured.com/products/fixed-security-screen-windows`],

    [12, 7,
    `The fire escape screen, since this comes up a lot`,
    `Hi {first_name},

The most common hesitation with window screens is: what if we need to get out?

Our fire escape security screen windows have a quick-release that opens from the inside in a few seconds. No tools, straightforward enough that a child can do it. The screen functions as a full emergency exit.

So the window is secured against entry from outside and still works as a fire escape from inside.

This is especially important for bedroom windows, which need both.

You don't have to pick one.

https://suresecured.com/products/fire-escape-security-screen-windows`],

    [13, 7,
    `The real reason I do this`,
    `Hi {first_name},

I grew up in a neighborhood where break-ins weren't unusual. I remember my mother checking the window locks twice before she'd let herself fall asleep. She did it so automatically I didn't notice until I was older.

That background awareness, the constant low-level checking, is exhausting. Most people living with it don't realize they're carrying it.

Security screens don't just protect property. They return mental space. They let you sleep without going through the checklist. They let you leave the house without the returning dread.

That's what I'm actually working on when I talk to customers. The stuff about the steel is how we deliver it.

{salesperson_phone}`],

    [14, 7,
    `The material we use and why it matters`,
    `Hi {first_name},

The mesh in our screens is 316 marine-grade stainless steel. Here's what that means in practical terms.

316 contains molybdenum, an additive that makes it exceptionally resistant to corrosion, cutting force, and deformation under impact. It's the grade used in boat hardware, medical implants, and offshore equipment because it holds up in the most demanding environments.

For a window screen, this means it won't rust behind the frame where you can't see it, won't be cut with bolt cutters or standard snips, and doesn't punch through under impact.

The 12x12 weave pattern is tight enough to stop hands and tools and open enough for full airflow.

This is a specific material chosen for a specific reason.

https://suresecured.com/products/fixed-security-screen-windows`],

    [15, 10,
    `Window security, compared honestly`,
    `Hi {first_name},

Here's how our window screens compare to the other options out there.

Window bars: High security, but they create a fire exit problem, require permits in some areas, and look like something you'd see on a commercial building.

Security film: Holds glass together when broken. Not a physical barrier.

Laminated glass: Effective but costs $300-600 per window to replace existing glass, plus installation. Doesn't help with the latch vulnerability.

Standard window screens: For insects. Zero security function.

Our security screens: Marine-grade mesh over your existing windows, no glass replacement, maintains airflow and light, lifetime break-in warranty. Starting around $599 per window depending on size.

We're not the cheapest option. We're the one that actually works.

For a quote on your windows: https://suresecured.com/pages/request-a-quote`],

    [16, 10,
    `The real cost of leaving a window unprotected`,
    `Hi {first_name},

Here's what a window break-in typically costs.

Window replacement after forced entry: $200-400. Stolen property: $500-1,500 on average, often higher. Insurance deductible: $500-1,000. Repair contractor for surrounding damage: $300-800.

Then there's the time. The police report, the insurance claim, the week of contractors in your house, the way the room feels after.

Our fixed security screen windows start at about $599 per window.

One prevented break-in covers the cost of multiple windows. On financing, that math becomes straightforward from month one.

We offer financing if you'd like to spread the investment. I'd rather you have two windows on a payment plan than no windows at full price.

For a specific quote: https://suresecured.com/pages/request-a-quote`],

    [17, 10,
    `3 questions before you buy any window security product`,
    `Hi {first_name},

These three questions will help you evaluate anything, including what we sell.

Is it a barrier or a deterrent? A deterrent changes behavior. A barrier stops entry. Ask: if someone broke the glass, could they reach in and open the window? If yes, it's a deterrent, not a barrier. Ours is a barrier.

Does it have a tested emergency exit? Any window security product needs a clear way out. Ask for the specific release procedure and test it yourself before installation.

What is the mesh alloy? 316 stainless is what you want. 304 is cheaper, corrodes faster, and has lower tensile strength. If they can't name the alloy, they probably don't want you to know.

We pass all three. Ask the alternatives the same questions.

{salesperson_phone}`],

    [18, 14,
    `Our warranty, specifically`,
    `Hi {first_name},

Our lifetime break-in warranty covers this and only this, so I want to be clear: if your SureSecured window screen is defeated in an actual break-in attempt, we replace the unit. No cost, no deductible, for the life of the product.

We offer this because we haven't had a screen fail a break-in attempt. That's a confident enough position to put in writing.

What it doesn't cover: accidental damage, modifications you make after installation, normal wear unrelated to a security event. I'd rather tell you that upfront.

The warranty documentation ships with every order.

https://suresecured.com/pages/request-a-quote`],

    [19, 14,
    `Financing if the upfront cost is the issue`,
    `Hi {first_name},

Some customers have told me they wanted to do several windows at once but the upfront total felt like a stretch.

For a two-window install, financing works out to roughly $100-130 a month over 12 months, or $50-65 over 24 months. Exact figures depend on your approval and the specific product.

If you're in LA County, installation is free.

I'd rather you have the windows protected on a payment plan than leave them unprotected while you wait for the right month.

https://suresecured.com/pages/financing or call me: {salesperson_phone}`],

    [20, 14,
    `Last one from me`,
    `Hi {first_name},

Last email, I promise.

If the timing wasn't right, that's okay. Hold onto my number for when it is: {salesperson_phone}.

If there's something I didn't answer, call or text me directly. I'm not a call center.

The offer for anyone coming from this email: free consultation, no pressure. We'll go through your specific windows and your situation. If we're a fit, great. If not, you'll leave the call with more information than you came in with.

https://suresecured.com/pages/request-a-quote`],

  ];

  for (const [n, d, s, b] of steps) await addStep(id, n, d, s, b);
  console.log(`Window sequence: ${steps.length} steps`);
  return id;
}

// ---------------------------------------------------------------------------
// SEQUENCE 3: B2C General
// ---------------------------------------------------------------------------

async function seedGeneralSequence() {
  const id = await createSequence(
    'B2C — General Home Security',
    '20-email general sequence for unknown product interest. Covers doors and windows.',
    'B2C'
  );

  const steps = [

    [1, 0,
    `Your home's biggest security gap, {first_name}`,
    `Hi {first_name},

Thanks for your interest in SureSecured. I wanted to reach out before too much time went by.

Quick question: are you thinking about your doors, your windows, or both? It changes what I'd point you toward.

In the meantime, here's the short version. 92% of residential break-ins happen through a door or window. Not because the locks fail, but because the door or window itself is the vulnerability. A physical barrier problem, not a mechanical one.

We make marine-grade security screens for both. Same 316 stainless steel mesh, same triple-interlock frame, adapted for each application.

Browse what we have: https://suresecured.com/collections/all

Or just reply and tell me what you're working with. I'll point you to exactly what makes sense.`],

    [2, 2,
    `Where break-ins actually happen`,
    `Hi {first_name},

Law enforcement data on residential break-ins is pretty consistent.

34% happen through the front door. 23% through a first-floor window. 22% through the back door. 9% through the garage. 6% through a basement or side window.

That's 85% concentrated in four entry types, all of which a physical barrier addresses.

You don't need to secure every surface of your home. You need to address the four openings that account for almost all of them.

Our screens are designed for exactly those spots.

https://suresecured.com/collections/all`],

    [3, 2,
    `What "break-in resistant" actually means`,
    `Hi {first_name},

You've probably seen "break-in resistant" on a lot of security products. Here's the honest version of what that phrase means.

Resistant means it requires more effort than usual but can still be defeated given enough time and the right tools.

Our screens are designed to be defeat-resistant at the specific level of what a residential burglar carries and how long they're willing to spend on a single entry.

A residential burglar has basic tools, a limited time window, and no interest in drawing attention. Our mesh can't be cut with standard bolt cutters. Our frame can't be pried off quickly. The math stops working for them.

That's the specific level of resistance that matters. Not military-grade, not Hollywood. Just harder than every other door and window on your block.

https://suresecured.com/collections/all`],

    [4, 3,
    `The 8 minutes that matter`,
    `Hi {first_name},

The average home burglary takes 8 to 12 minutes start to finish.

The average police response time after an alarm triggers is 7 to 11 minutes.

They overlap almost perfectly. Most burglars are out before anyone arrives. The alarm documented the break-in. It didn't stop it.

Here's what changes the math: the intruder hits a physical barrier they can't get through quickly. They try, it doesn't work, they leave. The time-to-entry calculation stops working in their favor.

Our screens add enough forced-entry time that most attempts end in abandonment. The barrier is the result. Everything else is a notification.

https://suresecured.com/collections/all`],

    [5, 3,
    `Why they pick your house`,
    `Hi {first_name},

Research from convicted burglars shows the evaluation takes less than 60 seconds at the curb. They're looking for easy entry, no witnesses, quick exit.

The most immediate signal of easy entry is the door and window setup. Visible deadbolts get ignored. What actually changes the decision is whether a screen or physical barrier is present.

In a row of similar homes, the one with visible security screening gets passed. The ones without it become the easier target.

This is why upgrading your home's security changes the risk for your neighbors too. The threat doesn't leave the street. It moves.

https://suresecured.com/collections/all`],

    [6, 4,
    `The entry point you haven't thought about`,
    `Hi {first_name},

Front doors get the attention. Most homeowners have a deadbolt and maybe a camera.

The spots that get overlooked consistently: side doors with weaker construction, sliding glass doors with their notoriously easy-to-defeat latch mechanisms, ground-floor bedroom windows obscured by landscaping, back windows that face a fence line.

These aren't obscure entry points. They show up in police reports constantly. The obscurity is in homeowner awareness, not burglar knowledge.

We make screens for all of them.

If you want help thinking through your specific layout: {salesperson_phone}`],

    [7, 5,
    `What the house feels like after`,
    `Hi {first_name},

Something our customers tell us that we don't put in any product description.

There's a before and an after that has nothing to do with security directly.

Before: a background awareness that runs constantly. Did I lock the window? Is the side door secured? When I'm gone and the kids are home, is it actually okay?

After: that background process stops.

Not because they got naive. Because they added something real. The mental overhead goes away. One customer put it like this: "I didn't realize how much I was holding until I wasn't holding it anymore."

That's what we're actually making. The specs are how we deliver it.

https://suresecured.com/collections/all`],

    [8, 5,
    `Security decisions in a household`,
    `Hi {first_name},

Most home security decisions involve more than one person.

One partner wants to act on it. The other thinks it's probably fine. The kids have no opinion. The side window has been on the list for two years.

I see this situation a lot. What usually gets things moving is a concrete reason, something that happened nearby, a conversation with a neighbor, or just a moment where the abstract risk feels specific.

I'm not trying to create that moment for you. But if it's already there and you've been waiting to act, I'm easy to reach.

Tell me what your layout looks like and I'll tell you what I'd prioritize: {salesperson_phone}`],

    [9, 5,
    `A story from LA County`,
    `Hi {first_name},

A family in the valley had been thinking about security screens for about a year. They'd gotten a quote, talked through it a few times, and kept putting it off.

What finally moved them: their neighbor had a break-in. Daytime, side window, while the neighbor was at work.

They called us that week. We installed screens on the front door, side door, and two ground-floor windows.

Three months later someone tried the back window. The screen held. The person left.

They called to tell us. Not to celebrate. Just to say it to someone who would understand.

"If we'd waited one more month," she said. That was it.

{salesperson_phone}`],

    [10, 5,
    `What it does for your family's regular day`,
    `Hi {first_name},

Your teenager gets home before you do. Headphones on, not thinking about the side door.

Your youngest is in their room, opens a window they've opened a hundred times.

You're working from home alone and the back of the house faces a fence no one can see over.

None of these involve a worst-case scenario being likely. They involve a regular vulnerability that someone opportunistic might notice before you do.

A security screen doesn't ask anyone in your family to change their behavior. It adds a layer that doesn't depend on anyone remembering anything.

That's the quiet value of a physical barrier.

https://suresecured.com/collections/all`],

    [11, 7,
    `What you've built deserves this`,
    `Hi {first_name},

Your home is a significant investment, financial and otherwise.

Most homeowners spend years on it. The neighborhood. The renovations that finally happened. The way the place feels now compared to when you moved in.

Security screens are usually the last thing that gets done, after everything else is in place.

It's not a visible upgrade the way a kitchen is. Nobody comes over and comments on it. But the people who have them know. Every day they know. In a way that's quiet and solid.

It's the foundation the other stuff sits on.

https://suresecured.com/collections/all`],

    [12, 7,
    `Light, air, and security`,
    `Hi {first_name},

The most common concern I hear: will the screens make the house feel dark or closed in?

The honest answer is no, and here's why.

The 316 stainless steel mesh we use has a 12x12 weave pattern that's fine enough to stop entry but open enough that light and airflow come through normally. Our customers sleep with windows open that they haven't opened in years. They leave front doors open for a cross-breeze.

The screens also block up to 66% of UV radiation, which keeps rooms cooler in summer and prevents furniture near windows from fading.

You don't give up light or air to have security. You get all three.

https://suresecured.com/collections/all`],

    [13, 7,
    `The simpler version of this`,
    `Hi {first_name},

I've sent a fair amount of information about statistics and materials and how things are built.

Here's the simpler version.

Most of our customers don't buy a screen because they're scared. They buy it because they care too much about what's inside the house not to.

Same reason people put on a seatbelt before they back out of the driveway. Not fear. Just caring enough to take the concrete step.

When you're ready to take that step: {salesperson_phone} or https://suresecured.com/pages/request-a-quote`],

    [14, 7,
    `How SureSecured screens are made`,
    `Hi {first_name},

Here's exactly what you're buying.

The mesh: 316 marine-grade stainless steel woven in a 12x12 pattern. Same alloy used in marine hardware, medical equipment, and offshore platforms. Chosen because it resists corrosion, cutting, and impact deformation.

The frame: Triple-interlock aluminum frame with a patented security clamp at each interlock point. No exposed screws or fasteners. Locks at three points simultaneously, eliminating the single-failure-point problem of standard hardware.

The install: Made to fit your specific opening, not one-size-fits-all. Available in 9 standard frame colors plus custom color matching. Free installation in LA County.

The warranty: Lifetime break-in warranty. If it's defeated in an actual break-in, we replace it.

https://suresecured.com/collections/all`],

    [15, 10,
    `How we compare to the alternatives`,
    `Hi {first_name},

You've probably looked at other options. Here's an honest comparison.

Traditional iron security doors: $600-$1,200 installed. Often decorative iron over a standard door core. Mesh panels are frequently lower-grade steel. Hinges and frame screws often exposed. No break-in warranty on the barrier.

Window bars: Effective security but create a fire hazard, look commercial, and may require permits.

Smart locks and alarm systems: Reactive, not preventive. They notify after entry happens.

SureSecured: Physical barrier before entry. Marine-grade mesh. Triple-interlock frame. Lifetime break-in warranty. Maintains airflow and light. Free shipping nationwide, free installation in LA County.

We're not trying to replace your alarm system. We're the layer before it ever needs to trigger.

https://suresecured.com/pages/request-a-quote`],

    [16, 10,
    `Numbers worth having`,
    `Hi {first_name},

Average home burglary loss: $2,800 (FBI data). That doesn't include the $500-$1,500 to repair a forced entry point or the insurance deductible.

92% of break-ins come through doors and windows.

Our screens start at $1,899 for a door and around $599 for a window (varies by size).

One prevented break-in covers the cost of a door screen. A couple of windows together still come in below the average loss from a single incident.

Financing is available: roughly $158 a month over 12 months for a door, or $79 a month over 24 months.

One call gets you an exact quote: {salesperson_phone}`],

    [17, 10,
    `A buyer's guide, regardless of who you buy from`,
    `Hi {first_name},

Whether you buy from us or someone else, here's what's worth knowing before you commit to any security screen product.

For doors: What grade is the mesh steel? (316 is the standard.) How many points does the frame interlock? Are the frame fasteners concealed? What specifically does the warranty cover in a break-in?

For windows: Is there a tested emergency exit mechanism? Does the mesh block airflow significantly? What's the UV blocking percentage? Can it retrofit to your existing window?

For both: Who manufactures it and where? What happens if it's defeated in an actual break-in?

We answer all of these directly. Ask the same questions to any competitor.

{salesperson_phone}`],

    [18, 14,
    `Our guarantee, specifically`,
    `Hi {first_name},

Our lifetime break-in warranty covers one thing specifically: if your SureSecured screen is defeated during an actual break-in attempt, we replace it at no cost, for the life of the product.

No deductible. No inspection fee. No complicated claim process.

It doesn't cover accidental damage, modifications after installation, or wear unrelated to a security event. I want to be clear about that.

We offer this warranty because we have not had a screen fail a break-in attempt. It's confidence in writing, not a hedge.

The documentation ships with every order.

https://suresecured.com/pages/request-a-quote`],

    [19, 14,
    `If the cost has been the sticking point`,
    `Hi {first_name},

If what's been holding this back is the upfront cost, I want to make sure you know what's available.

We offer financing over 12, 24, or 36 months. For a typical door and two windows together, that's roughly $240-280 a month over 12 months, or $120-140 over 24 months. Exact amounts depend on your approval and specific products.

If you're in LA County, installation is free.

I'd rather you have the protection on a payment plan than not have it at all. That's not a sales line. It's how I think about this.

https://suresecured.com/pages/financing or call me: {salesperson_phone}`],

    [20, 14,
    `Last email from me`,
    `Hi {first_name},

This is the last one. I'm not going to keep showing up in your inbox after this.

If the timing wasn't right, that's fine. My number is {salesperson_phone}. When it makes sense for you, I'm here.

If there's a specific question I didn't get to, call or text me directly. Not a call center. Me.

The offer for anyone coming from this email: free consultation, no pressure, no pitch. We'll talk through your situation and what actually makes sense. If we're a fit, great. If not, you'll have more information than you started with.

https://suresecured.com/pages/request-a-quote`],

  ];

  for (const [n, d, s, b] of steps) await addStep(id, n, d, s, b);
  console.log(`General sequence: ${steps.length} steps`);
  return id;
}

// ---------------------------------------------------------------------------
// SEQUENCE 4: B2B Dealer
// ---------------------------------------------------------------------------

async function seedDealerSequence() {
  const id = await createSequence(
    'B2B — Become a Dealer',
    '12-email dealer sequence. Opportunity -> Proof -> Partnership -> Close over ~60 days.',
    'B2B'
  );

  const steps = [

    [1, 0,
    `A revenue line your customers are already asking about`,
    `Hi {first_name},

If you're in home improvement, renovation, or installation work, your customers have probably already asked you about security, even if they didn't use that word.

"What do you recommend for the sliding door?" "Is there something more secure than what I have?" "My neighbor just put something in, do you know who does that?"

Those are referral conversations walking out your door. SureSecured dealers capture them.

We make marine-grade security screen doors and windows, the professional-grade product that discerning homeowners want and that most competitors can't offer.

Dealer margins are meaningful. Lead times are competitive. Our team handles what you don't want to manage.

https://suresecured.com/pages/become-a-dealer`],

    [2, 2,
    `What the dealer program actually looks like`,
    `Hi {first_name},

Specifics are more useful than a pitch, so here's what the program is.

Dealer pricing with margins worth building on. I'll share exact figures on a call, they depend on volume and agreement.

Product training: We certify your team on installation. It's not complicated. Most experienced installers are comfortable with the product within a day.

Lead routing: We send qualified local leads to active dealers in their territory. You're not just getting a product, you're getting demand.

No large inventory requirement: Order per project at dealer pricing. No stocking risk.

Licenses on file: B General 758100, B General 290903, C10 Electrical 947783. We operate compliantly and expect the same from our dealers.

If this fits how you work, let's get on a call: {salesperson_phone}`],

    [3, 3,
    `The market for this product right now`,
    `Hi {first_name},

Home security spending in the US has grown consistently for a decade. The physical barrier segment, screens, reinforced entries, window protection, has grown with it as more consumers become skeptical of alarm-only solutions.

The customers who are buying this aren't budget shoppers. They've made a considered decision that their home deserves something real. They hire qualified professionals rather than the lowest bidder.

SureSecured is positioned as the premium product in this category. Our dealers compete on quality, not price. That's a conversation qualified professionals are set up to win.

This is a revenue line that fits into what you already do.

https://suresecured.com/pages/become-a-dealer`],

    [4, 3,
    `What your first project looks like`,
    `Hi {first_name},

Here's how a typical dealer project works from first contact to done.

Customer inquiry comes in, from you, from us, or from a referral. You or your team does the site assessment, measurements, entry point evaluation. You order through the dealer portal at dealer pricing. Product ships to the job site within our standard lead time. Your team installs, we provide full technical support if you need it. Customer pays your invoice at your retail price. Margin stays with you.

The whole cycle fits inside your existing workflow. We're not asking you to build a new business. We're giving you a product line that makes your current one more complete.

Let's talk about your volume and what this could add: {salesperson_phone}`],

    [5, 4,
    `A dealer in the valley, in their own words`,
    `Hi {first_name},

One of our dealers in the San Fernando Valley started adding SureSecured products to their renovation packages about 18 months ago.

Their observation: "The customers who asked about security were always my best customers. They care about quality, they're not shopping on price, and they tell their neighbors."

The security screen conversation became a natural part of their consultation, not a separate pitch, just an additional layer most homeowners don't know exists.

Referrals from their security screen customers have been their highest conversion rate of any referral source they track.

If you want to talk to that dealer directly, I can set it up: {salesperson_phone}`],

    [6, 5,
    `The LA County installation opportunity specifically`,
    `Hi {first_name},

Something specific about LA County that's worth knowing.

We offer free installation to homeowners in LA County, but we fulfill it through our dealer network, not a direct crew. Local certified dealers get access to a consistent stream of installation jobs we generate and need professionals to execute.

This is inbound work. We've done the marketing. The customer has already committed. You provide the installation.

If you're a licensed contractor operating in LA County, the specifics are worth understanding. Certified dealers in the coverage area receive project requests from our team. You quote based on standard installation rates. We facilitate the handoff.

{salesperson_phone}`],

    [7, 5,
    `What carrying SureSecured does for your positioning`,
    `Hi {first_name},

In competitive markets the question every contractor faces is: why should a homeowner choose you over the next person?

One answer is price. That's a race to the bottom.

Another answer is capability, meaning you offer something the competition doesn't.

SureSecured isn't available through most channels. If you're a certified dealer, you have something concrete to offer that the next contractor doesn't have. Marine-grade security screens with a lifetime break-in warranty aren't easy to source otherwise.

Premium customers, the ones who care about quality and plan ahead, respond to differentiation. Adding SureSecured is one of the most direct ways to move from competing on price to competing on value.

https://suresecured.com/pages/become-a-dealer`],

    [8, 7,
    `What certification actually involves`,
    `Hi {first_name},

Here's what it takes to become a certified SureSecured dealer.

A valid contractor's license is required. We operate under B General and C10 Electrical licenses and expect the same from our dealers.

Product training covers installation procedure, measurement standards, and customer consultation. Most experienced installers finish in a day.

No minimum order to start. Begin with your first project at dealer pricing. Volume tiers open up as you build history with us.

We don't oversaturate territories. Active dealers in a given area get preferential lead routing.

The barrier to entry is low on purpose. The benefit grows with volume.

To find out if your area is open: {salesperson_phone}`],

    [9, 7,
    `The objections I hear most, and the straight answers`,
    `Hi {first_name},

The most common reasons contractors don't move forward, and the honest responses.

"I don't want to stock inventory." You don't. Order per project at dealer pricing.

"Installation seems like extra work." It adds 2 to 4 hours to a typical project. We certify your team and provide full technical support.

"My customers don't ask for this." They do, they just phrase it differently. "Is there something more secure?" "What did my neighbor put in?" Those are the conversations.

"I don't know the market." We do. Active dealers in open territories get qualified leads from our marketing.

Which of these is actually the sticking point? I'd like to address it directly: {salesperson_phone}`],

    [10, 7,
    `What the numbers look like for a mid-volume dealer`,
    `Hi {first_name},

A rough picture of the economics at mid-volume, without overpromising.

A dealer doing 3 to 4 SureSecured installs per month in LA County:

Average job is one door and two windows. Retail revenue per job runs $3,500 to $4,500 depending on product mix. Installation labor is 4 to 6 hours at your standard rate. Dealer cost varies by volume tier, which I'll share on a call.

Monthly revenue from SureSecured at this volume: $10,500 to $18,000. Margin contribution is meaningful, again exact figures on a call.

This is recurring revenue. Security screen customers refer their neighbors. Security conversations become renovation conversations.

If you want exact dealer pricing: {salesperson_phone}`],

    [11, 10,
    `What we're committing to as your partner`,
    `Hi {first_name},

When we bring on a dealer, here's what we're committing to.

Dealer pricing with margin worth building on. Product certification training. Full technical support from people who know the product, not a call center script. Lead routing from our marketing in your territory. Co-marketing support for dealers who want it. Lifetime phone support you can pass along to your customers.

What we need from you: licensed and insured operation, quality installs that reflect well on both of us, and communication when something comes up. We solve problems together.

We're not a faceless supplier. The success of our dealer network is how we grow, so we have a real stake in seeing you succeed.

{salesperson_phone}`],

    [12, 10,
    `Closing the loop, {first_name}`,
    `Hi {first_name},

I've shared what the program looks like, what the market is, and what the partnership involves.

If it makes sense for your business, the next step is a 20-minute call. We'll talk through your volume, your territory, and whether we're a fit. If we are, I'll send you dealer pricing and certification details the same day.

If the timing isn't right, that's fine. This market isn't going anywhere, and neither are we.

To schedule the call: {salesperson_phone}

Dealer inquiry form: https://suresecured.com/pages/become-a-dealer

Thanks for the time you've given this.`],

  ];

  for (const [n, d, s, b] of steps) await addStep(id, n, d, s, b);
  console.log(`Dealer sequence: ${steps.length} steps`);
  return id;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('Initializing database...');
  await initDb();
  console.log('\nSeeding sequences...\n');

  await seedDoorSequence();
  await seedWindowSequence();
  await seedGeneralSequence();
  await seedDealerSequence();

  console.log('\nDone. Summary:\n');
  const { rows } = await pool.query(
    `SELECT s.name, s.audience_type, COUNT(ss.id) AS steps
     FROM sequences s
     LEFT JOIN sequence_steps ss ON ss.sequence_id = s.id
     GROUP BY s.id, s.name, s.audience_type ORDER BY s.id`
  );
  rows.forEach(r => console.log(`  ${r.name} (${r.audience_type}) - ${r.steps} steps`));
  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });

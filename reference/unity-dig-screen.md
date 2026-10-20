# 05. Digging

**Purpose**: The game's core action. Spend Crew to mine minerals.

> 📄 **Page definition received (2026-09-21, fourth version)** — Digging Telemetry mockup. Consistency review in **§Z**.
> **Of the four pages received so far, this page best matches the code** — Seam names, cost per dig, remaining-digs
> formula, and 60/20/20 probabilities all match code constants (§Z2.1).

**Entry**: My Mine on the board · `/my-mine?screen=dig` · Bottom tab `Digging`
**Exit**: Materials (inspect mined items) · Forge ([07](./07-works.md)) · Rankings

✅ **Destination immediately after digging — Do not navigate elsewhere. Stay on this screen** (§9-13).
Repeated mining is the core loop. Show rewards through feedback on the screen (`fx/Payoff`); users choose navigation
using the bottom tabs. The proposal in §Z2.11 to “let users choose in a modal” is invalidated by `V14` (no modal).

---

## Wireframe

```
┌──────────────────────────────────────────────┐
│ [◆]     [Crew 42] [Credits 1,340] [Bell] [≡] │
├──────────────────────────────────────────────┤
│  Pick a seam                                 │
│  ( Silicon )  ( Lithium )  ( Rare earth )     │  Seam selection
├──────────────────────────────────────────────┤
│                                              │
│                                              │
│              ┌───────────┐                   │
│              │           │                   │
│              │  The face │                   │  ← Tap the center
│              │    ◆      │                   │     One dig = -3 Crew (COST)
│              │           │                   │
│              └───────────┘                   │
│                                              │
│              [ Dig what is left ]            │  Dig all remaining at once
│                                              │
├──────────────────────────────────────────────┤
│  Dug today  7 / 20      Avg a dig  1.4        │  Today's status (CAP)
│  Cart runs left 2       Put-backs left 20     │
├──────────────────────────────────────────────┤
│  The cart                                    │
│  ┌────┬────┬────┬────┐                        │  Items mined this session
│  │ ◆C │ ◆B │ ?  │ ◆C │   [ Put back ]        │
│  └────┴────┴────┴────┘                        │
│                          [ Leave a record ]  │  On-chain record (cart runs)
└──────────────────────────────────────────────┘
```

---

## Area definitions

| Area | Contents | Rule |
|---|---|---|
| Seam selection | Silicon · Lithium · Rare earth | Users select a seam; the output has a different name (`RAW`) |
| the face | **Tap target.** Center of the screen | One dig = `COST` (3) Crew |
| Remaining digs | Consecutive digs up to the currently available count | The button states that count explicitly |
| Today's status | Digs today / cap, average, remaining runs | `CAP` (20), `LIMITS` |
| the cart | Items mined in this session | Temporary until recorded on-chain |

🔴 **Seam names and output names intentionally differ.** Selecting Silicon produces Silica.
Do not combine them under the same word.

---

## Core features

1. **Digging** — Tap the center. Consume `COST` (3) Crew; randomly obtain a mineral or nothing.
2. **Dig what is left** — Execute all currently available digs at once. Available count:
   `digs(energy, minedToday, cap)` = `min(⌊Crew/3⌋, cap − digs today)`.
3. **Put back** — Return items loaded in the cart, up to `SAFETY` (20).
4. **Leave a record** — Record the cart on-chain. Up to `LIMITS.cart.runs` (2) times per day.

🔴 **Use different terms for actions that write a record and actions that do not.** Filling the cart means
“loading the hold”; leaving a record means “haul.”

---

## States

| State | What changes | Why distinguish it? |
|---|---|---|
| Capacity available | Unchanged | |
| Insufficient Crew | Digging unavailable + **a path to quests** | Must not be a dead end |
| Daily cap reached | Digging unavailable + time until the next shift | A **different reason** from insufficient Crew |
| Runs exhausted | Recording unavailable | Digging is possible, but recording is not |
| Empty cart | “Nothing here yet” | |

🔴 **Even when the value is zero, different reasons need different wording.** “No Crew” and “All digs used today”
require different actions (go to quests / return tomorrow). `DIG_STATES` anchors these four states.

---

## Data sources

| Value | Source |
|---|---|
| Cost per dig | `COST = 3` (`rules/economy.ts`) |
| Daily cap | `CAP = 20`; Ventures can increase that day's cap |
| Available digs | `digs(energy, minedToday, cap)` |
| Put-back limit | `SAFETY = 20` |
| Run count | `LIMITS.cart` (`runs: 2`, `batch: 100`) |
| Seam and output names | `ORES`, `RAW` (`glossary/names.ts`) |
| Records | Relay `mymine_record` → `relay_sends` |

---

## Differences from the current implementation

✅ Implemented — Seam selection, the face, digging remaining amounts, cart, put-back, today's status, and on-chain records.

⚠️ Runtime verification needed — Whether “tap the center of the screen” actually has that position and size in the current UI.
Could not verify locally because a wallet connection was required.

---

## Handoff to design

- ✅ **Size and position of the face** — Finalized by `V25`. Maximum `52dvh`; strike button within the bottom third of the screen.
  Do not add left/right arrows or swipes (an accidental strike costs 3 Crew, and the first strike fixes the seam for that day).
  `design-decisions.test.ts` monitors the maximum.
- ✅ **Feedback for one dig** — Finalized by `V14`. **No modal.** Use inline presentation and an added cart row;
  results come from the **result reveal** in `fx/Payoff` — It covers the screen, ignores taps, and dismisses itself.
- Cart-filling presentation.
- Countdown until the next shift when the cap is reached.
- Every presentation effect has a `prefers-reduced-motion` opt-out path.


---

# Z. Fourth page definition — Digging Telemetry

## Z1. Wireframe

```
┌──────────────────────────────────────────────┐
│ ●0x7F...3B9          [⚡ 142]  [◆ 3,450]      │
├──────────────────────────────────────────────┤
│ ●                                 TARGET 1/3 │
│ [ Silicon ][ Lithium ][ Rare Earth ]         │  Seam selection tabs
├──────────────────────────────────────────────┤
│ YIELD ALLOCATION        TARGET: 60% SILICON   │
│ ▓▓▓▓▓▓▓▓▓▓▓▓░░░░▒▒▒▒                         │  60 / 20 / 20 stacked bar
│ [Silicon 60%][Lithium 20%][Rare Earth 20%]     │
├──────────────────────────────────────────────┤
│        ( TAP ORE TO DIG · -3 CREW )           │
│                                              │
│      ‹      ╭─────────────╮      ›            │  Left/right arrows + swipe
│             │   ╱◆╲      │                   │
│             │  ╱   ╲     │                   │  Crystal SVG (three seam variants)
│             │ ╲  ◆  ╱    │                   │  Rotating orbital ring
│             │  ╲___╱     │                   │
│             ╰─────────────╯                  │
│              ▬  ·  ·                         │  Pagination
│                                              │
│   -3 CREW per strike                         │
│   Available: 142 CREW (47 digs remaining)     │
├──────────────────────────────────────────────┤
│ CORE RESONANCE                        84.2%   │
│ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░                         │
│ CALIBRATED (STABLE)      SYNC FREQ 14.8 GHZ    │
├──────────────────────────────────────────────┤
│ SUCCESS RATE │ TODAY MINED │ RARE DROP        │
│     68%      │   14,280    │   12.4%          │
│    +2.4%     │  CR TOKENS  │  T4 SPECIMEN      │
├──────────────────────────────────────────────┤
│ SUBSURFACE CHAMBER LIVE FEED       HD-CAM #04  │
│ [ Photo ]  CHAMBER STABLE · 64.1°C            │
├──────────────────────────────────────────────┤
│  Quests [Digging] Materials  Forge  Rank      │
└──────────────────────────────────────────────┘

Modal after a strike:
┌────────────────────────────┐
│ STRIKE SUCCESS         ✕   │
│ SILICON ORE EXTRACTED       │
│ 60% Priority Allocation…    │
│ ┌──────────────────────┐   │
│ │ [◆] High-Purity      │   │
│ │  +1  Quartz (Si)     │   │
│ │  T3 SEMI · +18 CR    │   │
│ │  +120 PTS           │   │
│ │  PURITY 99.8% · RES… │   │
│ └──────────────────────┘   │
│ [   View in Codex →    ]   │
│ [    Keep Digging      ]   │
└────────────────────────────┘
```

> ⚠️ **Wireframe correction (2026-09-21)** — Reading the original (`02.digging/code.html`) showed that
> **`SECTOR A-09` and `DEEP BORE 1,420M` do not appear in the mockup.** Removed them from the diagram above.
> `TARGET n/3` does appear — It indicates the selected seam's ordinal (`TARGET ${index+1}/3`).
> `A9` lists `DEEP BORE 1,420M` among “numbers to remove,” but **there is nothing to remove**.

## Z2. Consistency review

### Z2.1 ✅ Matches the code — Most accurate of the four pages

| Mockup | Code | |
|---|---|---|
| Tabs `Silicon` · `Lithium` · `Rare Earth` | `ORES = ['Silicon', 'Lithium', 'Rare earth']` | ✅ Match |
| `-3 CREW` per strike | `COST = 3` | ✅ Match |
| `142 CREW (47 digs remaining)` | `⌊142 / 3⌋ = 47` — Balance term of `digs()` | ✅ Match |
| Allocation **60 / 20 / 20** | `VEIN_HIT = 0.6`, `OTHER_HIT = (1 − 0.6) / 2 = 0.2` | ✅ **Exact match** |
| Tap the center to mine | Policy 1.3: “Click or tap the center of the screen” | ✅ Match |
| Crystals drawn using **inline SVG** | Diagrams use SVG/CSS only (design system) | ✅ Match |
| Output names use real mineral terminology — `High-Purity Quartz (Si)`, `Spodumene Crystalline Matrix`, `Obsidian Heavy Bastnäsite` | Real industrial terminology in `RAW`, `PROD` | ✅ **Fits RWA positioning** |

🔴 **Observe**: Unlike the fictional minerals in the second (Materials) and third (Forge) versions (`Neo Titanium`, `Quantum Crystal`, `Astral Ether`),
this page uses real mineral terminology. **Two naming systems coexist within one product.**
This makes the need to decide which system is authoritative clear.

### Z2.2 🔴 The daily cap (CAP) is absent from the screen

Mockup: `142 CREW (47 digs remaining)` — Considers **only the Crew balance**.

Code: `digs(energy, minedToday, cap) = min(⌊energy / COST⌋, cap − minedToday)`,
`CAP = 20`. Even with 142 Crew, **only 20 digs are available per day**.

🔴 Promising 47 digs and stopping at 20 **creates a dead end**. This is why this document's States section
requires different wording for “Insufficient Crew” and “Daily cap reached.”

✅ **Decided (2026-09-21)** — `B2`. Display remaining digs as **`min(balance allowance, cap allowance)`**.
When the cap is reached, say “Today's digs are used up · N hours until the next shift,” using **different wording**
from “Insufficient Crew.” These states require different actions (go to quests / return tomorrow).

### Z2.3 🔴 Cart and on-chain records are absent

Code flow: Digging → **Added to cart** → `Put back` (up to `SAFETY` 20) → **Leave a record**
(`LIMITS.cart.runs`, twice daily) → Confirmed on-chain through relay `mymine_record`.

The mockup has no cart, put-back action, or record button. It looks as though each strike immediately reduces the balance
and finalizes the result.

🔴 The rule **“Use different terms for actions that write records and actions that do not”** is central to this screen,
but the mockup removes that distinction entirely.

✅ **Decided (2026-09-21)** — `B8` · `H3`. **Reuse the already implemented cart and recording flow.**
Do not redefine it. 🔴 Recording every strike immediately would create 20 on-chain transactions daily, multiplying gas,
relay reservations, and sponsorship budgets by 10.

### Z2.4 🔴 `Success Rate 68%` conflicts with 60/20/20

Allocation is 60 + 20 + 20 = **100%**, but a separate success rate is 68%. The screen does not explain the remaining 32%.

The mockup script **always awards something** (`rollExtractedMineral` always returns one mineral).
**In this respect, the mockup matches the code.** The inconsistent elements were the `Success Rate 68%` label
and policy 1.3's “may obtain nothing” — The policy was corrected.

✅ **Decided (2026-09-21)** — **There are no empty results.** 60/20/20 is simply seam allocation; every dig
produces something (`B3` · [00-plan.md §9-A-1](../00-plan.md)).
🔴 Therefore, **do not use** the mockup's `Success Rate 68%`. Nothing in the code corresponds to the remaining 32%.
The screen only says “What did this strike produce?” rather than success/failure.

### Z2.5 🔴 Digging awards CR — Changes the economic loop

Mockup: `+18 CR` per strike, with `Today Mined 14,280 CR TOKENS` below.
The original script actually runs this way — `todayMined += 18`, subtracts 3 from `crew`, and uses
`digsRemaining = Math.floor(crew / 3)`. 🔴 **The cap (`CAP`) appears nowhere** (§Z2.2).

Code: Digging **only consumes Crew and produces raw ore**; it does not award credits. Credits come only from **selling**
(`PAY = PAY_PER_UNIT(45) × FUSE^grade`, distributed over `ASSET_DAYS` (15) days).

🔴 If digging awards CR directly, **selling loses its purpose**. The existing balance rule,
“Purchase prices must exceed registration revenue,” would also need recalculation.

✅ **Decided (2026-09-21)** — `B1` · `H3`. **Raw ore only.** Credits come **only from selling (Register)**.
🔴 Awarding credits for digging weakens selling's purpose and breaks the “purchase price = total sale proceeds × 3” balance.

### Z2.6 ⚠️ `+120 PTS` is awarded at digging time

PTS represents Materials valuation, but the code calculates score with `goodsWeightOf` — It counts **only unconsumed goods**.
Raw ore scores zero. Awarding PTS immediately after digging would conflict with the definition of the Materials total (second mockup: `12,850 PTS`).

### Z2.6-1 ✅ Do not use `CR` or `PTS` labels

The code's currency symbol is `C` (`UNIT`), and the score label is `Score` (`RANK_NAMES.score`).
The `UNIT` invariant: “Two symbols for the same unit will be read as two currencies. This game has one currency.”
`CR` and `PTS` appear in this document **where the mockup is quoted**; do not use them on screen.
→ [00-plan.md §3.1](../00-plan.md)

### Z2.7 ⚠️ Yet another grade system

The modal uses `T3 SEMI`, `T4 RARE`, and `T4 SPECIMEN`. Code uses **six grades: C, B, A, S, SS, SSS**,
and digging determines the grade (`oddsWholeDig(grade, …)`).

Mockups received so far use three grade schemes — Second: `COMMON~LEGENDARY` (five levels); third: `Common/Rare/Epic`;
fourth: `T3/T4`. **Choose one system.**

### Z2.8 ⚠️ Ventures' cap and grade increases are invisible

`rules/jv.ts` specifies that partner count increases **that day's grade lift (`LIFT_EVER`) and digging cap**.
This screen should show those effects, but no indication is present.

### Z2.9 ⚠️ Many unsupported numbers

`DEEP BORE 1,420M` · `Core Resonance 84.2%` · `SYNC FREQ 14.8 GHZ` · `CHAMBER STABLE 64.1°C` ·
`PURITY 99.8%` · `RES 21.4 GHZ` · `Rare Drop 12.4%` · `Success Rate +2.4%`.

The system rule is “Publish only verifiable numbers.” In particular, **Core Resonance increases by +0.4% per strike
but has no definition** — There is no answer if a user asks what it means.

✅ **Decided (2026-09-21)** — `A9`. **Keep only meaningful values; remove the rest.**
Candidates to retain are purity (another expression of grade) and rarity probability (actual `odds.ts` values);
**remove resonance, frequency, temperature, and depth**. The digging notes in `02 §5` reach the same conclusion —
The telemetry block is **deleted, not deferred**.

### Z2.10 ⚠️ Colors fall outside the tokens

Seam colors directly use `cyan-400` and `purple-400` (default Tailwind colors). Design system tokens use
copper, gold, and steppe families; **color literals are prohibited**.

✅ **Decided (§9-5, owner decision 2026-09-21) · Implemented (`3eef09f`)** —
**cyan · violet · copper.** These are `--seam-0`, `--seam-1`, and `--seam-2` (= `--copper`) in `styles/tokens.css`.
`ORE_INK` in `shade.ts` and `paint.ts` read them **by token name**, so seam tabs, cards, and rock faces cannot diverge.

🔴 **The first two values fall outside the system palette.** This is the app's only use of non-system colors,
recorded as a deviation in `design-system/ADOPTION.md` §1-3. The `cyan-400` and `purple-400` issue identified in §Z2.10
was thus accepted by **replacing literals with tokens** — The mockup's color choice was correct; only the notation was wrong.

### Z2.11 📌 Other items

- **Live Feed** → ✅ **Remove** (`H6 F7`). External images may also be blocked by CSP `img-src` (`A8`).
- **Modal** → ✅ **Do not show** (`V14`). The result reveal in `fx/Payoff` presents results without requiring dismissal.
  ⚠️ The original condition is `strikeCount % 2 === 1 || strikeCount === 1` — It fires **on odd strikes (1, 3, 5…),
  rather than every second strike**. This corrects the initial “every second strike” wording. Either way, 20 daily digs produce 10 modals.
  Users tap repeatedly up to the daily cap; requiring dismissal each time interrupts repeated strikes,
  and each strike encounters the “one overlay at a time” rule (`OverlayCoordinator`).
- **Many animations** — Floating, pulsing, orbital rotation, strike impact, fragments, and floating text.
  All need a `prefers-reduced-motion` opt-out path, and SSR must render the final state.
- **`View in Codex`** leads to Materials. The mockup effectively answered Q7 (destination after digging)
  with “Let users choose in a modal.”
  🔴 **That answer was invalidated by `V14` (no modal).**
  ✅ **§9-13 closed it — Do not navigate elsewhere. Stay on the digging screen.** Repeated mining is the core loop;
  moving screens after every dig prevents users from completing 20 daily digs. Show rewards through feedback on the screen,
  and let users choose navigation with the bottom tabs.

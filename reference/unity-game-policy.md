# Gamification policy — From wallet connection to rankings

Status: Policy finalized (2026-09-21 directive); implementation comparison based on static code inspection
Written: 2026-09-21
Related documents: [mpc-unity-development-plan.md](./00-plan.md) — Differences in this document are handled there as W3–W8 tasks · [dau-growth-plan.md](./04-dau-diagnosis.md) · [my-mine-setup.md](../my-mine-setup.md) · [quest-expansion-plan.md](../quest-expansion-plan.md) · [mymine-ranks.md](../mymine-ranks.md)

---

## 0. Role of this document

**This document is the authoritative policy.** Read §1 first when assessing My Mine and quest screens and rules.
§2 records differences between this policy and the current code. Remove differences from §2 once resolved.

§1 directly converts the directive into policy statements; §2 onward records the results of reading and comparing the code.
These sections serve different purposes and must remain distinct.

---

## 1. Policy

### 1.1 Wallet connection

The user connects a wallet. This is the account, and all subsequent records belong to this wallet.

### 1.2 Quests — Obtaining Crew (digging points)

- Users **must obtain Crew before they can perform the next action, digging.** Quests provide that Crew.
- Task types: simple viewing, opening links, daily quests.
- 🔴 **The reward asset is Crew.** Previously, users received Energy (SBT) and had to exchange it for Crew;
  **change this to receiving Crew directly in one step.** Remove the exchange step from the user journey.

### 1.3 Digging

- Clicking or tapping the center of the screen performs a dig.
- **Each execution consumes 3 Crew.**
- **Every dig must produce a mineral.** What it produces is random — The seam and grade are drawn.

> 🔴 **Terminology correction (2026-09-21)**: The original wording was “You may obtain something or **may obtain nothing**.”
> There is no empty result in the code — `state/face.ts` says “Every dig produces,” and `rules/derive.test.ts`
> enforces this. Empty results existed and were removed; the code records why: an empty result was interpreted as
> **a tap that failed to register**, making cart rows and record counts differ from the number of digs.
> Background: [00-plan.md §9-A-1](./00-plan.md) · [01 §B3](./01-decisions-function.md).

### 1.4 Materials — Catalog

Users who spend Crew digging want to see what they own. Materials is that screen.

- **Display the entire map.** Show all mineral types in greater detail.
- **Distinguish owned and unowned items very subtly.** Do not hide unowned items.
- Clearly display actual mineral names. Enlarge the view compared with the current version so users can inspect minerals in detail.
- Each mineral has a score. **Users can see the total score of everything they own at the top.**
- Place a **button to rankings** beside it. Users can open rankings to see other people's total scores.

### 1.5 Refine

- Provide an option to **select** which owned items to refine.
- Represent selected items with a **filtered layout that groups them at the top**.
- Pressing Refine shows **one animation**, followed by a reaction indicating “Refining complete.”
- Depending on the result, an item improves or is ground down (retain the current design).
- Update the owned mineral list to reflect the refining result.

### 1.6 Market — Selling (Register)

> 🔴 **Terminology correction (2026-09-21)**: The original said “staking”; the body now uses the finalized term. **Specifically, this is selling (Register)** — Users sell minerals for credits rather than depositing them.
> Use the English label from the code's `MARKET_NAMES.stallRegister` (`Register ore`).
>
> 🔴 **The original final line, “You can cancel it,” was not adopted.** Early cancellation is
> **impossible**, and no cancellation feature will be built (`01 §B6` · `§H3`). The code provides the basis — The `ASSAY_NAMES`
> invariant says, “Marking can be reversed by us and does not touch the chain. Registering is a record and
> never leaves the ledger.” The only reversible action is **`Unmark` (`unmarkOre`) before signing**.
>
> ⚠️ **The original “Set a period for each mineral” was also not adopted.** Currently,
> `ASSET_DAYS = 15` is **fixed**, and [00-plan.md §9-11](./00-plan.md)
> closed the question of selectable periods and multipliers with a decision **not to introduce them**.


- **Sell (Register)** owned resources in the market. Receive **credits** corresponding to the amount sold.
- Each mineral has a credit value, so **position that value appropriately**.
- Make the concept “This item is being sold” clear to users through the design.
- Show **how much time has elapsed for currently registered items**.
- Users can claim points daily or let them accumulate and collect them all at the end.
  🔴 **There is no cancellation** — Registered items never leave the ledger (`ASSAY_NAMES` invariant).

### 1.7 Market — Buying

- Buy minerals with earned credits.
- Show **available credits** on the purchase screen; mineral prices must reflect the preset values exactly.
- Select the desired quantity and buy.
- 🔴 **Validation restricts purchases to the available credit balance.**
- Product presentation must clearly show what is available and its price.

### 1.8 Rankings

- Rankings are determined by the total points of owned minerals.
- Display first, second, and third place at the top as in the current UI, and allow viewing their minerals and assets.
- Users can see their own rank.
- **Two top tabs** — ① Total minerals owned to date ② Actions the user has performed.
- Most of the screen is already well implemented; retain it largely as is.

---

## 2. Implementation comparison

Verification method: Static code inspection (files, constants, components). These are not results from opening and interacting with the screens —
§4 separately lists items requiring runtime verification.

| # | Policy | What exists in code | Status |
|---|---|---|---|
| 1.1 | Wallet connection | Five-step join flow (`JoinFlow.tsx`) | ✅ Present |
| 1.2 | Quests award Crew directly | `rewardAsset: 'crew'` (`quest-rules.ts`), relay kind `crew_quest` (`relay-rules.ts`) | ⚠️ Path exists but coexists with the Energy path |
| 1.3 | One dig = 3 Crew, random | `COST = 3`, `CAP = 20` (`rules/economy.ts`), `Dig.tsx` | ✅ Present |
| 1.4 | Catalog, total score, rankings button | `Collection.tsx`, `CollectionHub.tsx` | ✅ **Present** — Total score and rankings navigation (W4 `d7f3424`), unowned item names exposed (W5 `b8fb7c1`) |
| 1.5 | Refining selection and animation | `Refine.tsx` (fold within Materials) | ⚠️ Selection, filtering, and animation need verification |
| 1.6 | Selling (Register), elapsed time | `Market.tsx`, `ASSET_DAYS = 15`, `payingDaysLeft` | ✅ Present. **Cancellation is outside scope** — No code path exists and none will be built |
| 1.7 | Credit purchases and validation | `buyPrice` (`rules/economy.ts`), `Market.tsx` | ✅ Present |
| 1.8 | Rankings, two top tabs | `Ranks.tsx` — Holdings board and record board | ✅ **Present** — Boards separated into tabs (W6 `f1f0f3b`) |

---

## 3. Refinements by item

### 3.1 Quests → Direct Crew rewards (policy 1.2)

**Current state**: Two reward assets coexist. `rewardAsset` accepts `'energy' | 'crew'`, and the relay supports
both `quest` and `crew_quest`. The header displays **both** `EnergyHeader` (BSC Energy) and
`PickaxeEnergyHeader` (Crew), while the connecting `EnergyConverter` requires users to bridge manually.

**Required work**
1. Switch quest definitions' `reward_asset` to Crew. **This changes database rows, not server code.**
2. Remove Energy from the header and show Crew and credits. One UI location.
3. **Retain a conversion path** for wallets that already hold Energy. Hide it from wallets with a zero balance.

🔴 **Review correction (2026-09-21) — This is not bridge automation.**

This section initially said “This is bridge automation rather than a display change, and an L3 deployment blocker.”
Reading `src/modules/quests/server/quest-claim.ts` showed that premise was wrong.

- The reward asset is determined by **`reward_asset` in the quest definition (database row)**.
- When `reward_asset = 'crew'`, rewards are **issued directly through the opBNB Crew contract** (`questContract('crew')`).
- The only prerequisite for that path is **holding a Waitlist SBT** — `readHeldSbt(wallet)`.
- 🔴 **It does not read the Energy balance.** Crew issuance bypasses Energy, so **it does not use the bridge**.

The bridge is therefore uninvolved in new rewards; there is nothing to automate.
Full evidence is recorded in [01-decisions-function.md §H2](./01-decisions-function.md) and
[00-plan.md §5](./00-plan.md).

🔴 **Do not delete Energy code.** Some wallets have already received Energy; cutting off conversion would cause them to lose issued value.
Remove it from the main display, but retain the `EnergyConverter` path. L3 remains satisfied **as long as that screen continues to show**
`delayed` / `unreadable` / `manual_review` / `source_reverted`.

⚠️ **The blocking condition is “hiding failures,” not “automation.”** Hiding conversion failures for remaining balances
would violate L3 and block deployment.

Layer: L2 (reward path changes; must work) · 🚫 Deployment blocker

### 3.2 Materials — Unowned item display (policy 1.4) ✅ Complete

> ✅ **Completed in W5** (commit `b8fb7c1` — “The catalog names every material”). Below is the decision record from that time.
> `UNKNOWN` was removed from the catalog; the rule for screens that require actions remains.

**Current state (before work)**: Names of unseen materials are hidden using `UNKNOWN = '?'`. The code comment explains:
“Users cannot be asked to choose something unnamed, so screens that require actions must name items.
Only the catalog hides them.”

**Conflict**: The policy requires “Do not hide unowned items; distinguish them very subtly.” This directly conflicts
with the current rule of hiding names in the catalog.

**Required work**: **Expose names** of unowned materials in the catalog, distinguishing them from owned items only through
subtle visual changes such as saturation or opacity. Remove `UNKNOWN` from the catalog while retaining the rule for screens requiring actions.

Layer: L4 (output integrity — What the screen says changes) · Does not block deployment

### 3.3 Materials — Total score and rankings button (policy 1.4) ✅ Complete

> ✅ **Completed in W4** (commit `d7f3424`). Below is the decision record from that time.

**Current state (before work)**: No place displays the total score of owned minerals. There is also no rankings button
(`Glyph id="ranks"` in `CollectionHub.tsx` is only the progress fold's icon, not a link).

**Required work**
1. Add the total score at the top of Materials and a rankings button beside it.

🔴 **The single-source question is already answered** (confirmed 2026-09-21). Rankings use
`goodsWeightOf(state)` in `src/modules/my-mine/ranks/score.ts` — A **pure function** summing unconsumed goods
using tier weights from `RANK_LADDER`. My Mine holds its own `MineState` on the client, so Materials
**only needs to call the same function**. No server round trip or second calculation is needed. This closes Q2.

Layer: L2 (new path) · 🚫 Deployment blocker (must work)

### 3.4 Rankings — Two top tabs (policy 1.8) ✅ Complete

> ✅ **Completed in W6** (commit `f1f0f3b`). Below is the decision record from that time.
> ⚠️ The list's **format** changed afterward — It is now **the full list from first place with incremental loading**,
> rather than a window around the user (`01 §H5 D2`). The two tabs remain.

**Current state (before work)**: **Both boards already exist.** `Ranks.tsx` renders ① the holdings board (`served.held`) and
② the record board (`served.record[range]`, with day/week/all range selection) **stacked vertically**.
Only tabs are missing; both data and UI already exist.

**Required work**: Convert the two boards into top tabs. **No new data or queries are needed.**
The task is much smaller than initially described.

🔴 **What ② counts differs from DAU “actions”** (confirmed 2026-09-21). `recordStanding` awards
**one point per tap that reaches the chain** and counts only My Mine taps. DAU counts **distinct wallet-days**
across five services (quiz, quest, crew, mine, vote). They answer different questions, so **do not make them match**.
Instead, clearly label the screen “Records” to avoid confusion with DAU figures. This closes Q3.

Layer: L2 · 🚫 Deployment blocker

### 3.5 Refine and Market (policies 1.5, 1.6)

Both screens have core functionality. Differences are concentrated in **presentation and state visibility**.

- Refine: Selection → Filter selected items to the top → One refining animation → Completion reaction
- Market: Visualize selling (Register), show elapsed days, allow a single claim at the end. 🔴 **There is no cancellation**

⚠️ Animations must have a `prefers-reduced-motion` opt-out path, and SSR must render the final state
(mandatory design system rules). Implement both when adding presentation effects.

Layer: L6 (operations/usability) · Does not block deployment

---

## 4. Items requiring runtime verification

These cannot be determined by reading code alone; open the screens to verify. Update the §2 table afterward.

1. Does “click the center of the screen” for digging match the current UI's actual position and interaction (`Dig.tsx`)?
   — ⚠️ `V25` finalized position and size (`the face` capped at `52dvh`, strike button in the bottom third of the screen).
   Only actual rendering verification remains.
2. Does refining provide target selection, and do selected items gather at the top (`Refine.tsx`)?
3. ~~Does the market have a cancellation path?~~ — ⬛ **Invalid.** No cancellation will be built, and no code path exists
   (`unmarkOre` reverses **before signing**; it is not cancellation). There is nothing to verify.
4. Current size and information density of the enlarged mineral detail view in Materials.
5. Does the top rankings podium actually show “their minerals and assets”?

---

## 5. Items requiring decisions

~~**Q1 — Handling existing Energy balances.**~~ **Closed (2026-09-21)** — **Retain the manual conversion path.**
Keep `EnergyConverter`, hide it from wallets with zero balances, and show a single line, “You have Energy to convert,”
only to wallets with a balance. Do not discard it — That would erase value already issued.
Do not automate it — A signature is still required, and failure states remain visible. (§3.1 · `01 §E1`)

~~**Q2 — Single source for mineral scores.**~~ **Closed (2026-09-21)** — `goodsWeightOf` is a pure function, and the client holds `MineState`, so call it directly. (§3.3)

~~**Q3 — Definition of “actions” counted by the second rankings tab.**~~ **Closed (2026-09-21)** — `recordStanding` (one point per tap reaching the chain) already answers this; it addresses a different question from DAU, so do not align them. (§3.4)

~~**Q4 — Credit settlement on cancellation.**~~ ⬛ **Invalid (2026-09-21)** — There is no early cancellation,
so there is nothing to settle. (§1.6 terminology correction · `01 §B6`)

---

🔴 **No unresolved decisions remain in this document.** [00-plan.md §9](./00-plan.md) centrally tracks
unresolved game-rule items — Empty results (7), cost of refining failure (8),
consecutive attendance table (9), completion bonus (10), and selling periods and multipliers (11).

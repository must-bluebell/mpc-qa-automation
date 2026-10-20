## User routes and main features

This app provides waitlist, check-in, and quest features on BSC, and Crew, My Mine, and voting features on opBNB.
The following summarizes user flows implemented in the code. Verify deployment status and feature activation requirements separately.

### Main routes

| Route | Purpose |
|---|---|
| `/` | Shared entry point for landing, signup, and features after signup. `?tab=quest` opens quests and check-in, `?tab=mine` opens My Mine, `?tab=ventures` opens Ventures, and `?tab=vote` opens voting. |
| `/join`, `/home` | Compatibility routes for existing links; redirect to `/`. |
| `/quests`, `/mine`, `/vote` | Redirect to `/?tab=quest`, `/?tab=mine`, and `/?tab=vote`, respectively. |
| `/vote/[id]` | Accepts a valid proposal ID and redirects to `/?tab=vote&proposal=<id>`. |
| `/my-mine` | Review page for Preview or local development. Regular users open My Mine from the tab on `/`. |
| `/whitepaper` | Redirects to the external whitepaper URL. |
| `/privacy-policy`, `/cookie-policy`, `/security` | Privacy, cookie, and security information pages. |
| `/admin/*` | Operations console with separate administrator authentication and permissions for viewing users and activity and managing quests, quizzes, voting, and administrator accounts. |

### Signup flow

1. Connect a wallet and log in to the server using a wallet ownership verification signature (SIWE). Wallet connection and server login are separate states.
2. Complete the community step by opening the X link, connecting Telegram, and verifying group membership. X only records that the link was opened; Telegram membership verification is required when the gate is enabled.
3. Register an email address. Email verification by code (OTP) is the default and can be skipped if the signup policy allows it. Docker initializes the same database signup policy to skip OTP; operator policy changes survive restarts.
4. Issue a waitlist SBT, a nontransferable proof-of-signup token, to the registered wallet. Confirm issuance using on-chain state.

### Main features after signup

- **Quiz and check-in:** The daily quiz answer determines the bonus. Completing a separate on-chain check-in awards opBNB Crew. Users can prepare a check-in without answering the quiz, with no bonus.
- **Quests:** Meet defined requirements such as prerequisite quests, opening links, and activity to receive opBNB Crew according to approved reward definitions.
- **Legacy Energy:** Remove new issuance, conversion, and regular user UI access. Preserve historical BSC Energy and bridge records only for migration and auditing.
- **My Mine:** Issue a participation certificate separate from the waitlist SBT, then use Crew for mining, hauling, and refining. Register ore to claim credits, buy raw ore with credits, and view holdings and record rankings.
- **Ventures:** Establish invitation relationships and receive mining adjustments and Crew rewards according to the conditions.
- **Voting:** View proposals, vote, or change a vote. Eligibility uses the My Mine certificate ID, the ID upper bound fixed when the proposal was created, and current exclusion status. Weight is based on cumulative Crew at the proposal creation block and stays unchanged when a vote changes.
- **Progress and notifications:** View operation progress and results in Activity and mark notifications as read in the notification list.

### Boundaries to consider when changing flows

- Historical BSC Energy, opBNB Crew, and My Mine credits, raw ore, and goods are distinct values.
- My Mine opens only when all required opBNB contract addresses are configured; the voting tab opens only when the voting contract address is configured. The Energy bridge is not a prerequisite for new user flows.
- Depending on the feature, transactions are sent directly by the user or through a server relay. A success message on screen alone does not confirm a successful chain operation.
- Do not interpret the environment restriction on the `/my-mine` review page as a restriction on all `/my-mine/*` feature APIs.

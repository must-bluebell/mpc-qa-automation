171 method/route pairs catalogued; 154 baseline contracts; 17 need explicit environment/source contracts.
Catalog coverage is not execution coverage. Success cases without seeded fixtures are skipped.

| ID | Method | Route | Baseline | Local handler |
| --- | --- | --- | --- | --- |
| API001 | POST | `/api/auth/activity` | 401 not_signed_in | Snapshot only |
| API002 | POST | `/api/auth/logout` | 200 | Available |
| API003 | POST | `/api/auth/nonce` | 200 | Available |
| API004 | GET | `/api/auth/session` | 200 | Available |
| API005 | POST | `/api/auth/verify` | 401 nonce_missing | Available |
| API006 | POST | `/api/activities/[id]/cancel` | 401 not_signed_in | Available |
| API007 | POST | `/api/activities/[id]/dismiss` | 401 not_signed_in | Available |
| API008 | POST | `/api/activities/[id]/seen` | 401 not_signed_in | Available |
| API009 | GET | `/api/activities/[id]/status` | 401 not_signed_in | Available |
| API010 | GET | `/api/activities/history` | 401 not_signed_in | Snapshot only |
| API011 | GET | `/api/activities` | 401 not_signed_in | Available |
| API012 | PATCH | `/api/admin/admins/[id]` | 401 not_admin | Available |
| API013 | DELETE | `/api/admin/admins/[id]` | 401 not_admin | Available |
| API014 | GET | `/api/admin/admins` | 401 not_admin | Available |
| API015 | POST | `/api/admin/admins` | 401 not_admin | Available |
| API016 | GET | `/api/admin/ambassadors` | 401 not_admin | Snapshot only |
| API017 | POST | `/api/admin/ambassadors` | 401 not_admin | Snapshot only |
| API018 | POST | `/api/admin/change-password` | 401 not_admin | Available |
| API019 | POST | `/api/admin/checkin/reconcile` | 401 not_admin | Available |
| API020 | GET | `/api/admin/join-policy` | 401 not_admin | Available |
| API021 | PATCH | `/api/admin/join-policy` | 401 not_admin | Available |
| API022 | GET | `/api/admin/ledger/export` | 401 not_admin | Available |
| API023 | POST | `/api/admin/login` | 401 bad_credentials | Available |
| API024 | POST | `/api/admin/logout` | 200 | Available |
| API025 | GET | `/api/admin/page/[...path]` | 401 not_admin | Snapshot only |
| API026 | DELETE | `/api/admin/quest-hosts/[host]` | 401 not_admin | Available |
| API027 | POST | `/api/admin/quest-hosts` | 401 not_admin | Available |
| API028 | POST | `/api/admin/quest/reconcile` | 401 not_admin | Available |
| API029 | GET | `/api/admin/quests/[key]/edits` | 401 not_admin | Available |
| API030 | PATCH | `/api/admin/quests/[key]` | 401 not_admin | Available |
| API031 | POST | `/api/admin/quests/batch` | 401 not_admin | Available |
| API032 | GET | `/api/admin/quests` | 401 not_admin | Available |
| API033 | POST | `/api/admin/quests` | 401 not_admin | Available |
| API034 | POST | `/api/admin/quiz/batches` | 401 not_admin | Available |
| API035 | POST | `/api/admin/quiz/items/[id]` | 401 not_admin | Available |
| API036 | POST | `/api/admin/quiz/items/bulk` | 401 not_admin | Available |
| API037 | POST | `/api/admin/quiz/items` | 401 not_admin | Available |
| API038 | POST | `/api/admin/quiz/translations` | 401 not_admin | Available |
| API039 | GET | `/api/admin/referral-performance/export` | 401 not_admin | Snapshot only |
| API040 | PATCH | `/api/admin/roles/[id]` | 401 not_admin | Available |
| API041 | GET | `/api/admin/roles` | 401 not_admin | Available |
| API042 | POST | `/api/admin/roles` | 401 not_admin | Available |
| API043 | POST | `/api/admin/telegram/unlink` | 401 not_admin | Available |
| API044 | POST | `/api/admin/votes/lifecycle` | 401 not_admin | Available |
| API045 | POST | `/api/admin/votes` | 401 not_admin | Available |
| API046 | GET | `/api/admin/website-analytics` | 401 not_admin | Available |
| API047 | GET | `/api/ambassador/badges/[id]` | Fixture required | Snapshot only |
| API048 | GET | `/api/ambassador/metadata/[id]` | Fixture required | Snapshot only |
| API049 | GET | `/api/ambassador` | Fixture required | Snapshot only |
| API050 | POST | `/api/ambassador` | Fixture required | Snapshot only |
| API051 | GET | `/api/checkin/participation-rewards` | 401 not_signed_in | Snapshot only |
| API052 | POST | `/api/checkin/participation-rewards` | 401 not_signed_in | Snapshot only |
| API053 | GET | `/api/checkin-reminder` | 401 | Snapshot only |
| API054 | POST | `/api/checkin-reminder` | 401 | Snapshot only |
| API055 | GET | `/api/checkin-reminder/unsubscribe` | Fixture required | Snapshot only |
| API056 | POST | `/api/checkin-reminder/unsubscribe` | Fixture required | Snapshot only |
| API057 | POST | `/api/claim/permit` | 401 not_signed_in | Available |
| API058 | POST | `/api/claim/result` | 401 not_signed_in | Available |
| API059 | POST | `/api/claim/sent` | 401 not_signed_in | Available |
| API060 | GET | `/api/cron/api-latency-cleanup` | 401 | Available |
| API061 | GET | `/api/cron/audience-retention` | 401 | Available |
| API062 | GET | `/api/cron/chain-index` | 401 unauthorized | Available |
| API063 | GET | `/api/cron/checkin-reconcile` | 401 unauthorized | Available |
| API064 | GET | `/api/cron/checkin-reminders-continue` | 401 | Snapshot only |
| API065 | GET | `/api/cron/checkin-reminders` | 401 | Snapshot only |
| API066 | GET | `/api/cron/energy-reconcile` | 401 unauthorized | Available |
| API067 | GET | `/api/cron/funnel-failures` | 401 unauthorized | Available |
| API068 | GET | `/api/cron/megafuel-funding` | 401 unauthorized | Available |
| API069 | GET | `/api/cron/mymine-calendar` | 401 unauthorized | Snapshot only |
| API070 | GET | `/api/cron/mymine-ranks` | 401 unauthorized | Available |
| API071 | GET | `/api/cron/participation-rewards` | 401 unauthorized | Snapshot only |
| API072 | GET | `/api/cron/quest-reconcile` | 401 unauthorized | Available |
| API073 | GET | `/api/cron/relay-sweep` | 401 unauthorized | Available |
| API074 | GET | `/api/cron/user-inactivity` | 401 | Snapshot only |
| API075 | POST | `/api/dev/rpc/[chain]` | Fixture required | Snapshot only |
| API076 | OPTIONS | `/api/dev/rpc/[chain]` | Fixture required | Snapshot only |
| API077 | POST | `/api/dev/top-up` | 401 not_signed_in | Snapshot only |
| API078 | GET | `/dev/sign-in` | Fixture required | Snapshot only |
| API079 | POST | `/api/energy/bridge/deposit/abandon` | 401 not_signed_in | Available |
| API080 | POST | `/api/energy/bridge/deposit/prepare` | 401 not_signed_in | Available |
| API081 | POST | `/api/energy/bridge/deposit/register` | 401 not_signed_in | Available |
| API082 | GET | `/api/energy/bridge/deposit/status` | 401 not_signed_in | Available |
| API083 | POST | `/api/energy/bridge/deposit/submit` | 401 not_signed_in | Available |
| API084 | GET | `/api/energy/compensation` | 401 not_signed_in | Available |
| API085 | POST | `/api/energy/compensation` | 401 not_signed_in | Available |
| API086 | GET | `/api/energy/deposits/[transferId]` | 401 not_signed_in | Available |
| API087 | GET | `/api/energy/deposits` | 401 not_signed_in | Available |
| API088 | GET | `/api/energy/history` | 401 not_signed_in | Available |
| API089 | GET | `/api/energy/portfolio` | 401 not_signed_in | Available |
| API090 | GET | `/api/energy` | 401 not_signed_in | Available |
| API091 | POST | `/api/energy` | 401 not_signed_in | Available |
| API092 | GET | `/api/home` | 200 | Available |
| API093 | POST | `/api/join/event` | 400 bad_run_id | Available |
| API094 | GET | `/api/join/social-complete` | 401 not_signed_in | Available |
| API095 | POST | `/api/join/social-complete` | 401 not_signed_in | Available |
| API096 | GET | `/api/join/x-open` | 401 not_signed_in | Available |
| API097 | POST | `/api/join/x-open` | 401 not_signed_in | Available |
| API098 | GET | `/my-mine/access` | 401 not_signed_in | Snapshot only |
| API099 | POST | `/my-mine/attend` | 401 not_signed_in | Available |
| API100 | GET | `/my-mine/chain` | 401 not_signed_in | Available |
| API101 | GET | `/my-mine/claim` | 401 not_signed_in | Available |
| API102 | POST | `/my-mine/claim` | 401 not_signed_in | Available |
| API103 | POST | `/my-mine/claim/self` | 401 not_signed_in | Available |
| API104 | POST | `/my-mine/claim/submit` | 401 not_signed_in | Available |
| API105 | GET | `/my-mine/daily-limits` | 401 not_signed_in | Snapshot only |
| API106 | POST | `/my-mine/draw` | 401 not_signed_in | Available |
| API107 | GET | `/my-mine/energy` | 401 not_signed_in | Available |
| API108 | POST | `/my-mine/energy` | 401 not_signed_in | Available |
| API109 | GET | `/my-mine/goods` | 401 not_signed_in | Available |
| API110 | POST | `/my-mine/jv/claim` | 401 not_signed_in | Available |
| API111 | POST | `/my-mine/jv/claim/self/register` | 401 not_signed_in | Available |
| API112 | POST | `/my-mine/jv/claim/self` | 401 not_signed_in | Available |
| API113 | POST | `/my-mine/jv/claim/submit` | 401 not_signed_in | Available |
| API114 | GET | `/my-mine/jv` | 401 not_signed_in | Available |
| API115 | POST | `/my-mine/jv/settle` | 401 not_signed_in | Available |
| API116 | GET | `/my-mine/progression` | 401 not_signed_in | Snapshot only |
| API117 | POST | `/my-mine/progression` | 401 not_signed_in | Snapshot only |
| API118 | GET | `/my-mine/ranks` | 401 not_signed_in | Available |
| API119 | POST | `/my-mine/ready` | 401 not_signed_in | Snapshot only |
| API120 | POST | `/my-mine/record` | 401 not_signed_in | Available |
| API121 | POST | `/my-mine/record/self/register` | 401 not_signed_in | Available |
| API122 | POST | `/my-mine/record/self` | 401 not_signed_in | Available |
| API123 | POST | `/my-mine/record/submit` | 401 not_signed_in | Available |
| API124 | GET | `/my-mine/run` | 401 not_signed_in | Available |
| API125 | POST | `/my-mine/run` | 401 not_signed_in | Available |
| API126 | GET | `/my-mine/sponsor` | Fixture required | Available |
| API127 | POST | `/my-mine/state-run` | 400 bad_run_body | Available |
| API128 | GET | `/api/notifications` | 401 not_signed_in | Available |
| API129 | PATCH | `/api/notifications` | 401 not_signed_in | Available |
| API130 | GET | `/api/onboarding/introduction` | 401 not_signed_in | Snapshot only |
| API131 | POST | `/api/onboarding/introduction` | 401 not_signed_in | Snapshot only |
| API132 | POST | `/api/product/event` | 400 bad_step | Snapshot only |
| API133 | POST | `/api/quest/link-open` | 401 not_signed_in | Available |
| API134 | POST | `/api/quest/result` | 401 not_signed_in | Available |
| API135 | POST | `/api/quest/seen` | 401 not_signed_in | Snapshot only |
| API136 | POST | `/api/quest/sent` | 401 not_signed_in | Available |
| API137 | POST | `/api/quest/voucher` | 401 not_signed_in | Available |
| API138 | GET | `/api/quests` | 200 | Available |
| API139 | POST | `/api/quiz/answer` | 401 not_signed_in | Available |
| API140 | POST | `/api/quiz/checkin/result` | 401 not_signed_in | Available |
| API141 | POST | `/api/quiz/checkin/sent` | 401 not_signed_in | Available |
| API142 | GET | `/api/quiz/today` | 401 not_signed_in | Available |
| API143 | POST | `/api/quiz/voucher` | 409 client_outdated | Available |
| API144 | POST | `/api/register/send-code` | 401 not_signed_in | Available |
| API145 | POST | `/api/register/skip-otp` | Fixture required | Available |
| API146 | GET | `/api/register/status` | 200 | Available |
| API147 | POST | `/api/register/verify-code` | 401 not_signed_in | Available |
| API148 | POST | `/api/relay/challenge` | 401 not_signed_in | Available |
| API149 | GET | `/api/relay/status` | 401 not_signed_in | Available |
| API150 | POST | `/api/relay/submit` | 401 not_signed_in | Available |
| API151 | POST | `/reward-credit/claim` | Fixture required | Snapshot only |
| API152 | POST | `/reward-credit/self/register` | Fixture required | Snapshot only |
| API153 | POST | `/reward-credit/status` | Fixture required | Snapshot only |
| API154 | POST | `/reward-credit/submit` | Fixture required | Snapshot only |
| API155 | GET | `/api/sbt/[tokenId]` | 400 invalid token id | Available |
| API156 | GET | `/.well-known/security.txt` | 200 | Available |
| API157 | POST | `/api/support/telegram/webhook` | Fixture required | Available |
| API158 | GET | `/api/telegram/auth/callback` | 303 | Available |
| API159 | POST | `/api/telegram/auth/start` | Fixture required | Available |
| API160 | GET | `/api/telegram/status` | 401 not_signed_in | Available |
| API161 | POST | `/api/telegram/verify` | 401 not_signed_in | Available |
| API162 | POST | `/api/telemetry/latency` | 204 | Available |
| API163 | POST | `/api/telemetry/website` | 204 | Available |
| API164 | POST | `/api/vote/activity` | 401 not_signed_in | Available |
| API165 | GET | `/api/vote/metadata/[id]` | 400 bad_proposal_id | Available |
| API166 | GET | `/api/vote/proposals` | 200 | Available |
| API167 | POST | `/api/vote/relay/prepare` | 401 not_signed_in | Available |
| API168 | POST | `/api/vote/relay/submit` | 401 not_signed_in | Available |
| API169 | POST | `/api/word/guess` | 401 not_signed_in | Snapshot only |
| API170 | GET | `/api/word/outstanding` | 401 not_signed_in | Snapshot only |
| API171 | GET | `/api/word/today` | 401 not_signed_in | Snapshot only |

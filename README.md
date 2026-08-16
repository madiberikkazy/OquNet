# OquNet — Book Sharing Community (MVP)

React + Firebase web app where readers in a local community share physical books.

## Tech stack
- React 18 + Vite
- React Router v6
- Tailwind CSS
- Firebase Auth (email/password), Firestore, Storage

The app works **with or without** Firebase configured. Without `.env`, all data falls back to `localStorage` so you can explore the UI immediately and connect Firebase later.

## Run locally

```bash
cd oqunet
npm install
npm run dev
```

Open http://localhost:5173.

## Connect Firebase

See **[FIREBASE_SETUP.md](./FIREBASE_SETUP.md)** for a complete step-by-step walkthrough — it's written for people who have never used Firebase before. It covers: creating the project, enabling email auth, creating Firestore + Storage, registering a web app, filling in `.env`, and tightening security rules.

Quick version: copy `.env.example` → `.env`, paste your Firebase web config, restart `npm run dev`.

## Schema changes

**`src/firebase/schema.js` is the only description of what a stored document
looks like.** Every write in `src/firebase/firestore.js` runs its payload
through a normalizer there — in both the Firestore branch and the localStorage
one — and a field that is not in the schema is refused rather than written.

When a field changes — renamed, added, retyped, given a new meaning:

1. **Change `src/firebase/schema.js` first.** Add the field to the collection's
   normalizer, and to its `required` / `defaults` if it belongs there. If it is
   a field a patch may carry, add it to the patch allowlist too.
2. **Update `firestore.rules`** if the rules constrain that field, add a case to
   `tests/firestore.rules.test.js`, and run `npm run test:rules`.
3. **Then migrate the data, or reseed it.** Pre-launch, reseeding is the honest
   option: `npm run seed -- --force` wipes and rebuilds. Post-launch, write a
   one-off script that rewrites the existing documents.

**Never add a read-time fallback.** A line like `book.holderId ||
book.borrowerId`, or `rating.value ?? rating.stars`, looks like a small
compatibility courtesy and is really a permanent second schema: it has to be
repeated at every read site, it hides which shape the data is actually in, and
the next person cannot tell whether the old shape still exists anywhere. This
project carried four of them at once — `stars`/`value`,
`borrowerId`/`holderId`, `rating`/`ratingCount`, and pickup codes minted at read
time — and one cost an extra Firestore query per book per page. All four are
gone. A field change means the stored documents change; if that is too expensive
to do now, it is too expensive to do at all.

## Seeding a development database

`scripts/seed.mjs` builds a working community: one admin, three members, and
twelve books at assorted stages of being lent and rated, several recent enough
to fill the "new books" rail.

```bash
# Firebase console → Project settings → Service accounts → Generate new private key.
# Save it as serviceAccount.json in the repo root (gitignored).
npm run seed              # refuses if the collections already hold data
npm run seed -- --force   # wipe those collections and every Auth account, then seed
```

It creates the Auth accounts too, so each seeded user document's id is a uid you
can actually sign in as — all four share the password `oqunet123`. Every
document it writes goes through the same `schema.js` normalizer the app uses, so
seeded data cannot drift away from what the app itself would have written.

To point it at the emulators instead of a real project:

```bash
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 \
  firebase emulators:exec --only firestore,auth 'npm run seed -- --force'
```

## Auth flow
- **Register** — email, nickname, first name, last name, password (confirmed). Optional avatar upload.
- **Login** — email **or** nickname, plus password. Nickname is resolved server-side to its email, then Firebase Auth signs the user in.

## Project layout

```
src/
  firebase/schema.js  The shape of every stored document — see "Schema changes"
  firebase/           Firebase init + data layer (Firestore/Storage/Auth)
  contexts/           Auth & Community React contexts
  components/         BottomNav, BookCard, MobileShell, Stepper, ...
  pages/
    auth/           Register, Login
    user/           Home, Books, BookDetail, PickupBook, Notifications, Profile, Settings
    admin/          AdminHome, AdminBooks, AddBook (3-step), AdminNotification, AdminProfile
    community/      CreateCommunity (3-step), JoinCommunity, CommunityProfile, UserProfile
  utils/i18n.js     Russian/Kazakh labels
server/             Phone verification webhooks (Express, deployed separately)
```

### The verification server

`server/` is a small Express process, deployed apart from the app — on Render's
free tier, which is why it is not a Cloud Function. It exists because of one
rule: the security rules refuse `phone` and `phoneVerifiedAt` from every client,
so a number can only become verified by a server that watched a Telegram
contact card arrive from it. See `server/README.md` for deploying it and
`src/firebase/phoneVerify.js` for the app's half.

## MVP behavior

- One community per user. Books section is empty when the user isn't in a community.
- Email + password auth. Login accepts email or nickname.
- Borrowing: one active book at a time; return date capped by `maxDays`.
- Admin role: create posts, add books (3-step wizard with owner picker), approve/reject join requests, send notifications, invite users.
- Switching user → admin requires owning/creating a community; admin → user requires no active borrowing.

## Design notes
Clean, no fake browser/status bar. White card on a tinted background, soft pills, brand blue `#2D6BFF`, rounded inputs, consistent bottom nav across Home / Books / Notification / Profile.

## Roadmap (post-MVP)
- Super Admin role and multi-community moderation
- Push notifications (FCM)
- Dark theme + Kazakh language toggle

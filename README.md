# ReliefLink India — HTML, CSS, JavaScript + Node.js

This version is rewritten without React, TypeScript, Vite or JSX. The frontend uses plain HTML, CSS and browser JavaScript. The backend uses Node.js and Express.

## Features
- Separate workspace entry screen with administrator, NGO partner, shelter manager, donor, volunteer and beneficiary dashboards/workflows
- Dedicated role-specific profile dashboards for administrators and NGO/shelter accounts, with their own workspace metrics and relevant shortcuts
- Editable personal profiles save phone and location details, plus an optional organisation/shelter name, in the active workspace database
- Disaster incident reports with evidence attachment and administrator review
- Resource requests linked to verified incidents, with separate evidence and review
- Donor offers and matching against verified open needs
- Pledges and delivery status tracking
- Individual assistance requests
- Proof & verification portal with NDMA, NRSC/ISRO NDEM, IMD, SACHET, NGO Darpan and data.gov.in reference portals
- Separate disaster and item-specific evidence, official source URLs, reviewer notes and review dates
- Google Maps location-search links for incident and aid locations (the embedded needs map continues to use OpenStreetMap)
- Needs map using Leaflet and OpenStreetMap tiles (internet required)
- JSON workspace backup import/export and CSV exports for Excel/Power BI
- Node.js API persists records in transactional SQLite locally or MongoDB Atlas when configured
- First connection to an empty Atlas database migrates all existing SQLite workspace collections; cloud records are not overwritten
- Every role collects a verification ID at sign-in and saves it in the shared `userProfiles` collection
- Submitted incidents, resource needs, donor offers, pledges and individual requests retain the submitting account's verification ID; administrator review decisions retain the reviewer's ID
- Each submission appears in the shared dashboard and all active sessions refresh from the API every five seconds
- New record changes are synchronized by ID so concurrent NGO and donor submissions do not replace another user's newer records
- The database starts empty; dashboard records come from actual form/API submissions rather than fabricated emergency examples
- Existing `data/workspace.json` data is imported once when the SQLite database is first created

## Requirements
- Node.js 22.5 or newer (uses Node's built-in SQLite module and `.env` loader)
- npm
- Internet connection for Google Fonts and map tiles (core UI/API runs locally)

## Run on Windows / VS Code
1. Extract the ZIP.
2. Open the extracted `relieflink-html-node` folder in VS Code.
3. Open Terminal → New Terminal.
4. Run `npm install`.
5. For local SQLite, run `npm start` (or `npm run dev` for Node's watch mode).
6. To use MongoDB Atlas, create a database user and allow the server's IP address in Atlas Network Access. Copy `.env.example` to `.env` and set `MONGODB_URI` to the Atlas connection string and `MONGODB_DB_NAME` to a database name. Keep `.env` private; do not commit it or paste the URI into chat.
7. Run `npm start` (or `npm run dev`). When Atlas is configured, the app connects to Atlas as its active database. On the first run, if the Atlas workspace is empty, all existing SQLite records are copied once. Existing Atlas records are preserved and are never automatically replaced by the local copy.
8. Open `http://localhost:4000` in your browser.

The login and dashboards are served by the same Node.js process. There is no separate Vite server. API health check: `http://localhost:4000/api/health`; current workspace data: `http://localhost:4000/api/state`; official source catalog: `http://localhost:4000/api/sources`. The health endpoint reports whether SQLite or MongoDB Atlas is active. The web app refreshes workspace records every five seconds. `PATCH /api/state` synchronizes changes by record; `PUT /api/state` intentionally replaces the whole workspace for backup restore.

If the dashboard cannot load, start the Node.js server with `npm start` and open `http://localhost:4000` (not the HTML file or a separate Live Server port). The dashboard reads the SQLite database used by that server. An empty requests panel means no NGO requests have been submitted to that database; official portal links are references and do not import live records.

## Important workflow
1. Sign in as the Administrator demo role.
2. Create a disaster report and attach evidence; it starts as Pending review.
3. Review it and add a reason before marking Verified or Rejected.
4. Sign in as NGO partner (or Shelter manager), using the same email address on each device/session for that organisation's dashboard, and submit a resource request linked to a verified incident with separate evidence of the exact need.
5. Administrator reviews that resource request separately.
6. Sign in as Donor and publish an offer. Match it only to verified open needs.
7. Record a pledge and update delivery status after confirming the handover.
8. Keep the NGO dashboard open to see new requests, pledges and received quantities synchronize from the shared SQLite database.

Each form submission is saved to the shared SQLite database; the administrator's incoming-request panel and the submitting NGO's dashboard refresh automatically while open. No public sample emergencies are seeded. New submissions made directly by an administrator appear in the review queues like other records.

## Data
The local workspace is stored in `data/relieflink.sqlite`; when `MONGODB_URI` is configured, MongoDB Atlas is the active store. The first connection to an empty Atlas database copies all existing local workspace collections, including NGO profiles, in one migration. Thereafter Atlas is authoritative. JSON import in the UI replaces the active workspace. JSON export is a portable backup; CSV exports are for analysis and cannot restore the workspace. The previous `data/workspace.json` is retained as a one-time local migration source and is not used for ongoing writes.

Every role must provide a verification ID at sign-in; NGO/shelter accounts must also provide an email for matching their records across sessions. IDs are saved in `userProfiles`; NGO IDs are also retained in the legacy-compatible `ngoProfiles` collection and copied onto resource requests for administrator review. IDs remain user-provided and unverified; this is not authentication or proof of registration.

## Prototype and safety limitations
- Login is a demo role selector, not authentication. Verification IDs are stored as supplied and are not checked against NGO Darpan or any other registry. Do not use for sensitive personal data or actual relief distribution.
- UI role checks are not security. API endpoints do not enforce user identity or roles. A public deployment requires real authentication, server-side authorisation, database transactions, audit logs, private evidence storage, file scanning, rate limiting, backups and validation.
- Evidence upload is limited to 1 MB per file in the browser demo and stores evidence as a data URL in the local SQLite database. Avoid sensitive personal information.
- The source directory links to official portals but does not scrape or query government/NGO systems. data.gov.in API use requires a registered API key and selected dataset; Google Maps search links need no key, but map tiles are not Google Maps.
- NGO Darpan IDs and uploaded/source-linked evidence are not automatically authenticated. Administrators must verify the NGO registration and incident directly with the official source and record their decision and review note.
- A file upload does not prove a disaster occurred. Verify with official disaster-management authorities, district/state updates, IMD, police/fire services, and trusted local organisations. Review every exact resource need separately.
- Sample/illustrative data must not be represented as a real verified emergency.


## Role-specific workspaces (updated)
The left navigation and overview dashboard now change by demo role. The underlying relief coordination records remain in one shared database on purpose, but the UI displays role-relevant records:
- **Administrator:** all queues, verification decisions, all pledges/requests, and data import/export.
- **NGO partner:** its own submitted needs/incidents and pledges linked to its needs, plus verified public needs and verified public incidents.
- **Shelter manager:** NGO workflow plus approved/fulfilled individual requests for fulfilment.
- **Donor:** its own offers and pledges; only verified open resource needs are available for matching.
- **Volunteer:** verified public incidents and verified open needs; volunteer assignment/scheduling is not implemented.
- **Person in need:** only their own assistance requests and status; no other applicants' request list.

These are **front-end demo filters**, not real security boundaries. `/api/state` still exposes shared records to any caller and the role selector is not authentication. Do not use real identity documents or victim information until server-side authentication, authorisation, per-record API filtering, and secure evidence storage are implemented.

## Complete project package

This folder includes the full ReliefLink India Node.js/Express project, role-specific demo workspaces, and readable CSS with animations, hover effects, and transitions.

### Run on Windows
1. Install Node.js 22.5 or newer.
2. Open this folder in VS Code.
3. Open Terminal > New Terminal.
4. Run `npm install`.
5. Run `npm start`.
6. Open `http://localhost:4000` in your browser.

The role-specific workspace filters are currently a frontend demo. Do not use this version with real personal or sensitive data until server-side authentication, authorization, and secure evidence storage are implemented.

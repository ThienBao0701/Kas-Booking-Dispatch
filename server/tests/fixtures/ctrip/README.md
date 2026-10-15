# CTrip / Trip.com fixtures — ASSUMED FORMAT

**These are not captures of real CTrip documents.** No real or sanitized CTrip
booking text existed in this repository when CTrip intake was added, so these
fixtures document an *assumed* layout rather than an observed one. They exist to
pin the behaviour that does not depend on CTrip's exact grammar:

- the source is stored and returned as `CTRIP`;
- the hotel name resolves against the branch's **current CTrip identity**;
- an unknown or ambiguous property name blocks automatic assignment;
- missing critical fields are flagged and block dispatch.

## What is assumed

The layout below mirrors the label-and-value shape the shared extraction engine
already supports across Booking.com and Agoda: one field per line, a `Label:
value` form, ISO or long dates, and grouped VND amounts. CTrip's real pages may
differ — in label wording, ordering, or how prices are grouped.

## What this means operationally

Until real samples are captured, CTrip extraction is **conservative**: whatever
the generic engine can read is read, and everything else is surfaced as a
warning for the Admin to complete. No CTrip-specific field grammar has been
written, because guessing at one is how a parser silently mis-reads a price or a
date.

## When real samples arrive

1. Sanitize them: replace every guest name, phone, email and booking code with
   invented values. Never commit real guest data.
2. Add them here alongside these files.
3. Extend `server/src/booking/ctrip.ts` with the real grammar, driven by those
   fixtures.
4. Tighten `server/tests/ctripIntake.test.ts` from "flags what it cannot read"
   to exact field assertions.

Every value in these files is invented.

// The demo repos judges can try without connecting anything: each one shows a different thing
// No Repro does, and comes with example reports that open GitHub's new-issue form pre-filled.

export interface DemoExample {
  /** Button label. */
  label: string;
  title: string;
  body: string;
  /** What No Repro should do with it, shown under the button. */
  expect: string;
}

export interface Demo {
  /** One line: what this repo shows off. */
  shows: string;
  examples: DemoExample[];
}

export const DEMOS: Record<string, Demo> = {
  "rushibhosalepro/repro-test": {
    shows: "A vague report solved with Sentry: the production error fills in the steps, then it's reproduced and bisected.",
    examples: [
      {
        label: "Vague crash report",
        title: "Can't add the hoodie to my cart",
        body: "It just shows an error.",
        expect: "Matches SHOPLITE-1 in Sentry, points at server.ts:87, reproduces it and finds the commit “Track stock for products”.",
      },
    ],
  },
  "rushibhosalepro/tasks-app": {
    shows: "A clear report reproduced in a real browser on the repo's own runner, then bisected. No Sentry needed.",
    examples: [
      {
        label: "Clear bug report",
        title: "Deleting a task removes a different one",
        body: "Steps:\n1. Open the task list\n2. Click Delete next to “Book dentist”\n\nExpected: “Book dentist” disappears.\nActual: “Book dentist” is still there and “Buy groceries” is gone instead.",
        expect: "Reproduces it 3 of 3 times and finds the commit “Sort tasks by due date”.",
      },
      {
        label: "Report with a gap",
        title: "Tasks disappear",
        body: "Some of my tasks just vanished.",
        expect: "Asks one question to find out what you did, instead of guessing.",
      },
    ],
  },
  "rushibhosalepro/notely": {
    shows: "A one-line report becomes reproducible because Sentry recorded the exact search that crashed.",
    examples: [
      {
        label: "Vague search report",
        title: "Search is broken",
        body: "I searched my notes and it just said “Something went wrong”.",
        expect: "Matches NOTELY-1 in Sentry, which shows the query that crashed, then reproduces it and finds “Search: match the start of words”.",
      },
    ],
  },
  "rushibhosalepro/ticketbox": {
    shows: "A bug that only happens some of the time. No Repro says so instead of claiming it always fails.",
    examples: [
      {
        label: "Intermittent bug",
        title: "Promo code EARLYBIRD sometimes says it isn't valid",
        body: "Steps:\n1. Open the checkout\n2. Type EARLYBIRD in the promo code field\n3. Click Apply\n\nExpected: 20% off.\nActual: sometimes it says “That promo code isn't valid”. Trying again often works.",
        expect: "Reproduces it in some runs but not all, so it reports the bug as flaky.",
      },
      {
        label: "Feature request",
        title: "Please add dark mode",
        body: "The checkout is too bright at night.",
        expect: "Not a bug a browser can check, so it leaves it for a human.",
      },
    ],
  },
};

export function demoFor(repo: string): Demo | null {
  return DEMOS[repo.toLowerCase()] ?? Object.entries(DEMOS).find(([r]) => r.toLowerCase() === repo.toLowerCase())?.[1] ?? null;
}

/** GitHub's new-issue form with the example filled in; the judge submits it from their own account. */
export function newIssueHref(repo: string, ex: DemoExample): string {
  const q = new URLSearchParams({ title: ex.title, body: ex.body });
  return `https://github.com/${repo}/issues/new?${q}`;
}

# Build and Run a Rod-Based Browser Verification System

You have been developing this application. I now want you to act as both the developer and an independent browser-level QA engineer.

Your task is to:

1. Understand the current application and its intended functionality.
2. Set up a browser testing environment using **Go + Rod**.
3. Design meaningful end-to-end tests based on the application's actual user workflows.
4. Run those tests against the real application.
5. Operate Chrome visibly where practical so I can watch the tests execute.
6. Capture screenshots, logs, and other diagnostic evidence.
7. Capture video of requested tests or requested portions of tests.
8. Produce a concise human-readable report showing exactly what worked, what failed, and what remains untested.

Do not merely create test code. **You must actually run the tests and report the observed results.**

---

# 1. Inspect the Application First

Before writing tests, inspect the existing repository.

Determine:

* how the application is started;
* its important routes/pages/screens;
* important user workflows;
* forms and user inputs;
* navigation paths;
* persistence/database behavior;
* authentication or session behavior, if applicable;
* asynchronous/background operations;
* important success states;
* important error and validation states;
* functionality that could cause data loss or incorrect state;
* existing unit/integration/browser tests;
* existing fixtures and test data;
* existing build/run scripts.

Do not infer behavior solely from filenames.

Read enough implementation code, templates, handlers, specifications, README files, and existing tests to understand what the software is supposed to do.

Create a short test inventory before implementing the browser tests.

---

# 2. Establish the Rod Test Environment

Create a browser-test harness written in Go using:

`github.com/go-rod/rod`

Prefer using the application's existing Go module if appropriate. If architectural separation is cleaner, create a clearly named browser-test package or directory.

A reasonable structure might be:

```
/browser-tests
    browser_test.go
    helpers.go
    recording.go
    assertions.go
    fixtures.go
    README.md

/test-artifacts
    /<timestamp-or-run-id>/
        report.md
        results.json
        screenshots/
        videos/
        logs/
```

Adapt this structure to the existing repository rather than forcing it unnecessarily.

The test system must support:

* visible/headed Chrome;
* headless Chrome when explicitly selected;
* configurable application base URL;
* configurable browser timeout;
* screenshots;
* screenshots automatically on failure;
* browser console capture where practical;
* JavaScript error capture;
* useful HTTP/network failure information where practical;
* test-level logging;
* video recording;
* clean browser shutdown;
* deterministic exit codes.

Provide a simple command for running the suite.

For example:

```
go test ./browser-tests/... -v
```

or create an appropriate wrapper command if additional orchestration is required.

---

# 3. Make the Browser Observable

During local interactive testing, launch Chrome in visible/headed mode unless there is a compelling reason not to.

I want to be able to **watch the test drive the software**.

Provide configuration such as:

```
TEST_HEADLESS=false
```

and optionally:

```
TEST_SLOW_MOTION=250ms
```

Do not make normal execution unnecessarily slow, but provide a slow/demo mode that makes browser actions easy for a human observer to follow.

Use Rod's appropriate debugging/trace facilities where useful.

---

# 4. Design Tests From User Behaviour, Not Implementation Details

Do not simply test individual buttons because they exist.

Identify complete user journeys.

For every important workflow, determine:

**Starting state → user action → system response → resulting state**

Tests should verify externally observable behavior.

Examples include:

* application starts successfully;
* important pages load;
* primary navigation works;
* user can begin the application's main workflow;
* valid forms can be submitted;
* required fields are enforced;
* invalid input produces appropriate feedback;
* entered data survives the expected persistence boundary;
* previously created records can be reopened;
* state transitions occur correctly;
* back/forward navigation does not corrupt application state;
* refresh behaves correctly;
* buttons that claim to perform an operation actually perform it;
* generated output appears where expected;
* links resolve correctly;
* application errors are presented sensibly;
* primary workflows can be completed from beginning to end.

Include meaningful negative tests where failure would matter.

Do not manufacture hundreds of low-value tests. Concentrate on behaviour whose failure would affect a real user or invalidate the application's purpose.

---

# 5. Establish Test Priorities

Classify tests into approximately these levels:

## P0 — Critical smoke tests

The application is fundamentally broken if these fail.

Examples:

* application launches;
* homepage/main workspace loads;
* primary workflow can start;
* critical data can be submitted;
* primary result/output is produced.

## P1 — Core user journeys

Important functionality a normal user is expected to exercise.

## P2 — Edge cases and robustness

Validation, unusual navigation, interrupted workflows, malformed data, refresh/reopen behaviour, etc.

Run P0 first.

If P0 fails badly enough that downstream tests cannot meaningfully execute, continue only where useful and clearly explain what was blocked.

---

# 6. Selectors Must Be Robust

Avoid brittle selectors based on layout, element order, generated CSS classes, or cosmetic text where a better semantic target exists.

Prefer, in roughly this order:

* stable semantic attributes;
* element IDs;
* accessible labels/roles;
* stable application identifiers;
* `data-testid` attributes where necessary.

If reliable testing requires adding a small number of `data-testid` attributes to the application, you may do so.

Do not alter visible application behaviour merely to make testing easier.

Document any production-code changes made specifically to improve testability.

---

# 7. Synchronization

Do not make the test suite depend primarily on arbitrary sleeps.

Use browser/application conditions such as:

* element visible;
* element enabled;
* navigation completed;
* DOM stabilized;
* expected text present;
* network/request completion;
* expected application state reached.

A small deliberate delay may be used in **demo/watch mode**, but it must not be the primary synchronization mechanism.

---

# 8. Test Data

Tests should be repeatable.

Where possible:

* create unique test data;
* isolate test records;
* avoid depending on previous test runs;
* clean test records after execution when safe;
* clearly identify persistent test artifacts if cleanup is inappropriate.

Never destroy genuine user or production data.

Before destructive actions, determine that the environment is actually a disposable/test environment.

---

# 9. Screenshots

Capture screenshots:

* on every test failure;
* at particularly important checkpoints;
* when specifically requested;
* before and after a visually significant operation where useful.

Use meaningful filenames such as:

```
P0-03-submit-idea-before.png
P0-03-submit-idea-success.png
P1-07-validation-error.png
```

Do not generate hundreds of redundant screenshots.

---

# 10. Video Recording

Implement video recording for selected browser tests.

The testing system should make it possible to specify that:

* an entire test should be recorded; or
* a defined portion of a test should be recorded.

For example, provide conceptual helpers such as:

```
StartRecording("submission-workflow")
...
StopRecording()
```

The exact API is your design decision.

For page video, prefer Chrome DevTools Protocol screencasting through Rod's lower-level protocol access, capturing screencast frames and encoding them into a normal video format using `ffmpeg`.

Preferred output:

```
.mp4
```

or, if technically simpler/reliable:

```
.webm
```

If `ffmpeg` is required:

1. detect whether it is installed;
2. clearly report if it is absent;
3. install/configure it if doing so is safe and appropriate in this development environment;
4. otherwise provide the exact prerequisite required.

Recording must not silently fail.

After recording, verify that:

* the file exists;
* it is non-zero length;
* it can be probed/read as a valid video;
* its filename is included in the test report.

Where practical, the video should show only the requested section rather than recording every test indiscriminately.

---

# 11. Requested Video Tests

For this run, record the following:

```
VIDEO_REQUESTS:
- [INSERT REQUESTED TEST OR WORKFLOW HERE]
- [INSERT REQUESTED TEST OR WORKFLOW HERE]
```

If this list is empty, record at least one representative P0 end-to-end workflow as a demonstration that video capture works.

---

# 12. Capture Browser Problems

During testing, watch for problems beyond explicit assertions.

Report noteworthy:

* JavaScript exceptions;
* unhandled promise rejections;
* HTTP 4xx/5xx responses related to application functionality;
* broken resource loads;
* unexpected redirects;
* duplicate submissions;
* UI elements obscuring controls;
* obvious layout breakage;
* controls that appear clickable but do nothing;
* state unexpectedly disappearing;
* unexplained long waits;
* browser console errors.

Do not automatically fail tests for harmless third-party noise unless it actually indicates application malfunction.

Separate application defects from incidental browser noise.

---

# 13. Test Desktop and Relevant Viewports

Run the primary suite at the application's normal desktop viewport.

Also exercise important P0 workflows at a representative mobile viewport if the application is intended to support mobile.

A useful starting point is approximately:

```
Desktop: 1440 x 900
Mobile: 390 x 844
```

Do not assume that simply changing viewport dimensions proves mobile usability.

Check whether:

* controls remain reachable;
* text remains legible;
* forms remain usable;
* navigation remains accessible;
* dialogs fit;
* content does not cause inappropriate horizontal scrolling;
* primary actions remain visible and usable.

---

# 14. Do Not Fix Failures Before Recording Them

There is an important distinction between testing and development.

If you discover a defect:

1. preserve evidence of the failure;
2. record the failing test result;
3. capture appropriate screenshot/log/video evidence;
4. identify the likely cause;
5. then fix it if the task reasonably includes doing so;
6. rerun the failing test;
7. report BOTH the original failure and the successful post-fix result.

Do not quietly change code until the test passes and then claim the feature worked.

I want the testing system to expose defects, not erase their history.

---

# 15. Actually Execute the Tests

Once the harness and tests exist:

1. start the application in the correct test/development configuration;
2. verify the application is reachable;
3. run P0 tests;
4. run P1 tests;
5. run appropriate P2 tests;
6. run requested recorded workflows;
7. run relevant mobile tests;
8. collect artifacts;
9. shut down processes cleanly.

Do not stop after compilation.

Do not tell me that tests "should pass."

Run them.

Report what actually happened.

---

# 16. Machine-Readable Results

Generate a simple result file such as:

```
test-artifacts/<run-id>/results.json
```

Include at least:

* run ID;
* date/time;
* application commit/hash if available;
* base URL;
* browser version;
* Go version;
* Rod version;
* total tests;
* passed;
* failed;
* skipped;
* test duration;
* individual test results;
* error descriptions;
* screenshot paths;
* video paths.

Do not invent results if some information cannot be obtained.

---

# 17. Human-Readable Report

Also generate:

```
test-artifacts/<run-id>/report.md
```

The report should have these sections:

## Browser Verification Summary

Overall:

```
PASS / PASS WITH ISSUES / FAIL
```

## Environment

Brief versions/configuration used.

## Results

| Test | Priority | Result | Duration | Evidence |
| ---- | -------- | ------ | -------- | -------- |

## Defects Found

For each defect:

* severity;
* workflow affected;
* expected behaviour;
* actual behaviour;
* reproduction steps;
* probable cause, if known;
* screenshot/video/log references.

## Videos

List each recording and exactly what workflow it shows.

## Browser/Console Problems

Only meaningful items.

## Untested or Partially Tested Behaviour

Be explicit.

## Changes Made During Testing

Especially:

* test hooks;
* `data-testid` attributes;
* application fixes prompted by discovered defects.

## Final Assessment

Answer:

1. Can a normal user complete the application's primary workflow?
2. Which important workflows were actually demonstrated?
3. What currently prevents release, if anything?
4. What is the highest-risk behaviour that remains insufficiently tested?

---

# 18. Final Response to Me

When finished, do not merely say:

"Tests completed successfully."

Give me a compact result such as:

```
Browser verification: PASS WITH ISSUES

18 tests executed
15 passed
2 failed
1 skipped

P0: 6/6 passed
P1: 8/9 passed
P2: 1/3 passed, 1 failed, 1 skipped

Defects discovered:
- Refresh after Stage 4 loses current selection
- Mobile confirmation dialog extends below viewport

Videos:
- test-artifacts/2026-.../videos/full-primary-workflow.mp4
- test-artifacts/2026-.../videos/mobile-submission.mp4

Screenshots:
- ...

Full report:
- test-artifacts/2026-.../report.md
```

Then explain the defects and important observations.

---

# 19. Acceptance Criteria

This task is complete only when all of the following are true:

* [ ] Rod is installed/configured.
* [ ] The browser test package compiles.
* [ ] The application can be launched for testing.
* [ ] Chrome can be driven visibly.
* [ ] At least one real end-to-end application workflow exists.
* [ ] Tests contain meaningful assertions rather than merely clicking controls.
* [ ] P0 tests have actually been executed.
* [ ] Important P1 tests have actually been executed.
* [ ] Failures automatically preserve useful evidence.
* [ ] Screenshots work.
* [ ] Browser errors are captured or meaningfully reported.
* [ ] Video recording works.
* [ ] At least one produced video has been validated as a real readable video file.
* [ ] Requested video segments have been recorded.
* [ ] Desktop behaviour has been exercised.
* [ ] Mobile behaviour has been exercised if applicable.
* [ ] Machine-readable results have been produced.
* [ ] A human-readable test report has been produced.
* [ ] The final response gives observed pass/fail results.
* [ ] Anything that could not be tested is explicitly identified.

Do not mark an acceptance criterion complete unless you have evidence that it is actually complete.

---

# 20. Preserve This as Infrastructure

This is not intended to be a disposable one-time script.

Design the browser harness so future coding agents can add a browser test when they implement new functionality.

Prefer reusable helpers for:

* browser startup;
* login/setup;
* navigation;
* screenshots;
* recording;
* assertions;
* artifact directories;
* failure diagnostics;
* viewport selection.

Keep the abstractions modest. Do not build an elaborate test framework before it is needed.

The goal is a **small, dependable browser verification system that gives us observable evidence that the software actually works.**

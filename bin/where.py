#!/usr/bin/env python3
"""
where.py - read a site record cold and name the one gate that is open.

Usage:
    python3 bin/where.py sites/lp.rexdalemobilewash.ca.md

Rules enforced here, taken from wp-migration/SKILL.md:

  * The LOG is the source of truth. Frontmatter is only an index.
  * If they disagree, the LOG wins - and this script says so loudly.
  * A gate is passable only when its status is 'approved' or 'pre-existing'.
  * 'pre-existing' is NOT a shortcut. It needs the same proof as 'approved'.
    This script cannot judge proof; it only reports what the log claims.
  * The open gate is the first gate that is not yet passable.

Exit codes:
    0  read cleanly, open gate named, index agrees with log
    2  read cleanly, but the frontmatter index DISAGREES with the log
    3  record unreadable or malformed
    4  no record path given

Stdlib only. No third-party imports. Runs on Windows and POSIX.
"""

import os
import re
import sys

# gate id, human name, skill that runs it
GATES = [
    ("0.1", "the intake form",                  "wp-01-ask-the-questions"),
    ("0.2", "every account reachable",          "wp-02-check-all-logins"),
    ("0.3", "DNS written down before it changes", "wp-03-save-the-dns-settings"),
    ("0.4", "every address the old site serves", "wp-04-list-every-page"),
    ("1",   "GitHub org",                       "wp-05-github-org"),
    ("2",   "private code repo",                "wp-06-create-code-repo"),
    ("3",   "empty Astro site",                 "wp-07-build-empty-astro-site"),
    ("4",   "image store (Backblaze B2)",       "wp-08-create-image-store"),
    ("5",   "copy images over (rclone copy)",   "wp-09-copy-images-over"),
    ("6",   "DNS is ours (Cloudflare)",         "wp-10-confirm-dns-is-ours"),
    ("7",   "img.[domain] turned on",           "wp-11-turn-on-image-address"),
    ("8",   "rebuild the pages",                "wp-12-rebuild-the-pages"),
    ("9",   "Railway hosting",                  "wp-13-set-up-railway-hosting"),
    ("10",  "live privately (preview URL)",     "wp-14-put-site-live-privately"),
    ("11",  "contact form (Resend)",            "wp-15-connect-contact-form"),
    ("12",  "booking and payments",             "wp-16-add-booking-and-payments"),
    ("13",  "point domain at new site",         "wp-17-point-domain-at-new-site"),
    ("14",  "keep old links working",           "wp-18-keep-old-links-working"),
    ("15",  "check nothing is broken",          "wp-19-check-nothing-is-broken"),
    ("16",  "switch off old site (DESTRUCTIVE)", "wp-20-switch-off-old-site"),
]

GATE_IDS = [g[0] for g in GATES]
GATE_BY_ID = {g[0]: g for g in GATES}

PASSABLE = {"approved", "pre-existing"}
KNOWN_STATUSES = {
    "not-started",      # nothing has happened
    "open",             # this is the gate being worked right now
    "awaiting-approval",# work done, Paolo has not approved it
    "approved",         # done, and approved against something visible
    "pre-existing",     # already true before we arrived - same proof as approved
    "blocked",          # cannot proceed, reason recorded in the log
    "failed",           # attempted, did not work, reason recorded in the log
    "n/a",              # bookkeeping entries only (gate 0.0)
}

BAR = "=" * 72
DASH = "-" * 72


def die(code, msg):
    sys.stderr.write("where.py: %s\n" % msg)
    sys.exit(code)


def read(path):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return fh.read()
    except OSError as exc:
        die(3, "cannot read %s (%s)" % (path, exc))


def frontmatter(text):
    m = re.match(r"^---\s*\n(.*?)\n---\s*\n", text, re.S)
    return m.group(1) if m else ""


def fm_scalar(fm, key):
    m = re.search(r"^%s:\s*(.+?)\s*$" % re.escape(key), fm, re.M)
    return m.group(1).strip().strip('"').strip("'") if m else ""


def fm_gates(fm):
    """Parse the gates: block in the frontmatter. Index only."""
    m = re.search(r"^gates:\s*$", fm, re.M)
    if not m:
        return {}
    out = {}
    for line in fm[m.end():].splitlines():
        if not line.strip():
            continue
        if re.match(r"^\S", line):      # dedented - block is over
            break
        mm = re.match(r'\s+"?([0-9]+(?:\.[0-9]+)?)"?\s*:\s*([a-z\-/]+)', line)
        if mm:
            out[mm.group(1)] = mm.group(2)
    return out


def log_entries(text):
    """Parse the ## LOG section. This is the source of truth."""
    m = re.search(r"^##\s+LOG\s*$", text, re.M)
    if not m:
        return []
    body = text[m.end():]
    nxt = re.search(r"^##\s+", body, re.M)
    if nxt:
        body = body[:nxt.start()]

    entries = []
    for chunk in re.split(r"^-\s+(?=gate:)", body, flags=re.M)[1:]:
        e = {}
        for line in chunk.splitlines():
            mm = re.match(r"\s*([a-zA-Z_]+)\s*:\s*(.*)$", line)
            if mm:
                k = mm.group(1).strip()
                v = mm.group(2).strip().strip('"').strip("'")
                if k not in e:          # first wins; ignore stray continuations
                    e[k] = v
        if "gate" in e:
            entries.append(e)
    return entries


def truth_from_log(entries):
    """Last log entry per gate wins. Returns {gate_id: (status, entry)}."""
    truth = {}
    for e in entries:
        gid = e.get("gate", "").strip()
        if gid in GATE_BY_ID:
            truth[gid] = (e.get("status", "").strip(), e)
    return truth


def main():
    if len(sys.argv) < 2:
        die(4, "usage: python3 bin/where.py sites/<domain>.md")

    path = sys.argv[1]
    if not os.path.exists(path):
        die(3, "no record at %s - this is a new build; "
               "copy sites/_TEMPLATE.md and start at wp-01-ask-the-questions"
               % path)

    text = read(path)
    fm = frontmatter(text)
    if not fm:
        die(3, "%s has no frontmatter block" % path)

    domain = fm_scalar(fm, "domain") or "(domain not set)"
    slug = fm_scalar(fm, "slug") or "(slug not set)"
    opened = fm_scalar(fm, "opened") or "(opened not set)"

    index = fm_gates(fm)
    entries = log_entries(text)
    truth = truth_from_log(entries)

    print(BAR)
    print("RECORD   %s" % path)
    print("DOMAIN   %s" % domain)
    print("SLUG     %s" % slug)
    print("OPENED   %s" % opened)
    print("LOG      %d entr%s" % (len(entries), "y" if len(entries) == 1 else "ies"))
    print(BAR)

    # ---- drift check: frontmatter index vs the log -----------------------
    drift = []
    for gid in GATE_IDS:
        idx = index.get(gid, "not-started")
        log_status = truth.get(gid, (None, None))[0]
        if log_status is None:
            if idx not in ("not-started", "open"):
                drift.append((gid, idx, "(no log entry)"))
        elif log_status != idx:
            drift.append((gid, idx, log_status))

    # ---- unknown statuses -----------------------------------------------
    bad = []
    for gid, (st, _e) in truth.items():
        if st not in KNOWN_STATUSES:
            bad.append((gid, st))

    # ---- resolve each gate from the LOG ---------------------------------
    resolved = {}
    for gid in GATE_IDS:
        st = truth.get(gid, (None, None))[0]
        resolved[gid] = st if st else index.get(gid, "not-started")

    # ---- find the open gate ---------------------------------------------
    open_gid = None
    for gid in GATE_IDS:
        if resolved.get(gid) not in PASSABLE:
            open_gid = gid
            break

    # ---- print the ladder ------------------------------------------------
    print("GATES  (status resolved from the LOG, not the index)")
    print(DASH)
    for gid, name, skill in GATES:
        st = resolved.get(gid, "not-started")
        if gid == open_gid:
            marker = ">>"
        elif st in PASSABLE:
            marker = "ok"
        else:
            marker = "  "
        print("%2s  %-5s %-18s %-34s %s" % (marker, gid, st, name, skill))
    print(DASH)
    print("")

    # ---- the answer ------------------------------------------------------
    if open_gid is None:
        print("ALL 20 GATES ARE PASSABLE.")
        print("")
        print("That is not the same as 'done'. Gate 16 is destructive and")
        print("irreversible; confirm against the log entries themselves, not")
        print("this summary. No day-2 procedure exists - say so at handover.")
    else:
        gid, name, skill = GATE_BY_ID[open_gid]
        st = resolved.get(gid)
        print("OPEN GATE   %s - %s" % (gid, name))
        print("STATUS      %s" % st)
        print("RUN         %s" % skill)
        print("")

        prev = GATE_IDS[GATE_IDS.index(gid) - 1] if GATE_IDS.index(gid) > 0 else None
        if prev:
            print("PRECEDED BY gate %s - %s (%s)"
                  % (prev, GATE_BY_ID[prev][1], resolved.get(prev)))
            if resolved.get(prev) not in PASSABLE:
                print("            ^ that is NOT passable, so gate %s must refuse"
                      % gid)
            print("")

        if st == "awaiting-approval":
            print("This gate is awaiting approval. Per SKILL.md: re-present the")
            print("gate IN FULL before accepting anything. Never take a bare")
            print("'yes' for a gate Paolo cannot currently see.")
            print("")
        if st in ("blocked", "failed"):
            e = truth.get(gid, (None, {}))[1] or {}
            print("Reason on record: %s" % (e.get("note") or "(none recorded)"))
            print("")

        ev = (truth.get(gid, (None, {}))[1] or {}).get("evidence")
        if ev:
            print("EVIDENCE    %s" % ev)
            print("")

    # ---- warnings --------------------------------------------------------
    exit_code = 0

    if bad:
        print(BAR)
        print("UNKNOWN STATUS VALUES IN THE LOG")
        for gid, st in sorted(bad):
            print("  gate %-5s status '%s' is not a recognised status" % (gid, st))
        print("  recognised: %s" % ", ".join(sorted(KNOWN_STATUSES)))
        exit_code = 2

    if drift:
        print(BAR)
        print("DRIFT - frontmatter index disagrees with the LOG.")
        print("THE LOG WINS. Fix the frontmatter to match, do not touch the log.")
        print(DASH)
        print("  %-6s %-20s %-20s" % ("gate", "index says", "log says"))
        for gid, idx, log_status in drift:
            print("  %-6s %-20s %-20s" % (gid, idx, log_status))
        print(DASH)
        exit_code = 2

    if exit_code == 0:
        print(BAR)
        print("Index agrees with the log.")

    print(BAR)
    sys.exit(exit_code)


if __name__ == "__main__":
    main()

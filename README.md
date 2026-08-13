# Hearth

A small team of household specialists running on hardware you own.

> ## 🚧 ACTIVE WORK IN PROGRESS · NO RESULTS GUARANTEED
>
> This is a personal project under heavy development. Things break,
> change, and get redesigned without notice. Don't rely on it for
> anything you can't afford to lose. Don't hold us to anything in this
> README. Treat every promise here as a sketch.

```
                      ╭─────────────╮
                      │     Kate    │   chief of staff
                      ╰──────┬──────╯
              ┌──────────────┼──────────────┐
              ▼              ▼              ▼
         Cassandra        Vivian        Dr. Anya
         (security)      (finance)     (veterinary)
              ▼              ▼              ▼
            Iris          Eleanor       Marguerite
        (EV + home)      (garden)      (genealogy)
              ▼              ▼              ▼
          Cordelia         Maggie         Brigid
        (librarian)      (media)         (cook)
                            +
                         Mariah       Beatrice
                          (PM)        (trainer)
```

## What it does

Most days you don't notice it's there.

Then at 7 AM, Kate's morning brief lands. Today's events with real
drive times. The birthday in eleven days. The contractor who hasn't
called back. The renewal quietly expiring. Iris already checked
whether today's trips fit on the car's current charge. Brigid has
dinner picked from what's in the fridge. Cassandra spent the night
watching for anything unusual; she found nothing and says so in one
sentence.

The system absorbs work so it can interrupt rarely. An hour of your
attention is worth more than a hundred well-meaning pings, and the
team is built around that.

This is the kind of household infrastructure that has historically
required hired staff. Most of us don't have an executive assistant or
a butler. We're our own scheduling, follow-ups, financial review,
family birthdays, dinner planning, vet med refills. Hearth handles
the parts you'd hire out if hiring out were realistic.

## Why local

Hearth runs on your hardware. Four reasons that matter:

- **Your data stays yours.** Journal entries, decisions, financial
  notes, your family's medical and veterinary records. None of it
  leaves your network unless you wire up an integration that needs
  it to, and even then only the parts that need it. No telemetry. No
  training data. No third party in the middle.

- **Consistent behavior over time.** Cloud assistants change under
  you. Pricing tiers reshape. Rate-limit windows shift. Quality
  regresses when a popular model goes through safety tuning.
  Capabilities you depended on disappear behind a new plan. None of
  that happens here. The model you bring runs the way it runs. If
  you choose to swap models, that's your choice on your schedule.

- **Costs you control.** A subscription you might forget about is
  one you keep paying for. Running Hearth costs the electricity your
  box already draws plus whatever GPU you put in it. No recurring
  bill to Anthropic, OpenAI, Microsoft, Google, or anyone else for
  the privilege of a personal assistant. (If you do point at a cloud
  LLM, that's a decision you can reverse the day the bill surprises
  you.)

- **You can read what the system actually did.** Every action is
  audited to plain markdown in your vault. Every decision the policy
  gateway makes is inspectable. Every persona is a YAML file you can
  edit. Trust comes from being able to see.

If a cloud-hosted assistant fits your life better, there are good
ones. Hearth is for people who'd rather pay once, host it, and know
what's happening.

## Who's on the team

| | |
|---|---|
| **Kate** | Chief of staff. Drafts in your voice. Routes the team. The first person you talk to. |
| **Cassandra** | Watches the network, the audit log, presence, anything that looks like fraud. Conservative; alarms rarely. |
| **Vivian** | Watches the money. Quiet. Flags the surprise charge, the renewal that drifted up 20%. |
| **Dr. Anya** | The household's vet. Tracks meds, supply forecasts, behavior changes. |
| **Iris** | Home Assistant, the EV, the irrigation, the yard sensors. Knows whether tomorrow fits on this charge. |
| **Eleanor** | Master gardener. Thinks in seasons. Reads soil moisture sensors, weather, the wind. |
| **Marguerite** | Family historian. Holds the archive carefully. Distinguishes "likely the same person" from "the same person." |
| **Cordelia** | The librarian. When another specialist needs source material, she finds it, vets it, files it on the right shelf. |
| **Maggie** | Media and collections. Knows your music taste, watches for shows worth your attention. |
| **Brigid** | The cook. Weekly meal plans against actual household diets, not aspirational ones. |
| **Mariah** | Program manager. Watches whether the staff actually delivers. Routes work that fell short. |
| **Beatrice** | The trainer. When the way the staff works has a gap, she designs the fix and proposes it. |

Each one is a YAML file you can edit. Personalities are written into
their personas in plain English.

## Install

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/alliphant/hearth/main/ops/install.sh)
```

The installer is interactive. It asks who you are, what household
you're setting up for, where you want your files, and which optional
integrations to wire up. Most prompts have sensible defaults; the
fastest path through is Enter × N.

For unattended setup with all defaults, add `--quick`. If something
later goes sideways, `--doctor` runs a diagnostic. `--reconfigure`
re-runs just the wizard. `--uninstall` stops the services without
touching your data. `--purge` is the destructive one and requires a
typed confirmation.

## What you'll need

- **An always-on box.** Anything that can run a small Node-ish
  process. A NUC, a Pi 5, an old desktop, a Mac mini, the spare
  laptop in the closet. Roughly 2 GB of RAM headroom for Hearth
  itself, plus whatever your local LLM needs (often a lot more).

- **An LLM somewhere.** Hearth doesn't ship a model. The setup
  wizard asks where yours lives:

  1. **On the same box.** If you can run Ollama or llama.cpp here,
     that's the simplest path. A 9B model fits on 16 GB of GPU; a
     27B-Q4 fits on 24 GB.
  2. **On another box on your network.** Point Hearth at any
     OpenAI-compatible endpoint. Per-role model assignment is a
     config edit.
  3. **In the cloud.** Same. Bring an OpenAI key, or Anthropic via
     proxy, or whichever provider you use.

- **A phone** (optional, for messaging). If you want Hearth to text
  you, you'll need Telegram or Discord set up. For iMessage you'll
  need a Mac on your network; Apple has no server-side API, so the
  practical path is a self-hosted bridge like BlueBubbles on a Mac
  mini.

- **A personal workstation** (optional, for hard web pages). Some
  venue and ticketing sites are protected against headless browsers.
  If you want Maggie to research shows on those sites, point Hearth
  at a second machine on your LAN with a real GPU. It wakes on
  demand, scrapes, and sleeps. Skip it and Maggie still works; she
  just falls back to a simpler text-only fetcher.

  The workstation gets its own installer:
  ```bash
  bash <(curl -fsSL https://raw.githubusercontent.com/alliphant/hearth/main/ops/agentd/install.sh)
  ```
  Run that on the workstation. It generates an auth token and prints
  pairing instructions for the always-on host.

It runs on Linux out of the box, on macOS first-class, and on Windows
through WSL2.

## Optional integrations (a sample)

Everything below is opt-in. Each connector reports "not configured"
when its credentials are missing instead of erroring. Wire up only
what's useful to you.

| Service | What unlocks |
|---|---|
| **Home Assistant** | Cassandra reads presence and sensors; Iris reads it for the EV; Kate uses it for location-aware briefs |
| **CalDAV** (Fastmail, Nextcloud, iCloud) | Kate's morning brief uses your real calendar |
| **Plex** (via Tautulli) | Maggie's media taste profile |
| **Sonarr / Radarr / Lidarr / Readarr** | Cordelia can add shows, movies, music, books to the household library |
| **UniFi** | Cassandra watches the network |
| **Mealie** | Brigid's recipes and weekly meal plans |
| **MeTube / yt-dlp** | Queue YouTube downloads |
| **OSRM + Nominatim** (local) | Spatial awareness: routing, geocoding, ETAs |
| **Apple Music** ⚠ | Maggie reads your real listening history. **Requires an Apple Developer Program account ($99/yr) to issue the MusicKit token.** That's Apple's gate, not ours. Without it Maggie still works; she just won't see your Apple Music data. |

Every integration lives in its own file under `src/connectors/`.
Adding one of your own is a few hundred lines of TypeScript.

## A guided tour

After install, the most enjoyable way to see what's running is the
architecture tour:

```
http://localhost:7700/app/showcase.html
```

It walks you through the topology, the staff, the daily rhythm, the
tool belt, and the trust ladder, with animated diagrams and sample
briefs. Five-minute skim.

## License

MIT. Take it apart. Fork it. Build your own personas. Wire up the
connectors that matter to your household.

The whole stack is permissively licensed: MIT, Apache-2.0, BSD, ISC.
No copyleft dependencies. Hearth itself ships under MIT. The external
services Hearth talks to (Home Assistant, Mealie, Plex, the *arr
stack, and so on) are each your responsibility to run; Hearth speaks
their REST APIs and nothing more.

What we care about: a small number of people can run a quietly
competent staff for themselves, on hardware they own, without anyone
else's eyes on their journal entries.

If you build something with it, we'd love to hear.

---

**Curious how it works?** [TECHNICAL.md](TECHNICAL.md) has the stack,
the architecture decisions, the substitution layer, the sanitizer,
the security posture.

**Design rationale?** [architecture.md](architecture.md) is the full
why-behind-every-decision document.

**Contributing?** the private dev log has the conventions, the
idioms, and the things that will trip you up.

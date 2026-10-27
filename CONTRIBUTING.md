# Contributing

Thanks for helping. Bug reports, new fault checks and support for more Packet Tracer setups are all welcome.

## Reporting a problem

Open an issue with:

- your Packet Tracer version and operating system,
- what you asked the tutor and what it did,
- the output of the `pt_status` tool, if the bridge is connected.

If the diagnosis is wrong for a lab, attaching the `.pkt` file helps most.

## Changing the code

```bash
npm install
npm test
```

- Keep the tutor read-only: no tool may change the student's network.
- No hint level may contain a configuration command. The tests check this.
- Engine changes need a fixture in `test/fixtures` that shows the fault.

`PROGRESS.md` explains the architecture, the dev setup for the Packet Tracer bridge and the API quirks.
